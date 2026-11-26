"""The running back end: the data server's stand-in and its lifecycle, the importer, the replay controller.

There is no live world here (4.6): the data come from the data folder through the CSV
importer, and time is the replay controller's (docs/v4-interfaces.md §4, §7, §8).

The server **behaves as a stock OpenSensorHub** (§9.1): a start takes about one real second,
during which it answers nothing (the bridge returns no answer and the relay reports a network
failure); its store persists across restarts, and only Reset instance empties it (FR-50a).
The control panel's field toggles are pending until the next start (FR-51).

``tick()`` is called by the host about ten times a real second: in Pyodide by the back-end
worker, under uvicorn by a background task (``serve.py``), in tests by hand.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from . import accounts as A
from . import clock
from . import config as C
from . import swe
from .fields import CATALOGUE, Offering
from .importer import Importer
from .replay import Replay
from .store import URN, Hub, Store, Subscription
from .tap import Tap

SOSA = "http://www.w3.org/ns/sosa/"


def contracts_dir() -> Path:
    here = Path(__file__).resolve().parent
    for cand in (here.parent / "contracts", here.parent.parent / "contracts"):
        if cand.is_dir():
            return cand
    raise FileNotFoundError("contracts directory not found")


class Runtime:
    def __init__(self, folder, real=clock.real, capture: bool = True, hold_s: float = C.COMMAND_HOLD_S,
                 start_s: float = C.START_S, parser=None, silent_import: bool = True):
        self.real = real
        self.folder = folder
        self.tap = Tap(now=real, replay_now=lambda: self.replay.time if self.replay.dataset else None)
        self.tap.enabled = capture
        self.accounts = A.Accounts()
        self.store = Store()
        self.hub = Hub()
        self.offering = Offering()  # what the next start publishes
        self.live_offering = self.offering.copy()
        self.lie_about_profile = False  # a misconfigured server (FR-79a)
        self.live_lie = False
        self.hold_s = hold_s
        self.start_s = start_s
        self.status = "down"  # down | starting | running
        self.ready_at = 0.0
        self.boots = 0
        self.frozen = False
        self._unfrozen: asyncio.Event | None = None
        self.profile = json.loads((contracts_dir() / "profile.json").read_text())
        self.importer = Importer(self, folder, parser)
        self.replay = Replay(self)
        self.silent_import = silent_import  # once per page load (FR-15)
        self.phases: dict[str, dict] = {}  # model -> what it says of itself, for the shell
        self._world = None
        self._boot_task = None

    # --- lifecycle (FR-47, FR-49, FR-50a) ---------------------------------------------------
    async def start(self) -> None:
        """Start the server: it answers nothing until it has started (§9.1)."""
        self.status = "starting"
        self.boots += 1
        self.store.boot = self.boots
        self.ready_at = self.real() + self.start_s
        self.live_offering = self.offering.copy()
        self.live_lie = self.lie_about_profile
        quiet = self.boots == 1  # nothing is drawn before the first login (FR-77)
        self._configure()
        await self.importer.start(quiet=quiet)
        if self.silent_import:
            self.silent_import = False
            await self.importer.silent_import()
        await self.replay.start(quiet=quiet)
        if self.real() >= self.ready_at:
            self.status = "running"

    def begin_start(self):
        """Start without waiting (the host's tick carries it on)."""
        self._boot_task = asyncio.ensure_future(self.start())
        return self._boot_task

    def stop(self) -> None:
        self.status = "down"
        self.hub.close_all()  # every subscription ends (§9.2)
        self.importer.stopped()
        self.replay.stopped()

    def take_down(self) -> None:
        self.stop()

    def restart(self):
        self.stop()
        return self.begin_start()

    def reset_instance(self):
        """Stop, delete the whole store, start empty (FR-50a). The data folder is untouched; the silent
        import does not run again until the page is reloaded."""
        self.stop()
        self.store = Store()
        self.importer.reset()
        self.replay.reset()
        return self.begin_start()

    @property
    def running(self) -> bool:
        return self.status == "running"

    def tick(self) -> None:
        if self.status == "starting" and self.real() >= self.ready_at and (self._boot_task is None or self._boot_task.done()):
            if self._boot_task is not None and self._boot_task.exception() is not None:
                raise self._boot_task.exception()
            self.status = "running"
        if self.running:
            self.replay.tick()

    # --- control actions (§13.3) ------------------------------------------------------------------
    def control(self, action: str, arg=None) -> dict:
        """A control action from the shell; returns the control state. Must be called with the event loop
        running (the worker's, or a test's)."""
        if action == "restart-server":
            self.restart()
        elif action == "down":
            self.take_down()
        elif action == "up":
            if self.status == "down":
                self.begin_start()
        elif action == "field":
            self.set_field(arg["name"], arg["on"])
        elif action == "profile-lie":
            self.lie_about_profile = _on(arg)
        elif action == "capture":
            self.tap.enabled = _on(arg)
        elif action == "freeze":
            self.set_frozen(_on(arg))
        elif action == "reset-instance":
            self.reset_instance()
        elif action == "set-role":
            self.accounts.set_role(arg["user"], arg["role"])
        elif action != "state":
            raise ValueError(f"unknown control action {action}")
        return self.control_state()

    # --- server configuration, created at start (§6) ----------------------------------------
    def _configure(self) -> None:
        st = self.store
        barge, _ = st.add_system(URN + "platform:barge", "Collection platform", "The uncrewed electric cargo barge. "
                                 "It records no position.", feature=SOSA + "Platform", asset="Platform")
        for s, label in (("bow", "Bow sensor"), ("stern", "Stern sensor")):
            sen, _ = st.add_system(f"{URN}sensor:{s}", label, "Seven parameters at 1 Hz.", SOSA + "Sensor",
                                   "Equipment", parent=barge["id"])
            st.add_system(f"{URN}sensor:{s}:co2", f"{s.capitalize()} CO₂ analyser", "CO₂ in ppm at 1 Hz. Restricted.",
                          SOSA + "Sensor", "Equipment", parent=sen["id"], restricted=True)
        st.add_system(URN + "process:models", "Models", "A home for models that turn sensor data into insight. "
                      "Each model is a process system of its own, created by the model itself.", SOSA + "System", "Process")
        for user in A.USERS:
            ws, _ = st.add_system(f"{URN}workspace:{user}", f"Workspace of {user}", "Data of interest, kept per analyst "
                                  "(FR-95).", SOSA + "System", "Other", owner=user, workspace_of=user)
            st.add_datastream(ws["id"], "data-of-interest", "Data of interest", swe.record([
                swe.time_field("time", "Saved at"), swe.text("doi_id", "Data of interest"),
                swe.category("action", "Action", ["save", "remove"]), swe.text("record", "Record (JSON)")],
                "Data of interest"), owner=user)

    # --- freeze (FR-92, §4) ----------------------------------------------------------------------
    def set_frozen(self, on: bool) -> None:
        self.frozen = bool(on)
        ev = self._event()
        if self.frozen:
            ev.clear()
        else:
            ev.set()
        self.replay.frozen(self.frozen)

    def _event(self) -> asyncio.Event:
        if self._unfrozen is None:
            self._unfrozen = asyncio.Event()
            self._unfrozen.set()
        return self._unfrozen

    async def wait_unfrozen(self) -> None:
        if self.frozen:
            await self._event().wait()

    # --- commands: pushed to subscribers, dropped without one (§9.1, §9.2) ----------------------
    def push(self, cs: dict, cmd: dict) -> int:
        subs = self.hub.subscribers(cs["id"])
        for s in subs:
            s.queue.put_nowait(cmd)
        return len(subs)

    async def next_push(self, sub: Subscription) -> dict | None:
        """The next command for a subscriber, captured as it is written to the stream (§9.2)."""
        cmd = await sub.queue.get()
        if cmd is None:
            return None
        await self.wait_unfrozen()
        if sub.closed:
            return None
        cs = self.store.controlstreams.get(sub.cs_id, {})
        self.tap.emit("server", sub.component, "K", f"push {cs.get('inputName', '?')}: {_summary(cmd)}",
                      json.dumps(cmd), model=sub.model, push=True)
        return cmd

    def subscribe_internal(self, cs: dict, user: str) -> Subscription:
        acct = self.accounts.by_user[user]
        return self.hub.subscribe(Subscription(cs["id"], acct, acct.component, None))

    def command_status(self, cmd_id: str, code: str, message: str = "", src: str | None = None, quiet=False) -> None:
        cmd = self.store.commands.get(cmd_id)
        if cmd is None:
            return
        rep = {"id": self.store.ids.next("status"), "command@id": cmd_id, "statusCode": code, "reportTime": _iso_now(self)}
        if message:
            rep["message"] = message
        cmd["status"].append(rep)
        self.store.status_reports.setdefault(cmd["controlstream@id"], []).append(rep)
        if src:
            self.tap.emit(src, "server", "O" if src == "replay" else "I", f"status {code}: {cmd_id}", rep, quiet=quiet)

    # --- the profile and the offering (FR-40, FR-50..52) --------------------------------------
    def satisfies_profile(self) -> bool:
        off = self.live_offering
        return all(off.keep(e["field"]) for e in self.profile["essentials"] if e["field"] in CATALOGUE)

    def claims_profile(self) -> bool:
        return self.live_lie or self.satisfies_profile()

    # --- the referee's ground truth: the data folder's manifest (FR-12) -------------------------
    async def world(self):
        if self._world is None:
            from .truth import World

            m = await self.folder.manifest()
            self._world = World(m["world"])
        return self._world

    # --- the shell (§13) ---------------------------------------------------------------------
    def set_phase(self, model: str, phase: str, detail: str = "", label: str | None = None) -> None:
        cur = self.phases.setdefault(model, {"label": label or model})
        cur.update(phase=phase, detail=detail)
        if label:
            cur["label"] = label

    def set_field(self, name: str, on: bool) -> None:
        if name not in CATALOGUE:
            raise KeyError(name)
        self.offering.on[name] = bool(on)

    def control_state(self) -> dict:
        live = self.live_offering
        rows = []
        for name, f in CATALOGUE.items():
            rows.append({"name": name, "label": f.label, "kind": f.kind, "inputs": list(f.inputs), "extra": f.extra,
                         "essential": f.essential, "type": f.swe_type, "on_next_start": self.offering.on[name],
                         "published_next_start": self.offering.published(name),
                         "published_now": self.status != "down" and live.published(name)})
        pending = any(r["published_now"] != r["published_next_start"] for r in rows) or self.live_lie != self.lie_about_profile
        models_sys = self.store.system_by_uid(URN + "process:models")
        models = []
        if models_sys:
            for s in self.store.systems.values():
                if s["parent"] != models_sys["id"]:
                    continue
                mid = s["uid"].rsplit(":", 1)[-1]
                own = {x["id"] for x in self.store.systems.values() if x["parent"] == s["id"]} | {s["id"]}
                models.append({"id": mid, "label": s["label"], "max_rate": s["characteristics"].get("max_rate"),
                               **{k: v for k, v in self.phases.get(mid, {}).items() if k != "label"},
                               "datastreams": [d["outputName"] for d in self.store.datastreams.values()
                                               if d["system"] in own and not d["replaced"]]})
        return {
            "server": self.status, "fields": rows, "pending": pending, "lie_about_profile": self.lie_about_profile,
            "folder": self.importer.folder_state(), "datasets": self.importer.datasets_state(),
            "replay": self.replay.view(), "models": models, "accounts": self.accounts.state(),
            "capture_counts": self.tap.counts, "backend": "python", "frozen": self.frozen,
            "import_rate": self.importer.rate,
        }


def _iso_now(rt) -> str:
    from .times import iso

    return iso(round(rt.real(), 3))


def _summary(cmd: dict) -> str:
    p = cmd.get("parameters", {})
    return ", ".join(f"{k}={v}" for k, v in p.items() if k != "doi" and v not in ("", None))[:120]


def _on(arg) -> bool:
    """A switch action's argument: {"on": bool} from the shell, or a bare bool (§13.3)."""
    return bool(arg.get("on")) if isinstance(arg, dict) else bool(arg)
