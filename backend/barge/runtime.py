"""The running back end: the world and store, the data server's lifecycle, the models' host.

The world, the clock, the sensors and the logger store run continuously; the
data server is started, restarted, taken down and brought up around them
(FR-18, FR-47, FR-49). The control panel's field toggles are kept here as
*pending* until the next server start (FR-51).

Models run elsewhere: each in its own worker in the browser (FR-33), using the
data server's HTTP interface like any other client (FR-28). In CPython (tests,
an ordinary ASGI server) ``local_models=True`` runs the core models in-process
instead, making the same HTTP requests of the same application.

The CSV importer (``importer.py``) is a module of the data server: it starts with
each server start, and the server answers only once it has registered and listed
the data folder, and, at the first start only, imported Mission A silently (FR-15).
Its work is asynchronous: in Pyodide on the page's event loop, in CPython on an
event loop of the runtime's own, run a little at each ``tick`` (as the in-process
models' is, D-259).

Reset instance (FR-50a) deletes the whole store and starts the server again, empty.
"""
from __future__ import annotations

import asyncio
import atexit

from . import config as C
from .accounts import Accounts
from .clock import SimClock, real_seconds
from .fields import CATALOGUE, Offering
from .folder import DirFolder
from .importer import EmptyFolder, Importer
from .logger import Logger
from .sensors import Sensors
from .server import Server, iso_real
from .store import URN, Hub, Store
from .tap import Tap
from .truth import World
from .world import generate


class Runtime:
    def __init__(self, seed: int = 1, clock=None, pregen_days: float = C.PREGEN_DAYS, capture: bool = True,
                 progress=None, history: dict | None = None, local_models: bool = False,
                 store_format=None, adapter_class=None, real=real_seconds, hold_s: float = C.COMMAND_HOLD_S,
                 folder=None, parser=None, own_loop: bool = True):
        self.seed = seed
        self.real = real  # real time, Unix seconds: commands and status reports are stamped with it (§9.1)
        self.hold_s = hold_s  # how long a command's POST is held before it is answered (§9.1)
        self.manifest = generate(seed)
        self.world = World(self.manifest)
        self.clock = clock if clock is not None else SimClock(start=pregen_days * 86400.0)
        self.tap = Tap(now=self.now)
        self.tap.enabled = capture
        self.logger = Logger()
        # The store's format and the adapter that reads it are a port (SRD §2.2): AT-03 swaps both, and nothing else.
        self.adapter_class = adapter_class
        self.sensors = Sensors(self.world, self.logger, self.tap, **({"fmt": store_format} if store_format else {}))
        self.store = Store()  # created resources and their observations: they outlive restarts (D-11)
        self.accounts = Accounts()  # the server's accounts and user-to-role assignment (§9.3)
        self.hub = Hub()  # push subscriptions (§9.2)
        self.phases: dict[str, dict] = {}  # model -> {label, phase, detail}: what each model says of itself, for the shell
        self.local = None
        self.offering = Offering()  # what the next server start will publish
        self.lie_about_profile = False  # a misconfigured server, for AT-07
        # The data folder (a path, or a Folder); none: an empty folder. The importer is its only reader (FR-20).
        if folder is not None and not hasattr(folder, "list"):
            folder = DirFolder(folder)
        self.importer = Importer(self, folder if folder is not None else EmptyFolder(), parser)
        self.silent_import = True  # Mission A, once per page load: not again after Reset instance (FR-15, FR-50a)
        # CPython: an event loop of the runtime's own, run at each tick. Pyodide: the page's (own_loop=False).
        self.loop = asyncio.new_event_loop() if own_loop else None
        if self.loop is not None:
            atexit.register(self.close)
        self.instance_resets = 0
        self.server: Server | None = None
        self.server_starts = 0
        self.down = False
        self.history_source = "generated"
        if history is not None and self.load_history(history, pregen_days):
            self.history_source = "pre-built"
        else:
            self.pregenerate(pregen_days, progress)
        self.start_server()
        if local_models:
            from .local_models import LocalModels

            self.local = LocalModels(self, loop=self.loop)

    def now(self) -> float:
        return self.clock.now()

    # --- FR-16: four weeks of history, through the same sensor-to-logger path --
    def pregenerate(self, days: float, progress=None) -> None:
        self.tap.recording = False
        end = days * 86400.0
        while self.sensors.next_t < end:
            self.sensors.sample_until(min(end, self.sensors.next_t + 86400))
            if progress:
                progress(self.sensors.next_t / end)
        self.tap.recording = True

    def load_history(self, history: dict, days: float) -> bool:
        """Load pre-built logger files instead of generating them (SRD §13).

        `history` is {"manifest": {...}, "files": {name: bytes}}. Refused, and
        False returned, unless it was made from this seed by this exact code.
        """
        from .history import code_hash

        m = history["manifest"]
        if m.get("seed") != self.seed or m.get("code_hash") != code_hash() or m.get("days") != days:
            return False
        for name in sorted(history["files"]):
            data = history["files"][name]
            self.logger._files[name] = data if isinstance(data, bytearray) else bytearray(data)
        self.sensors.next_t = int(m["end_t"])
        for k, v in m.get("capture_counts", {}).items():
            self.tap.counts[k] = self.tap.counts.get(k, 0) + v
        return True

    # --- the running system ---------------------------------------------------------
    def tick(self) -> None:
        """Bring the store up to the clock; let a starting server rebuild its index and start its modules; step
        local models."""
        if self.clock.playing:
            self.sensors.sample_until(self.clock.now() + 1)
        srv = self.server
        if srv and not self.down:
            if not srv.ready:
                if srv.index_step() and not srv.starting:
                    srv.starting = True
                    self.spawn(self._start_modules(srv))
            else:
                srv.adapter.index_step()  # the adapter's index follows the growing store (FR-21)
        self.run_loop()
        if self.local:
            self.local.tick()

    # --- the server's modules: the CSV importer (§7) ----------------------------------------
    def spawn(self, coro):
        """Run a coroutine on the back end's event loop (the runtime's own in CPython, the page's in Pyodide)."""
        if self.loop is not None:
            return self.loop.create_task(coro)
        return asyncio.ensure_future(coro)

    def run_loop(self, rounds: int = 400) -> None:
        """CPython: let the runtime's own loop run what it has in hand (in Pyodide the page's loop runs by itself)."""
        if self.loop is None or self.loop.is_closed() or self.loop.is_running():
            return
        for _ in range(rounds):
            self.loop.run_until_complete(asyncio.sleep(0))
            if not self.loop._ready:  # noqa: SLF001 - nothing more to do now
                break

    async def _start_modules(self, srv) -> None:
        """After the index: the importer registers and lists the folder, imports Mission A silently at the first
        start of a page load (FR-15), and the server then answers. The importer subscribes once it does."""
        try:
            await self.importer.start()
            if self.silent_import:
                self.silent_import = False
                await self.importer.silent_import()
        except Exception as e:  # noqa: BLE001 - a broken folder never stops the server
            self.tap.emit("importer", "server", "I", f"importer: {type(e).__name__}: {e}", str(e), quiet=True)
        if srv is not self.server or self.down:
            return
        srv.ready = True
        if self.importer.cs is not None:
            await self.importer.listen(srv)

    def close(self) -> None:
        """End the back end's own loop (at exit): its subscriptions end, no task is left pending."""
        loop = self.loop
        if loop is None or loop.is_closed():
            return
        tasks = asyncio.all_tasks(loop)
        for t in tasks:
            t.cancel()
        if tasks:
            loop.run_until_complete(asyncio.gather(*tasks, return_exceptions=True))
        loop.close()

    def startup_phase(self) -> str:
        """For the page's loading steps (§13.7): ``index``, ``import``, ``ready`` (or ``down``)."""
        if self.server is None or self.down:
            return "down"
        return self.server.phase()

    def reset_instance(self) -> None:
        """FR-50a: stop the server, delete its whole store, and start it again empty: no dataset imported, no
        results, no data of interest. Nothing is deleted record by record, and the data folder is untouched.
        Mission A is not imported again until the page is reloaded (FR-15). Identifiers keep counting, so that
        an identifier a client still holds is not found rather than found as something else."""
        self.hub.close_all()
        self.server = None
        self.store = Store(ids=self.store.ids)
        self.importer.reset()
        self.instance_resets += 1
        self.start_server()

    def play(self):
        self.clock.play()

    def pause(self):
        self.clock.pause()

    def set_rate(self, rate):
        self.clock.set_rate(rate)

    # --- server lifecycle (FR-43..FR-46e) ----------------------------------------
    def start_server(self) -> None:
        self.hub.close_all()  # every subscription ends when the server stops (§9.2)
        self.server_starts += 1
        self.down = False
        self.server = Server(self, self.server_starts, self.offering, self.tap)

    def restart_server(self) -> None:
        self.start_server()

    def take_down(self) -> None:
        self.hub.close_all()
        self.down = True
        self.server = None

    @property
    def running(self) -> bool:
        """Answering requests. While starting (the index rebuilt) and while down the server answers nothing."""
        return not self.down and self.server is not None and self.server.ready

    # --- commands: pushed to subscribers (§9.1, §9.2) ----------------------------------
    def push(self, cs: dict, cmd: dict) -> int:
        """Write a command to every subscription to its control stream, at once; captured as it is written."""
        subs = self.hub.subscribers(cs["id"])
        for sub in subs:
            who = sub.account.component if sub.account.component in ("models", "importer") else "client"
            p = ", ".join(f"{k}={v}" for k, v in cmd["parameters"].items())
            self.tap.emit("server", who, "K", f"{sub.model + ': ' if sub.model else ''}push: {p}"[:120], cmd,
                          model=sub.model, push=True)
            sub.put(cmd)
        return len(subs)

    def command_status(self, cmd_id: str, code: str, message: str = "") -> dict:
        cmd = self.store.commands[cmd_id]
        report = {"id": self.store.ids.next("status"), "command@id": cmd_id, "statusCode": code,
                  "reportTime": iso_real(self.real())}
        if message:
            report["message"] = message
        cmd["status"].append(report)
        self.store.status_reports.setdefault(cmd["controlstream@id"], []).append(report)
        return report

    def set_role(self, user: str, role: str) -> None:
        self.accounts.set_role(user, role)

    def bring_up(self) -> None:
        self.start_server()

    def set_phase(self, model: str, phase: str, detail: str = "", label: str | None = None) -> None:
        cur = self.phases.setdefault(model, {"label": label or model})
        cur.update(phase=phase, detail=detail)
        if label:
            cur["label"] = label

    def pending_commands(self) -> dict:
        """Nothing waits for the clock any more: commands are pushed at once (4.7, §9.2). Kept for the 4.1 page."""
        return {}

    def set_field(self, name: str, on: bool) -> None:
        if name not in CATALOGUE:
            raise KeyError(name)
        self.offering.on[name] = bool(on)

    def set_profile_lie(self, on: bool) -> None:
        self.lie_about_profile = bool(on)

    def control_state(self) -> dict:
        """What the control panel and status show (FR-49..FR-52)."""
        live = self.server.offering if self.server else None
        rows = []
        for name, f in CATALOGUE.items():
            rows.append({
                "name": name, "label": f.label, "kind": f.kind, "inputs": list(f.inputs), "extra": f.extra,
                "essential": f.essential, "type": f.swe_type,
                "on_next_start": self.offering.on[name],
                "published_next_start": self.offering.published(name),
                "published_now": bool(live and live.published(name)),
            })
        pending = any(r["published_now"] != r["published_next_start"] for r in rows) or (
            self.server is not None and self.server.lie_about_profile != self.lie_about_profile)
        st = self.store
        home = st.system_by_uid(URN + "process:models")
        models = []
        for sysm in st.systems.values():
            if home is None or sysm["parent"] != home["id"]:
                continue
            mid = sysm["uid"].rsplit(":", 1)[-1]
            mine = {s["id"] for s in st.systems.values() if s["id"] == sysm["id"] or s["parent"] == sysm["id"]}
            models.append({"id": mid, "label": sysm["label"], **self.phases.get(mid, {}),
                           "datastreams": [d["outputName"] for d in st.datastreams.values()
                                           if d["system"] in mine and not d["replaced"]]})
        return {
            "server": "down" if self.down else ("waiting" if not self.server.ready else "running"),
            # The shell's own count of server starts (god's-eye): the server serves no instance identifier (§9.1).
            "instance": f"{self.seed}-{self.server.number}" if self.server else None,
            "progress": self.server.progress() if self.server else None,
            "fields": rows, "pending": pending, "lie_about_profile": self.lie_about_profile,
            "clock": self.clock.state(),
            "store": {"bytes": self.logger.total_bytes(), "files": len(self.logger.list_files()),
                      "records": self.sensors.next_t * 2},
            "capture_counts": self.tap.counts,
            "models": models,
            "accounts": self.accounts.state(),
            "backend": "python",
            "folder": self.importer.folder_state(),
            "datasets": self.importer.datasets_state(),
            "import_rate": self.importer.rate,
            "importer": {"subscribed": self.importer.subscribed, "silent_done": not self.silent_import},
            "resets": self.instance_resets,
        }
