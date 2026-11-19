"""Sensors (B-C04): bow and stern, sampling the world at 1 Hz.

Each sensor adds declared noise and occasional spikes from its own named
stream (FR-09, FR-12) and writes to the logger stand-in, the only thing it
knows about storage.
"""
from __future__ import annotations

import numpy as np

from . import logger as L
from .truth import World
from .world import PARAMS, lonlat_to_local, _local_to_lonlat  # noqa: F401

SENSORS = ["bow", "stern"]
GPS_SIGMA_M = 1.5
ANTENNA_HEIGHT_M = 1.5


class Sensors:
    def __init__(self, world: World, logger: L.Logger):
        self.w = world
        self.logger = logger
        m = world.m
        self.sigma = m["noise"]["sigma"]
        self.p_spike = m["noise"]["spike_probability"]
        self.spike_scale = m["noise"]["spike_scale"]
        self.rng = {s: np.random.default_rng(m["seeds"]["streams"][f"noise-{s}"]) for s in SENSORS}
        self.next_t = 0  # next whole simulated second to sample
        self._last_file = {}

    def sample_until(self, t_end: float) -> int:
        """Sample every whole second up to but not including t_end."""
        t_end = int(np.floor(t_end))
        if t_end <= self.next_t:
            return 0
        n_total = 0
        # Chunk so a long catch-up does not allocate too much at once.
        while self.next_t < t_end:
            stop = min(t_end, self.next_t + 3600)
            t = np.arange(self.next_t, stop, dtype=float)
            for s in SENSORS:
                self._write(s, t)
            n_total += len(t)
            self.next_t = stop
        return n_total

    def _write(self, sensor: str, t: np.ndarray) -> None:
        tr = self.w.sensor_truth(t, sensor)
        rng = self.rng[sensor]
        n = len(t)
        vals = {}
        for p in PARAMS:
            x = tr[p] + rng.normal(0.0, self.sigma[p], n)
            spikes = rng.random(n) < self.p_spike
            if spikes.any():
                mag = rng.uniform(*self.spike_scale, spikes.sum()) * self.sigma[p]
                x[spikes] += mag * rng.choice([-1.0, 1.0], spikes.sum())
            vals[p] = x
        vals["relative_humidity"] = np.clip(vals["relative_humidity"], 0, 100)
        vals["solar_irradiance"] = np.clip(vals["solar_irradiance"], 0, None)
        vals["apparent_wind_speed"] = np.clip(vals["apparent_wind_speed"], 0, None)
        vals["apparent_wind_direction"] = vals["apparent_wind_direction"] % 360.0
        gx = tr["x"] + rng.normal(0.0, GPS_SIGMA_M, n)
        gy = tr["y"] + rng.normal(0.0, GPS_SIGMA_M, n)
        lon, lat = _local_to_lonlat(gx, gy)
        alt = tr["boat"]["elevation"] + ANTENNA_HEIGHT_M
        no_fix = tr["in_tunnel"]
        lines: dict[str, list[str]] = {}
        for i in range(n):
            name = L.file_name(sensor, t[i])
            rec = L.format_record(
                t[i],
                None if no_fix[i] else float(lat[i]),
                None if no_fix[i] else float(lon[i]),
                float(alt[i]),
                {p: float(vals[p][i]) for p in PARAMS},
            )
            lines.setdefault(name, []).append(rec)
        for name, recs in lines.items():
            prev = self._last_file.get(sensor)
            if prev and prev != name:
                # Day rollover: the old file is complete.
                self.logger.close(prev)
            self.logger.append(name, "".join(recs).encode("ascii"))
            self._last_file[sensor] = name
