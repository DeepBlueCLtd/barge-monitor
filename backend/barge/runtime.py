"""The running backend: the simulated world and store, and the server's lifecycle.

The world, the clock, the sensors and the logger store run continuously; the
Connected Systems server is started, restarted, taken down and brought up
around them (FR-20, FR-43, FR-46a). The control panel's field toggles are kept
here as *pending* until the next server start (FR-46d).
"""
from __future__ import annotations

from . import config as C
from .clock import SimClock
from .fields import CATALOGUE, Offering
from .logger import Logger
from .sensors import Sensors
from .server import Registry, Server
from .tap import Tap
from .truth import World
from .world import generate


class Runtime:
    def __init__(self, seed: int = 1, clock=None, pregen_days: float = C.PREGEN_DAYS, capture: bool = True,
                 progress=None, history: dict | None = None):
        self.seed = seed
        self.manifest = generate(seed)
        self.world = World(self.manifest)
        self.clock = clock if clock is not None else SimClock(start=pregen_days * 86400.0)
        self.tap = Tap(now=self.now)
        self.tap.enabled = capture
        self.logger = Logger()
        self.sensors = Sensors(self.world, self.logger, self.tap)
        self.registry = Registry()
        self.offering = Offering()  # what the next server start will publish
        self.lie_about_profile = False  # a misconfigured server, for AT-07
        self.server: Server | None = None
        self.server_starts = 0
        self.down = False
        self.history_source = "generated"
        if history is not None and self.load_history(history, pregen_days):
            self.history_source = "pre-built"
        else:
            self.pregenerate(pregen_days, progress)
        self.start_server()

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
        """Bring the store up to the clock; let a starting server rebuild its index."""
        if self.clock.playing:
            self.sensors.sample_until(self.clock.now() + 1)
        if self.server and not self.down and not self.server.ready:
            self.server.index_step()

    def play(self):
        self.tap.emit("shell", "clock", "I", "play", {"rate": self.clock.rate})
        self.clock.play()

    def pause(self):
        self.tap.emit("shell", "clock", "I", "pause", {})
        self.clock.pause()

    def set_rate(self, rate):
        self.clock.set_rate(rate)
        self.tap.emit("shell", "clock", "I", f"rate {rate}×", {"rate": rate})

    # --- server lifecycle (FR-43..FR-46e) ----------------------------------------
    def start_server(self) -> None:
        self.server_starts += 1
        self.down = False
        self.server = Server(self, self.server_starts, self.offering, self.tap)

    def restart_server(self) -> None:
        self.tap.emit("shell", "server", "I", "restart server", {"instance": self.server.instance if self.server else None})
        self.start_server()

    def take_down(self) -> None:
        self.tap.emit("shell", "server", "I", "take server down", {})
        self.down = True
        self.server = None

    def bring_up(self) -> None:
        self.tap.emit("shell", "server", "I", "bring server up", {})
        self.start_server()

    def set_field(self, name: str, on: bool) -> None:
        if name not in CATALOGUE:
            raise KeyError(name)
        self.offering.on[name] = bool(on)
        self.tap.emit("shell", "server", "I", f"field {name} {'on' if on else 'off'} (pending)", {"field": name, "on": on})

    def set_profile_lie(self, on: bool) -> None:
        self.lie_about_profile = bool(on)

    def control_state(self) -> dict:
        """What the control panel shows (FR-46e)."""
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
        return {
            "server": "down" if self.down else ("waiting" if not self.server.ready else "running"),
            "instance": self.server.instance if self.server else None,
            "progress": self.server.progress() if self.server else None,
            "fields": rows, "pending": pending, "lie_about_profile": self.lie_about_profile,
            "clock": self.clock.state(),
            "store": {"bytes": self.logger.total_bytes(), "files": len(self.logger.list_files()),
                      "records": self.sensors.next_t * 2},
            "capture_counts": self.tap.counts,
        }
