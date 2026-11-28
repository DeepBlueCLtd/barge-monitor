"""The running back end: the data server's lifecycle, its store and its modules, the models' host.

The data server is started, restarted, taken down and brought up (FR-47, FR-49); its store of
resources outlives every start but Reset instance. The control panel's field toggles are kept here
as *pending* until the next server start (FR-50, FR-51). There is no simulation clock, world or
logger: the data arrive as CSV files in the data folder (4.4), replay is each display client's own
(4.7), and the 4.1 remnants are retired (plan Phase 8, D-320).

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

import numpy as np

from . import config as C
from .accounts import Accounts
from .clock import real_seconds
from .fields import CATALOGUE, Offering
from .folder import DirFolder
from .importer import EmptyFolder, Importer
from .server import Server, iso_real
from .store import URN, Hub, Store
from .tap import Tap


class Runtime:
    def __init__(self, capture: bool = True, local_models: bool = False, real=real_seconds,
                 hold_s: float = C.COMMAND_HOLD_S, folder=None, parser=None, own_loop: bool = True):
        self.real = real  # real time, Unix seconds: commands, status reports and captures are stamped with it (§9.1)
        self.hold_s = hold_s  # how long a command's POST is held before it is answered (§9.1)
        self.tap = Tap(now=self.real)
        self.tap.enabled = capture
        self.store = Store()  # created resources and their observations: they outlive restarts (D-11)
        self.accounts = Accounts()  # the server's accounts and user-to-role assignment (§9.3)
        self.hub = Hub()  # push subscriptions (§9.2)
        self.phases: dict[str, dict] = {}  # model -> {label, phase, detail}: what each model says of itself, for the shell
        self.local = None
        self.offering = Offering()  # what the next server start will publish
        self.lie_about_profile = False  # a misconfigured server (FR-79a, D-210)
        # The data folder (a path, or a Folder); none: an empty folder. The importer is its only reader (FR-20).
        if folder is not None and not hasattr(folder, "list"):
            folder = DirFolder(folder)
        self.importer = Importer(self, folder if folder is not None else EmptyFolder(), parser)
        self.silent_import = True  # Mission A, once per page load: not again after Reset instance (FR-15, FR-50a)
        # The demonstrator's system hold (D-362): while held, the importer stops at its next step and pushed commands
        # wait in the server; let go, each carries on where it stopped. Scaffolding: a developed system has none.
        self.held = False
        self._held_waiters: list = []
        # CPython: an event loop of the runtime's own, run at each tick. Pyodide: the page's (own_loop=False).
        self.loop = asyncio.new_event_loop() if own_loop else None
        if self.loop is not None:
            atexit.register(self.close)
        self.instance_resets = 0
        self.server: Server | None = None
        self.server_starts = 0
        self.down = False
        self.start_server()
        if local_models:
            from .local_models import LocalModels

            self.local = LocalModels(self, loop=self.loop)

    def now(self) -> float:
        """Real time, Unix seconds (there is no simulated time any more)."""
        return self.real()

    # --- the demonstrator's system hold (D-362) ------------------------------------------
    def set_held(self, on) -> None:
        """Hold the system (the page's Pause, or slow motion's back-pressure), or let it go on."""
        self.held = bool(on)
        if not self.held:
            waiters, self._held_waiters = self._held_waiters, []
            for f in waiters:
                if not f.done():
                    f.set_result(None)

    async def wait_released(self) -> None:
        """Return at once unless the system is held; else when it is let go."""
        while self.held:
            f = asyncio.get_running_loop().create_future()
            self._held_waiters.append(f)
            await f

    # --- the running system ---------------------------------------------------------
    def tick(self) -> None:
        """Let a starting server start its modules (the CSV importer); run the back end's loop; step local models."""
        srv = self.server
        if srv and not self.down and not srv.ready and not srv.starting:
            srv.starting = True
            self.spawn(self._start_modules(srv))
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
        """At each start: the importer registers and lists the folder, imports Mission A silently at the first
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
        """For the page's loading steps (§13.7): ``import`` while starting, then ``ready`` (or ``down``)."""
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
        """Answering requests. While starting (its modules starting) and while down the server answers nothing."""
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

    def set_field(self, name: str, on: bool) -> None:
        if name not in CATALOGUE:
            raise KeyError(name)
        self.offering.on[name] = bool(on)

    def set_profile_lie(self, on: bool) -> None:
        self.lie_about_profile = bool(on)

    def _runs(self, systems: set) -> list[dict]:
        """A model's runs (FR-35b, interfaces §13.4), god's-eye: the latest entry of each run in its runs logs, the
        restricted one included, as {dataset, run_id, status, pct}."""
        out: dict[str, dict] = {}
        for d in self.store.datastreams.values():
            if d["system"] not in systems or d["replaced"] or not d["outputName"].startswith("runs__"):
                continue
            ser = d["series"]
            n = len(ser)
            if not n or "run_id" not in ser.cols:
                continue
            cols = ser.take(np.arange(n), ["run_id", "status", "pct"])
            for run, status, pct in zip(cols["run_id"], cols.get("status", [None] * n), cols.get("pct", [np.nan] * n)):
                out[str(run)] = {"dataset": d["outputName"][len("runs__"):], "run_id": str(run), "status": status,
                                 "pct": None if pct is None or pct != pct else float(pct)}
        return list(out.values())

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
                                           if d["system"] in mine and not d["replaced"]],
                           "runs": self._runs(mine)})
        return {
            "server": "down" if self.down else ("waiting" if not self.server.ready else "running"),
            # The shell's own count of server starts (god's-eye): the server serves no instance identifier (§9.1).
            "instance": str(self.server.number) if self.server else None,
            "fields": rows, "pending": pending, "lie_about_profile": self.lie_about_profile,
            "capture_counts": self.tap.counts,
            "capture": self.tap.enabled,
            "models": models,
            "accounts": self.accounts.state(),
            "backend": "python",
            "folder": self.importer.folder_state(),
            "datasets": self.importer.datasets_state(),
            "import_rate": self.importer.rate,
            "importer": {"subscribed": self.importer.subscribed, "silent_done": not self.silent_import},
            "resets": self.instance_resets,
        }
