"""Sensors (B-C04): bow and stern, sampling the world at 1 Hz.

Each sensor adds declared noise and occasional spikes from its own named
stream (FR-12, FR-15) and writes fixed-width records to the logger store, the
only thing it knows about storage. Position is used to *generate* conditions
and is never recorded (FR-10).
"""
from __future__ import annotations

import numpy as np

from . import logger as L
from .tap import NULL, Tap
from .truth import World
from .world import PARAMS

SENSORS = ["bow", "stern"]
CHUNK_S = 3600


class Sensors:
    def __init__(self, world: World, logger: L.Logger, tap: Tap = NULL):
        self.w = world
        self.logger = logger
        self.tap = tap
        m = world.m
        self.sigma = m["noise"]["sigma"]
        self.p_spike = m["noise"]["spike_probability"]
        self.spike_scale = m["noise"]["spike_scale"]
        self.rng = {s: np.random.default_rng(m["seeds"]["streams"][f"noise-{s}"]) for s in SENSORS}
        self.next_t = 0
        self._last_file: dict[str, str] = {}

    def sample_until(self, t_end: float) -> int:
        """Sample every whole second up to but not including t_end."""
        t_end = int(np.floor(t_end))
        n_total = 0
        while self.next_t < t_end:
            # Never let a chunk straddle midnight: one file per day.
            day_end = (self.next_t // 86400 + 1) * 86400
            stop = min(t_end, self.next_t + CHUNK_S, day_end)
            t = np.arange(self.next_t, stop, dtype=float)
            if self.tap.recording and self.tap.enabled:
                for tt in t:
                    self._announce(tt)
            for s in SENSORS:
                self._write(s, t)
            n_total += len(t)
            self.next_t = stop
        return n_total

    def _announce(self, t: float) -> None:
        b = self.w.boat(np.array([t]))
        self.tap.emit("clock", "barge", "I", f"tick {int(t)}", {"t": t})
        self.tap.emit("barge", "sensors", "I", "barge state for sampling",
                      {"t": t, "chainage_m": round(float(b["chainage"][0]), 1),
                       "speed_ms": round(float(b["speed"][0]), 2), "note": "simulated only; never recorded"})
        self.tap.emit("world", "sensors", "I", "conditions at bow and stern", {"t": t})

    def _write(self, sensor: str, t: np.ndarray) -> None:
        tr = self.w.sensor_truth(t, sensor)
        rng = self.rng[sensor]
        n = len(t)
        vals = {}
        for p in PARAMS:
            x = tr[p] + rng.normal(0.0, self.sigma[p], n)
            spikes = rng.random(n) < self.p_spike
            if spikes.any():
                k = int(spikes.sum())
                x[spikes] += rng.uniform(*self.spike_scale, k) * self.sigma[p] * rng.choice([-1.0, 1.0], k)
            vals[p] = x
        vals["relative_humidity"] = np.clip(vals["relative_humidity"], 0, 100)
        vals["solar_irradiance"] = np.clip(vals["solar_irradiance"], 0, None)
        vals["apparent_wind_speed"] = np.clip(vals["apparent_wind_speed"], 0, None)
        vals["apparent_wind_direction"] = vals["apparent_wind_direction"] % 360.0
        vals["precipitation_type"] = tr["precipitation_type"]
        data = L.format_records(t, vals)
        name = L.file_name(sensor, t[0])
        prev = self._last_file.get(sensor)
        if prev and prev != name:
            self.logger.close(prev)
        self.logger.append(name, data)
        self._last_file[sensor] = name
        if self.tap.recording and self.tap.enabled:
            for i in range(n):
                rec = data[i * L.REC_LEN:(i + 1) * L.REC_LEN].decode("ascii")
                self.tap.emit("sensors", "logger", "L", f"{sensor} record to {name}", rec)
        else:
            self.tap.count("sensors", "logger", "L", n)
