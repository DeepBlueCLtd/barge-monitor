"""The replay controller (C-09, FR-84 to FR-89, FR-91; docs/v4-interfaces.md §8).

It holds the current dataset and the replay clock, and takes ``load``, ``play``, ``pause`` and
``seek`` only as commands pushed on its ``replay`` control stream (C4): it subscribes before
it declares itself ready, and validates every command itself, answering ``REJECTED`` with
the bound it breaks (a rate above the slowest model's, AT-35; a dataset not imported).

Its ``state`` datastream gets one observation per real second while playing and one on every
change; its ``log`` records every command applied. A ``load`` and every ``seek`` start a new
replay run ``r-<dataset>-<n>``, which the models tag their results with (FR-87). At the end of
the dataset it pauses and says so (FR-88).

Real time paces the replay clock (``rate`` replay seconds per real second); Freeze stops it.
It runs inside the server under ``svc-replay``; its traffic is captured as §2 says.
"""
from __future__ import annotations

import asyncio

from . import config as C
from . import swe
from .store import URN
from .times import iso, parse_iso

UID = URN + "replay"
ACTIONS = ("load", "play", "pause", "seek")


def state_schema() -> dict:
    return swe.record([
        swe.time_field("time", "Replay time"), swe.text("dataset", "Dataset"), swe.time_value("start", "Start"),
        swe.time_value("end", "End"), swe.time_value("position", "Position"),
        swe.quantity("rate", "Rate", "1"), swe.quantity("max_rate", "Highest rate the models sustain", "1"),
        swe.text("max_rate_model", "The model that sets it"), swe.boolean("playing", "Playing"),
        swe.boolean("at_end", "At the end of the dataset"), swe.text("run", "Replay run"),
        swe.boolean("models_ready", "Every model has its datastreams for the dataset")], "Replay state")


def log_schema() -> dict:
    return swe.record([
        swe.time_field("time", "Replay time it took effect"), swe.text("command_id", "Command"),
        swe.category("action", "Action", list(ACTIONS) + ["models-ready"]), swe.text("dataset", "Dataset"),
        swe.quantity("rate", "Rate", "1"), swe.time_value("position", "Position"), swe.text("run", "Replay run"),
        swe.text("sender", "Sent by"), swe.text("note", "Note")], "Replay log")


def control_schema() -> dict:
    return swe.record([
        swe.category("action", "Action", ACTIONS), swe.text("dataset", "Dataset (an imported dataset id)"),
        {**swe.quantity("rate", "Rate", "1"), "constraint": {"type": "AllowedTokens", "values": C.RATES}},
        swe.time_value("position", "Position (within the current dataset)")], "Replay")


class Rejected(Exception):
    pass


class Replay:
    def __init__(self, rt):
        self.rt = rt
        self.reset()

    def reset(self) -> None:
        self.dataset: dict | None = None
        self.time: float | None = None
        self.rate = 1.0
        self.playing = False
        self.at_end = False
        self.run = ""
        self.runs: dict[str, int] = {}
        self.models_ready = False
        self.ready_since = 0.0
        self.ready_checked = -1e18
        self.ready_quiet = False
        self.first_seen = {}
        self.skipped = set()
        self.last_real = None
        self.last_state = -1e18
        self.is_frozen = False
        self.system = self.state_ds = self.log_ds = self.cs = None
        self.sub = None
        self.latest: dict | None = None
        self.loaded_once = False

    def stopped(self) -> None:
        self.sub = None

    def frozen(self, on: bool) -> None:
        self.is_frozen = on
        self.last_real = self.rt.real()

    # --- registration (at server start) -------------------------------------------------------
    async def start(self, quiet: bool) -> None:
        st = self.rt.store
        self.system, _ = st.add_system(UID, "Replay controller", "Holds the current dataset and the replay clock; "
                                       "takes load, play, pause and seek as commands.",
                                       "http://www.w3.org/ns/sosa/System", "Simulation", owner="svc-replay")
        sid = self.system["id"]
        self.state_ds, _ = st.add_datastream(sid, "state", "Replay state", state_schema(), owner="svc-replay")
        self.log_ds, _ = st.add_datastream(sid, "log", "Replay log", log_schema(), owner="svc-replay")
        self.cs, _ = st.add_controlstream(sid, "replay", "Replay", control_schema(), owner="svc-replay")
        self.rt.tap.emit("replay", "server", "Q", "register: system, state, log and the replay control stream",
                         {"uniqueId": UID, "datastreams": ["state", "log"], "controlstreams": ["replay"]}, quiet=quiet)
        self.sub = self.rt.subscribe_internal(self.cs, "svc-replay")  # subscribed before it is ready (FR-27)
        asyncio.ensure_future(self._listen(self.sub))
        self.last_real = self.rt.real()
        if not self.loaded_once:
            a = next((d for d in self.rt.importer.datasets.values() if d["file"].startswith("MISSION_A_")), None)
            if a is not None:  # paused at the start of Mission A before the first login (FR-77): quiet
                self._load(a, quiet=True)
                self._log("", "load", "svc-replay", quiet=True)
                self.loaded_once = True
        elif self.dataset is not None:
            self.publish(quiet=quiet)

    async def _listen(self, sub) -> None:
        while True:
            cmd = await self.rt.next_push(sub)
            if cmd is None:
                return
            self._handle(cmd)

    # --- the bound (FR-86, FR-37a) --------------------------------------------------------------
    def bound(self) -> tuple[float, str]:
        st = self.rt.store
        models = st.system_by_uid(URN + "process:models")
        rates = [(float(s["characteristics"]["max_rate"]), s["label"]) for s in st.system_list()
                 if models and s["parent"] == models["id"] and s["characteristics"].get("max_rate") is not None]
        return min(rates) if rates else (max(C.RATES), "")

    # --- commands --------------------------------------------------------------------------------
    def _handle(self, cmd: dict) -> None:
        cid, p = cmd["id"], cmd.get("parameters", {})
        sender = cmd.get("sender", "")
        status = lambda code, msg="": self.rt.command_status(cid, code, msg, src="replay")  # noqa: E731
        try:
            action = p.get("action")
            if action not in ACTIONS:
                raise Rejected(f"action {action!r} is not one of {', '.join(ACTIONS)}")
            try:
                rate = float(p.get("rate"))
            except (TypeError, ValueError):
                raise Rejected(f"rate {p.get('rate')!r} is not a number")
            if not any(abs(rate - r) < 1e-9 for r in C.RATES):
                raise Rejected(f"rate {rate:g} is not one of {', '.join(f'{r:g}' for r in C.RATES)}")
            bound, model = self.bound()
            if rate > bound + 1e-9:
                raise Rejected(f"rate {rate:g} exceeds {bound:g}, the highest {model} sustains")
            if action == "load":
                ds = self.rt.importer.datasets.get(str(p.get("dataset") or ""))
                if ds is None:
                    raise Rejected(f"dataset {p.get('dataset')!r} is not imported")
            elif self.dataset is None:
                raise Rejected("no dataset is loaded")
            position = None
            if action == "seek":
                try:
                    position = parse_iso(str(p.get("position")))
                except ValueError:
                    raise Rejected(f"position {p.get('position')!r} is not an ISO 8601 time")
                if not self.dataset["start"] <= position <= self.dataset["end"]:
                    raise Rejected(f"position {p.get('position')} is outside {self.dataset['id']} "
                                   f"({iso(self.dataset['start'])} to {iso(self.dataset['end'])})")
        except Rejected as e:
            status("REJECTED", str(e))
            return
        status("ACCEPTED")
        self.rate = rate
        if action == "load":
            self._load(ds)
        elif action == "play":
            if self.at_end:  # play at the end starts the dataset again, as a new run
                self._seek(self.dataset["start"])
            self.playing = True
        elif action == "pause":
            self.playing = False
        else:
            self._seek(position)
        self.last_real = self.rt.real()
        self._log(cid, action, sender)
        self.publish()
        status("COMPLETED", f"{action}: {self.dataset['id']} at {iso(self.time)}, run {self.run}")

    def _new_run(self) -> None:
        n = self.runs.get(self.dataset["id"], 0) + 1
        self.runs[self.dataset["id"]] = n
        self.run = f"r-{self.dataset['id']}-{n}"

    def _load(self, ds: dict, quiet: bool = False) -> None:
        self.dataset = ds
        self.time = ds["start"]
        self.playing = False
        self.at_end = False
        self._new_run()
        self.models_ready = False
        self.ready_since = self.rt.real()
        self.ready_checked = -1e18
        self.ready_quiet = quiet
        self.first_seen: dict[str, float] = {}
        self.skipped: set[str] = set()
        self.publish(quiet=quiet)

    def _seek(self, position: float) -> None:
        self.time = position
        self.at_end = position >= self.dataset["end"]
        self._new_run()

    def _log(self, cid: str, action: str, sender: str, note: str = "", quiet: bool = False) -> None:
        row = {"command_id": cid, "action": action, "dataset": self.dataset["id"] if self.dataset else "",
               "rate": self.rate, "position": self.time, "run": self.run, "sender": sender, "note": note}
        self.rt.store.append_row(self.log_ds, self.time, round(self.rt.real(), 3), row)
        self.rt.tap.emit("replay", "server", "O", f"log: {action} {row['dataset']}" + (f" ({note})" if note else ""),
                         dict(row, time=iso(self.time), position=iso(self.time)), quiet=quiet)

    # --- state (§8) --------------------------------------------------------------------------------
    def state(self) -> dict | None:
        if self.dataset is None:
            return None
        bound, model = self.bound()
        return {"time": iso(self.time), "dataset": self.dataset["id"], "start": iso(self.dataset["start"]),
                "end": iso(self.dataset["end"]), "position": iso(self.time), "rate": self.rate, "max_rate": bound,
                "max_rate_model": model, "playing": self.playing, "at_end": self.at_end, "run": self.run,
                "models_ready": self.models_ready}

    def publish(self, quiet: bool = False) -> None:
        if self.dataset is None or self.state_ds is None:
            return
        s = self.state()
        row = dict(s, start=self.dataset["start"], end=self.dataset["end"], position=self.time)
        row.pop("time")
        now = self.rt.real()
        self.rt.store.append_row(self.state_ds, self.time, round(now, 3), row)
        self.last_state = now
        self.latest = s
        self.rt.tap.emit("replay", "server", "O", f"state: {s['dataset']} {s['time']} "
                         f"{'playing' if s['playing'] else 'paused'} ×{s['rate']:g}", s, quiet=quiet)

    def tick(self) -> None:
        if self.dataset is None or self.state_ds is None:
            return
        now = self.rt.real()
        last = self.last_real if self.last_real is not None else now
        self.last_real = now
        if self.playing and not self.is_frozen:
            self.time = min(self.dataset["end"], self.time + self.rate * max(0.0, now - last))
            if self.time >= self.dataset["end"]:
                self.playing = False
                self.at_end = True
                self.publish()
            elif now - self.last_state >= C.STATE_EVERY_S - 1e-9:
                self.publish()
        if not self.is_frozen and now - self.ready_checked >= 1.0:
            self.ready_checked = now
            self._check_models(now)

    def _check_models(self, now: float) -> None:
        """Models ready (§8): every model under Models has a datastream for the dataset. Checked once per real
        second while a dataset is loaded, so a model that registers later is waited for too; a model not ready
        10 real seconds after it was first seen (or after the load) is skipped and named in the log."""
        st, tap, q = self.rt.store, self.rt.tap, self.ready_quiet
        models = st.system_by_uid(URN + "process:models")
        if models is None:
            return
        if not self.models_ready:  # once ready it keeps watching for a model that registers later, undrawn
            tap.emit("replay", "server", "Q", f"GET /systems/{models['id']}/subsystems",
                     f"GET /systems/{models['id']}/subsystems\nAuthorization: Basic ****", quiet=q)
            tap.emit("replay", "server", "Q", "GET /datastreams",
                     "GET /datastreams?limit=10000\nAuthorization: Basic ****", quiet=q)
        suffix = "__" + self.dataset["id"]
        waiting, seen = [], 0
        for m in st.system_list():
            if m["parent"] != models["id"]:
                continue
            seen += 1
            own = {m["id"]} | {s["id"] for s in st.system_list() if s["parent"] == m["id"]}
            if any(d["system"] in own and d["outputName"].endswith(suffix) for d in st.datastreams.values()):
                continue
            first = self.first_seen.setdefault(m["id"], now)
            if now - max(first, self.ready_since) < C.MODEL_READY_TIMEOUT_S:
                waiting.append(m["label"])
            elif m["id"] not in self.skipped:
                self.skipped.add(m["id"])
                self._log("", "models-ready", "svc-replay", note=f"skipped {m['label']}: not ready after "
                          f"{C.MODEL_READY_TIMEOUT_S:g} s", quiet=q)
        ready = not waiting and (seen > 0 or now - self.ready_since >= C.MODEL_READY_TIMEOUT_S)
        if ready != self.models_ready:
            self.models_ready = ready
            self.publish(quiet=self.ready_quiet)
