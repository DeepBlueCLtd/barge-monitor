"""Summaries: minimum, mean and maximum per quantity, and derived values (FR-29, FR-34).

From Data cleanse's output only (AT-15), per dataset and per replay run:

* ``summary-1min-<sensor>__<ds>`` and ``summary-1h-<sensor>__<ds>``: ``<f>_min``, ``<f>``, ``<f>_max``
  for each quantity, the readings Data cleanse removed, and the most frequent wind sector;
* ``derived-1min__<ds>`` and ``derived-1h__<ds>``: dew point, bow minus stern air temperature and
  the pressure tendency;
* the CO₂ summaries only under its restricted subsystem (FR-112).

A window is a minute, aligned to the dataset's start; an hour is summarised when its last
minute is. It waits for Data cleanse to have published the whole window for the same run.
"""
from __future__ import annotations

import numpy as np

from csmodel import (QUANTITIES, SENSORS, URN, Model, NotReady, category, count, quantity, record, run_field,
                     time_field)

SECTORS = ("ahead", "starboard", "astern", "port")
DC = URN + "process:data-cleanse"


def dew_point(T, RH):
    a, b = 17.62, 243.12
    with np.errstate(invalid="ignore", divide="ignore"):
        g = np.log(np.clip(RH, 1.0, 100.0) / 100.0) + a * T / (b + T)
        return b * g / (a - g)


def sector(direction):
    d = np.asarray(direction, dtype=float)
    ok = np.isfinite(d)
    idx = np.zeros(len(d), dtype=int)
    idx[ok] = (np.floor(((d[ok] + 45.0) % 360.0) / 90.0)).astype(int)
    return np.where(ok, np.array(SECTORS, dtype=object)[idx], None)


def summarise(cols: dict, names: list) -> dict:
    """One interval's row: min, mean and max per quantity; readings removed; most frequent sector."""
    row = {}
    removed = 0
    for p in names:
        v = np.asarray(cols.get(p, []), dtype=float)
        good = v[np.isfinite(v)]
        removed += int(len(v) - len(good))
        row[f"{p}_min"] = round(float(good.min()), 3) if len(good) else np.nan
        row[p] = round(float(good.mean()), 3) if len(good) else np.nan
        row[f"{p}_max"] = round(float(good.max()), 3) if len(good) else np.nan
    row["readings_removed"] = removed
    if "apparent_wind_direction" in names:
        s = [x for x in sector(cols.get("apparent_wind_direction", [])) if x is not None]
        row["wind_sector"] = max(SECTORS, key=s.count) if s else None
    return row


def summary_fields(names: list) -> list:
    fields = [time_field("time", "Start of the interval")]
    for p in names:
        fields += [quantity(f"{p}_min", f"{p.replace('_', ' ')}: minimum", definition=None),
                   quantity(p), quantity(f"{p}_max", f"{p.replace('_', ' ')}: maximum")]
        fields[-3]["definition"] = fields[-2]["definition"]
        fields[-1]["definition"] = fields[-2]["definition"]
        fields[-3]["uom"] = fields[-1]["uom"] = fields[-2]["uom"]
    fields.append(count("readings_removed", "Readings removed"))
    if "apparent_wind_direction" in names:
        fields.append(category("wind_sector", "Wind sector", SECTORS))
    return fields + [run_field()]


class Summaries(Model):
    id = "summaries"
    label = "Summaries"
    description = "Core model: 1-minute and hourly minimum, mean and maximum, and derived values."
    max_rate = 100.0
    window = 60.0
    uses_co2 = True
    control = ("settings", "Summaries settings", [quantity("tendency_hours", "Pressure tendency span", "h", lo=1, hi=6)])

    def __init__(self):
        self.settings = {"tendency_hours": 3.0}
        self.src: dict[str, dict] = {}
        self.out: dict[str, dict] = {}

    async def on_command(self, api, cmd):
        self.settings.update(cmd["parameters"])
        return f"tendency over {self.settings['tendency_hours']:g} h"

    async def datasets(self, api, ds):
        d = ds["id"]
        src, out = {}, {}
        for s in SENSORS:
            k = await api.find(DC, f"cleaned-{s}__{d}")
            if k is None:
                return False
            names = [n for n in (await api.schema(k)) if n in QUANTITIES]
            src[s] = (k, names)
            for res, label in (("1min", "1-minute"), ("1h", "hourly")):
                out[f"{res}-{s}"] = await api.create_datastream(self.system, {
                    "name": f"{s.capitalize()} {label} summary · {d}", "outputName": f"summary-{res}-{s}__{d}",
                    "schema": record(f"{s.capitalize()} {label} summary", summary_fields(names))})
            if self.restricted:
                kc = await api.find(DC + ":restricted", f"cleaned-co2-{s}__{d}")
                if kc is not None:
                    src[f"co2-{s}"] = (kc, ["co2"])
                    for res, label in (("1min", "1-minute"), ("1h", "hourly")):
                        f = summary_fields(["co2"])
                        out[f"{res}-co2-{s}"] = await api.create_datastream(self.restricted, {
                            "name": f"{s.capitalize()} CO₂ {label} summary · {d}",
                            "outputName": f"summary-{res}-co2-{s}__{d}", "schema": record(f"CO₂ {label} summary", f)})
        for res, label in (("1min", "1-minute"), ("1h", "hourly")):
            out[f"derived-{res}"] = await api.create_datastream(self.system, {
                "name": f"Derived values, {label} · {d}", "outputName": f"derived-{res}__{d}",
                "schema": record(f"Derived values, {label}", [
                    time_field("time", "Start of the interval"), quantity("dew_point", "Dew point", "Cel"),
                    quantity("bow_minus_stern", "Bow − stern", "Cel"),
                    quantity("pressure_tendency_3h", "Pressure tendency", "hPa"), run_field()])})
        self.src[d], self.out[d] = src, out
        return True

    async def _read(self, api, key, t0, t1, run, need_last: bool):
        cols = await api.read(key, t0, t1 - 0.001)
        keep = np.asarray([r == run for r in cols.get("run", [])], dtype=bool)
        cols = {k: np.asarray(v)[keep] for k, v in cols.items()}
        if need_last and (not len(cols["t"]) or cols["t"][-1] < t1 - 1):
            raise NotReady(f"Data cleanse has not published up to {t1:.0f} yet")
        return cols

    def _derived(self, bow: dict, stern: dict, past: float) -> dict:
        T, RH = bow.get("air_temperature", np.nan), bow.get("relative_humidity", np.nan)
        out = {"dew_point": round(float(dew_point(np.array([T]), np.array([RH]))[0]), 3)
               if np.isfinite(T) and np.isfinite(RH) else np.nan,
               "bow_minus_stern": round(T - stern.get("air_temperature", np.nan), 3)
               if np.isfinite(T) and np.isfinite(stern.get("air_temperature", np.nan)) else np.nan}
        P = bow.get("pressure", np.nan)
        out["pressure_tendency_3h"] = round(P - past, 3) if np.isfinite(P) and np.isfinite(past) else np.nan
        return out

    async def process(self, api, ds, t0, t1, run):
        d = ds["id"]
        src, out = self.src[d], self.out[d]
        last = t1 >= ds["end"] + 1
        rows = {}
        for name, (key, names) in src.items():
            cols = await self._read(api, key, t0, t1, run, need_last=not last)
            rows[name] = (summarise(cols, names), names)
        api.tap("scilibs", f"numpy: 1-minute summaries at {t0:.0f}", {"calls": ["numpy.min", "numpy.mean", "numpy.max"]})
        for name, (row, _) in rows.items():
            k = f"1min-{name}"
            await api.publish(out[k], {"t": t0, **row, "run": run})
        span = float(self.settings["tendency_hours"]) * 3600.0
        past = np.nan
        if t0 - span >= ds["start"]:
            pc = await self._read(api, src["bow"][0], t0 - span, t0 - span + 60, run, need_last=False)
            pv = np.asarray(pc.get("pressure", []), dtype=float)
            pv = pv[np.isfinite(pv)]
            past = float(pv.mean()) if len(pv) else np.nan
        await api.publish(out["derived-1min"], {"t": t0, **self._derived(rows["bow"][0], rows["stern"][0], past), "run": run})
        # An hour, aligned to the dataset's start, once its last minute is summarised.
        if (t1 - ds["start"]) % 3600 == 0 or last:
            h0 = ds["start"] + np.floor((t0 - ds["start"]) / 3600.0) * 3600.0
            hrows = {}
            for name, (key, names) in src.items():
                cols = await self._read(api, key, h0, t1, run, need_last=False)
                hrows[name] = summarise(cols, names)
            api.tap("scilibs", f"numpy: hourly summaries at {h0:.0f}", {"calls": ["numpy.min", "numpy.mean", "numpy.max"]})
            for name, row in hrows.items():
                await api.publish(out[f"1h-{name}"], {"t": h0, **row, "run": run})
            hp = np.nan
            if h0 - span >= ds["start"]:
                pc = await self._read(api, src["bow"][0], h0 - span, h0 - span + 3600, run, need_last=False)
                pv = np.asarray(pc.get("pressure", []), dtype=float)
                pv = pv[np.isfinite(pv)]
                hp = float(pv.mean()) if len(pv) else np.nan
            await api.publish(out["derived-1h"], {"t": h0, **self._derived(hrows["bow"], hrows["stern"], hp), "run": run})
        api.tap("models", f"summaries published for {t0:.0f}", {"rows": len(rows)})


MODEL = Summaries
