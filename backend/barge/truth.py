"""Ground truth as pure functions of the manifest, time and place.

The boat (B-C03) and the weather are both computed here, vectorised over
time. Nothing here reads a clock or draws a random number: the same inputs
always give the same outputs, which is what lets analysis be scored.
"""
from __future__ import annotations

import math
from functools import lru_cache

import numpy as np

from . import config as C

KIND_CODES = {"move": 0, "lock": 1, "dwell": 2, "stoppage": 3}
_MASS_PROPS = ["T", "RH", "P", "wind", "wind_from", "clear", "water"]
_SD_PROPS = ["T", "RH", "P", "wind", "wind_from", "clear"]


class World:
    """Pre-computed arrays for fast vectorised truth lookups."""

    def __init__(self, manifest: dict):
        self.m = manifest
        cl = manifest["canal"]["centreline"]
        self.cx = np.asarray(cl["x"])
        self.cy = np.asarray(cl["y"])
        self.cchain = np.asarray(cl["chainage"])
        self.length = manifest["canal"]["length_m"]
        segs = manifest["voyage"]["segments"]
        self.t0 = np.array([s[0] for s in segs])
        self.t1 = np.array([s[1] for s in segs])
        self.s0 = np.array([s[2] for s in segs])
        self.s1 = np.array([s[3] for s in segs])
        self.kind = np.array([KIND_CODES[s[4]] for s in segs])
        self.place = [s[5] for s in segs]
        # Direction the bow points in each segment.
        d = np.sign(self.s1 - self.s0)
        dirs = np.zeros(len(segs))
        last = 1.0
        for i in range(len(segs)):
            if d[i] != 0:
                last = d[i]
            dirs[i] = last
        # Dwell: the boat has turned for the next leg.
        for i in range(len(segs)):
            if self.kind[i] == KIND_CODES["dwell"]:
                nxt = next((d[j] for j in range(i + 1, len(segs)) if d[j] != 0), dirs[i])
                dirs[i] = nxt
        self.dir = dirs
        self.half = manifest["boat"]["sensor_separation_m"] / 2.0
        locks = manifest["canal"]["locks"]
        self.lock_s = np.array([lk["chainage"] for lk in locks])
        self.lock_rise = np.array([lk["rise_m"] for lk in locks])
        self.north_level = manifest["canal"]["north_level_m"]
        reaches = manifest["canal"]["reaches"]
        self.r_start = np.array([r["start"] for r in reaches])
        self.r_end = np.array([r["end"] for r in reaches])
        self.r_eff = {k: np.array([r["effects"][k] for r in reaches]) for k in ("dT", "dRH", "dWater", "wind", "solar")}
        self.r_width = manifest["canal"]["reach_transition_m"]
        masses = manifest["air_masses"]
        self.mass_ids = [m["id"] for m in masses]
        self.mprop = {p: np.array([m[p] for m in masses]) for p in _MASS_PROPS}
        self.msd = {p: np.array([m["sd"][p] for m in masses]) for p in _SD_PROPS}
        w = manifest["weather"]
        self.seq = np.array([self.mass_ids.index(i) for i in w["mass_sequence"]])
        self.f_arr = np.array([f["arrival"] for f in w["fronts"]])
        self.f_dur = np.array([f["duration"] for f in w["fronts"]])
        self.f_dip = np.array([f["pressure_dip_hpa"] for f in w["fronts"]])
        self.f_boost = np.array([f["wind_boost"] for f in w["fronts"]])
        an = w["anomaly"]
        self.a_per = np.asarray(an["periods_s"])
        self.a_amp = np.asarray(an["amplitudes"])
        self.a_ph = np.asarray(an["phases"])
        self.g_per = np.asarray(an["gust_periods_s"])
        self.g_ph = np.asarray(an["gust_phases"])
        self.g_frac = an["gust_fraction"]
        self.chol = np.linalg.cholesky(np.asarray(manifest["anomaly_correlation"]))
        self.diurnal = manifest["diurnal"]
        self.lapse = manifest["pressure_lapse_hpa_per_m"]
        self.solar_offset_s = manifest["origin"]["lon"] / 15.0 * 3600.0

    # --- geometry -----------------------------------------------------------
    def xy_at(self, s):
        """Position at chainage s; beyond either end, along the end segment (the basins)."""
        s = np.asarray(s, dtype=float)
        x = np.interp(s, self.cchain, self.cx)
        y = np.interp(s, self.cchain, self.cy)
        for end, (i, j) in ((0.0, (0, 1)), (self.length, (-1, -2))):
            over = (s < 0.0) if end == 0.0 else (s > self.length)
            if np.any(over):
                ux, uy = self.cx[i] - self.cx[j], self.cy[i] - self.cy[j]
                n = np.hypot(ux, uy)
                x = np.where(over, self.cx[i] + ux / n * np.abs(s - end), x)
                y = np.where(over, self.cy[i] + uy / n * np.abs(s - end), y)
        return x, y

    def tangent_bearing(self, s):
        s = np.clip(s, 0.0, self.length)
        i = np.clip(np.searchsorted(self.cchain, s, side="right") - 1, 0, len(self.cchain) - 2)
        dx = self.cx[i + 1] - self.cx[i]
        dy = self.cy[i + 1] - self.cy[i]
        return np.degrees(np.arctan2(dx, dy)) % 360.0

    def level_at(self, s):
        s = np.asarray(s, dtype=float)
        return self.north_level + (self.lock_rise[None, :] * (s[..., None] > self.lock_s[None, :])).sum(axis=-1)

    def reach_index(self, s):
        s = np.clip(s, 0.0, self.length - 1e-9)
        return np.clip(np.searchsorted(self.r_start, s, side="right") - 1, 0, len(self.r_start) - 1)

    def reach_effects(self, s):
        s = np.clip(np.asarray(s, dtype=float), 0.0, self.length)
        w = self.r_width
        sig = lambda z: 0.5 * (1 + np.tanh(z / 2.0))
        member = sig((s[..., None] - self.r_start) / w) - sig((s[..., None] - self.r_end) / w)
        # Ends of the canal: the first and last reach own everything beyond.
        member[..., 0] = 1.0 - sig((s - self.r_end[0]) / w)
        member[..., -1] = sig((s - self.r_start[-1]) / w)
        member /= member.sum(axis=-1, keepdims=True)
        return {k: (member * v).sum(axis=-1) for k, v in self.r_eff.items()}

    # --- the boat -------------------------------------------------------------
    def boat(self, t):
        """Boat state at times t (seconds since the simulation epoch)."""
        t = np.asarray(t, dtype=float)
        i = np.clip(np.searchsorted(self.t0, t, side="right") - 1, 0, len(self.t0) - 1)
        span = self.t1[i] - self.t0[i]
        frac = np.where(span > 0, np.clip((t - self.t0[i]) / np.where(span > 0, span, 1), 0, 1), 0.0)
        s = self.s0[i] + frac * (self.s1[i] - self.s0[i])
        moving = self.kind[i] == KIND_CODES["move"]
        speed = np.where(moving, np.abs(self.s1[i] - self.s0[i]) / np.where(span > 0, span, 1), 0.0)
        direction = self.dir[i]
        heading = (self.tangent_bearing(s) + np.where(direction < 0, 180.0, 0.0)) % 360.0
        level = self.level_at(s)
        in_lock = self.kind[i] == KIND_CODES["lock"]
        if np.any(in_lock):
            ls = s[in_lock]
            d = direction[in_lock]
            before = self.level_at(ls - d * 1.0)
            after = self.level_at(ls + d * 1.0)
            level = level.copy()
            level[in_lock] = before + frac[in_lock] * (after - before)
        waiting = self.kind[i] == KIND_CODES["stoppage"]
        if np.any(waiting):
            level = level.copy()
            level[waiting] = self.level_at(s[waiting] - direction[waiting] * 1.0)
        return {
            "chainage": s,
            "speed": speed,
            "direction": direction,
            "heading": heading,
            "elevation": level,
            "segment": i,
            "kind": self.kind[i],
        }

    def sensor_chainage(self, boat, sensor: str):
        sign = 1.0 if sensor == "bow" else -1.0
        return boat["chainage"] + sign * boat["direction"] * self.half

    # --- the weather ----------------------------------------------------------
    def mass_state(self, t):
        t = np.asarray(t, dtype=float)
        k = np.searchsorted(self.f_arr, t, side="right") - 1
        has = k >= 0
        kk = np.where(has, k, 0)
        frm = np.where(has, self.seq[np.clip(kk, 0, len(self.seq) - 1)], self.seq[0])
        to = np.where(has, self.seq[np.clip(kk + 1, 0, len(self.seq) - 1)], self.seq[0])
        x = np.where(has, np.clip((t - self.f_arr[kk]) / self.f_dur[kk], 0.0, 1.0), 0.0)
        w = x * x * (3 - 2 * x)
        bump = np.where(has & (x > 0) & (x < 1), np.sin(math.pi * x), 0.0)
        dip = np.where(has, self.f_dip[kk], 0.0) * bump
        boost = 1.0 + (np.where(has, self.f_boost[kk], 1.0) - 1.0) * bump
        return frm, to, w, dip, boost

    def mass_label(self, t):
        frm, to, w, _, _ = self.mass_state(t)
        return np.where(w < 0.5, frm, to)

    def in_front(self, t):
        _, _, w, _, _ = self.mass_state(t)
        return (w > 0) & (w < 1)

    def anomaly(self, t):
        t = np.asarray(t, dtype=float)
        z = (self.a_amp[:, :, None] * np.sin(2 * math.pi * t[None, None, :] / self.a_per[:, :, None]
                                             + self.a_ph[:, :, None])).sum(axis=1)
        return self.chol @ z  # 6 x n, unit variance, correlated

    def local_hour(self, t):
        return ((np.asarray(t, dtype=float) + self.solar_offset_s) / 3600.0) % 24.0

    def weather(self, t, s, elevation):
        """Noise-free conditions at time t and chainage s."""
        t = np.atleast_1d(np.asarray(t, dtype=float))
        s = np.atleast_1d(np.asarray(s, dtype=float))
        frm, to, w, dip, boost = self.mass_state(t)

        def blend(p):
            return (1 - w) * self.mprop[p][frm] + w * self.mprop[p][to]

        def sd(p):
            return (1 - w) * self.msd[p][frm] + w * self.msd[p][to]

        an = self.anomaly(t)
        clear = np.clip(blend("clear") + an[5] * sd("clear"), 0.05, 1.0)
        h = self.local_hour(t)
        D = self.diurnal
        amp = D["T_amplitude_base"] + D["T_amplitude_per_clear"] * clear
        dT = amp * np.cos(2 * math.pi * (h - D["T_peak_local_hour"]) / 24.0)
        eff = self.reach_effects(s)
        T = blend("T") + an[0] * sd("T") + dT + eff["dT"]
        RH = np.clip(blend("RH") + an[1] * sd("RH") + D["RH_per_T"] * dT + eff["dRH"], 5.0, 100.0)
        p_sea = blend("P") + an[2] * sd("P") - dip
        p_station = p_sea - self.lapse * np.asarray(elevation, dtype=float)
        gust = self.g_frac * np.sin(2 * math.pi * t[None, :] / self.g_per[:, None] + self.g_ph[:, None]).sum(axis=0) / math.sqrt(len(self.g_per) / 2)
        wind_open = np.maximum(0.0, (blend("wind") + an[3] * sd("wind")) * boost * (1 + gust))
        wind = wind_open * eff["wind"]
        # Circular blend of wind direction along the shortest arc.
        a0 = self.mprop["wind_from"][frm]
        a1 = self.mprop["wind_from"][to]
        delta = ((a1 - a0 + 180.0) % 360.0) - 180.0
        wind_from = (a0 + w * delta + an[4] * sd("wind_from")) % 360.0
        day = np.clip(np.sin(math.pi * (h - D["sunrise_local_hour"]) / (D["sunset_local_hour"] - D["sunrise_local_hour"])), 0.0, None)
        day = np.where((h > D["sunrise_local_hour"]) & (h < D["sunset_local_hour"]), day, 0.0)
        solar = D["solar_peak_wm2"] * clear * day * eff["solar"]
        water = (blend("water") + 0.1 * an[0] * sd("T")
                 + D["water_amplitude"] * np.cos(2 * math.pi * (h - D["water_peak_local_hour"]) / 24.0)
                 + eff["dWater"])
        return {
            "air_temperature": T,
            "relative_humidity": RH,
            "pressure": p_station,
            "pressure_sea_level": p_sea,
            "true_wind_speed": wind,
            "true_wind_from": wind_from,
            "solar_irradiance": solar,
            "water_temperature": water,
        }

    def apparent_wind(self, wind_speed, wind_from, boat_speed, heading):
        th = np.radians(wind_from)
        air_e = -wind_speed * np.sin(th)
        air_n = -wind_speed * np.cos(th)
        hd = np.radians(heading)
        rel_e = air_e - boat_speed * np.sin(hd)
        rel_n = air_n - boat_speed * np.cos(hd)
        speed = np.hypot(rel_e, rel_n)
        frm = np.degrees(np.arctan2(-rel_e, -rel_n)) % 360.0
        return speed, (frm - heading) % 360.0

    def sensor_truth(self, t, sensor: str):
        """Noise-free readings for a sensor at times t: what it would read."""
        t = np.atleast_1d(np.asarray(t, dtype=float))
        b = self.boat(t)
        s = self.sensor_chainage(b, sensor)
        wx = self.weather(t, s, b["elevation"])
        aws, awd = self.apparent_wind(wx["true_wind_speed"], wx["true_wind_from"], b["speed"], b["heading"])
        x, y = self.xy_at(s)
        return {
            "t": t, "chainage": s, "x": x, "y": y, "boat": b,
            "air_temperature": wx["air_temperature"],
            "relative_humidity": wx["relative_humidity"],
            "pressure": wx["pressure"],
            "apparent_wind_speed": aws,
            "apparent_wind_direction": awd,
            "solar_irradiance": wx["solar_irradiance"],
            "water_temperature": wx["water_temperature"],
            "true_wind_speed": wx["true_wind_speed"],
            "true_wind_from": wx["true_wind_from"],
            "pressure_sea_level": wx["pressure_sea_level"],
            "in_tunnel": self.in_tunnel(s),
        }

    def in_tunnel(self, s):
        for r in self.m["canal"]["reaches"]:
            if r["kind"] == "tunnel":
                return (np.asarray(s) >= r["start"]) & (np.asarray(s) <= r["end"])
        return np.zeros_like(np.asarray(s), dtype=bool)


@lru_cache(maxsize=4)
def _cached(seed: int):
    from . import world

    return World(world.generate(seed))


def world_for_seed(seed: int) -> World:
    return _cached(seed)
