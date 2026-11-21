"""Sensors, part of the collection platform (C-01): bow and stern, sampling the world at 1 Hz.

Each sensor adds declared noise and occasional spikes from its own named
stream (FR-11, FR-14) and writes fixed-width records to the logger store, the
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
        self.seeds = {s: m["seeds"]["streams"][f"noise-{s}"] for s in SENSORS}
        self._block: dict[str, tuple] = {}
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
            for s in SENSORS:
                self._write(s, t)
            n_total += len(t)
            self.next_t = stop
        return n_total

    def _noise(self, sensor: str, t: np.ndarray) -> dict:
        """Noise and spikes for whole seconds t, drawn in hour-aligned blocks.

        Each block comes from the sensor's named stream keyed by the block's
        number, so a reading never depends on how time was chunked: pausing
        and resuming gives the same readings as running straight through.
        """
        out = {p: np.empty(len(t)) for p in PARAMS}
        blocks = (t // CHUNK_S).astype(int)
        for b in np.unique(blocks):
            cached = self._block.get(sensor)
            if not cached or cached[0] != b:
                rng = np.random.default_rng([self.seeds[sensor], int(b)])
                arr = {}
                for p in PARAMS:
                    x = rng.normal(0.0, self.sigma[p], CHUNK_S)
                    spikes = rng.random(CHUNK_S) < self.p_spike
                    mag = rng.uniform(*self.spike_scale, CHUNK_S) * self.sigma[p] * rng.choice([-1.0, 1.0], CHUNK_S)
                    arr[p] = x + np.where(spikes, mag, 0.0)
                cached = self._block[sensor] = (b, arr)
            sel = blocks == b
            idx = (t[sel] - b * CHUNK_S).astype(int)
            for p in PARAMS:
                out[p][sel] = cached[1][p][idx]
        return out

    def _write(self, sensor: str, t: np.ndarray) -> None:
        tr = self.w.sensor_truth(t, sensor)
        n = len(t)
        noise = self._noise(sensor, t)
        vals = {p: tr[p] + noise[p] for p in PARAMS}
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
                self.tap.emit("platform", "store", "L", f"{sensor} record to {name}", rec)
        else:
            self.tap.count("platform", "store", "L", n)
