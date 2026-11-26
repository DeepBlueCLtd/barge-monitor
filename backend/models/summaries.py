"""Summaries: summaries and derived values (FR-29, FR-34; the split is ADR 0003).

From Data cleanse's output only (AT-15), Summaries publishes:

* **summary datastreams** for each sensor: 1-minute means and hourly means of
  the seven parameters, the number of readings Data cleanse removed, and the
  most frequent precipitation type. Connected Systems has no standard
  aggregation; these ordinary datastreams are the declared workaround (FR-29);
* **derived values** at the same two resolutions: dew point, bow minus stern
  air temperature, and the pressure tendency over three hours.

A minute is published once it is complete; an hour once its sixty minutes are.
"""
from __future__ import annotations

from collections import deque

import numpy as np

from csmodel import (PRECIP, QUANTITIES, Model, category, count, measurement_fields, quantity, record, time_field)

SENSORS = ("bow", "stern")
RES = {"1min": 60.0, "1h": 3600.0}


def dew_point(T, RH):
    a, b = 17.62, 243.12
    with np.errstate(invalid="ignore", divide="ignore"):
        g = np.log(np.clip(RH, 1.0, 100.0) / 100.0) + a * T / (b + T)
        return b * g / (a - g)


def bin_means(t, cols: dict, start: float, width: float, n: int) -> dict:
    """Means of each quantity over n bins of `width` seconds from `start`, ignoring removed readings."""
    idx = np.floor((t - start) / width).astype(int)
    ok = (idx >= 0) & (idx < n)
    idx = idx[ok]
    out = {"t": start + width * np.arange(n)}
    removed = np.zeros(n)
    present = np.bincount(idx, minlength=n).astype(float)
    for p in QUANTITIES:
        if p not in cols:
            continue
        v = np.asarray(cols[p], dtype=float)[ok]
        good = np.isfinite(v)
        s = np.bincount(idx[good], weights=v[good], minlength=n)
        c = np.bincount(idx[good], minlength=n).astype(float)
        removed += present - c
        with np.errstate(invalid="ignore", divide="ignore"):
            out[p] = np.where(c > 0, s / np.maximum(c, 1), np.nan)
    out["readings_removed"] = removed
    if "precipitation_type" in cols:
        cats = np.asarray(cols["precipitation_type"], dtype=object)[ok]
        mode = []
        for k in range(n):
            vals = [c for c in cats[idx == k] if c is not None]
            mode.append(max(set(vals), key=vals.count) if vals else None)
        out["precipitation_type"] = np.array(mode, dtype=object)
    return out


class Summaries(Model):
    id = "summaries"
    label = "Summaries"
    description = "Core model: publishes its own datastreams."
    interval = 60.0
    catch_up_chunk = 4 * 3600.0  # history is read a few hours at a request, so the server stays responsive

    def __init__(self):
        self.settings = {"tendency_hours": 3.0}
        self.cleaned = {}
        self.out = {}
        self.minutes = {s: deque(maxlen=60 * 30) for s in SENSORS}  # recent minute rows (more than one catch-up chunk), for hours and tendency
        self.hours = deque(maxlen=12)  # recent hourly bow pressure, for the hourly tendency

    async def setup(self, api):
        await super().setup(api)
        summary = [time_field("time", "Start of the interval")] + measurement_fields() + [
            count("readings_removed", "Readings removed"), category("precipitation_type", "Precipitation", PRECIP)]
        derived = [time_field("time", "Start of the interval"),
                   quantity("dew_point", "Dew point", "Cel"),
                   quantity("bow_minus_stern", "Bow − stern", "Cel"),
                   quantity("pressure_tendency_3h", "Pressure tendency", "hPa")]
        for res, label in (("1min", "1-minute"), ("1h", "hourly")):
            for s in SENSORS:
                self.out[f"summary-{res}-{s}"] = await api.create_datastream(self.system, {
                    "name": f"{s.capitalize()} {label} means", "outputName": f"summary-{res}-{s}",
                    "schema": record(f"{s.capitalize()} {label} means", summary)})
            self.out[f"derived-{res}"] = await api.create_datastream(self.system, {
                "name": f"Derived values, {label}", "outputName": f"derived-{res}",
                "schema": record(f"Derived values, {label}", derived)})
        self.control_key = await api.create_controlstream(self.system, {
            "name": "Summaries settings", "inputName": "settings",
            "schema": record("Summaries settings", [quantity("tendency_hours", "Pressure tendency span", "h", lo=1, hi=6)])})

    async def on_command(self, api, cmd):
        self.settings.update(cmd["parameters"])
        return f"tendency over {self.settings['tendency_hours']} h"

    async def _sources(self, api):
        for s in SENSORS:
            if not self.cleaned.get(s):
                self.cleaned[s] = await api.find("urn:x-barge:process:data-cleanse", f"cleaned-{s}")
        return all(self.cleaned.get(s) for s in SENSORS)

    def _derived(self, rows: dict, span_rows: int, history: list) -> dict:
        b, s = rows["bow"], rows["stern"]
        T, RH = b.get("air_temperature"), b.get("relative_humidity")
        out = {"t": b["t"]}
        out["dew_point"] = dew_point(T, RH) if T is not None and RH is not None else np.full(len(b["t"]), np.nan)
        if T is not None and s.get("air_temperature") is not None:
            out["bow_minus_stern"] = T - s["air_temperature"]
        if b.get("pressure") is not None:
            p = np.concatenate([np.asarray(history, dtype=float), b["pressure"]])
            back = np.full(len(p), np.nan)
            if span_rows < len(p):
                back[span_rows:] = p[:-span_rows]
            out["pressure_tendency_3h"] = (p - back)[len(history):]
        return {k: (np.round(v, 3) if isinstance(v, np.ndarray) and v.dtype.kind == "f" else v) for k, v in out.items()}

    async def step(self, api, t0, t1):
        if not await self._sources(api):
            return t0
        start = np.floor(t0 / 60.0) * 60.0
        data = {}
        for s in SENSORS:
            data[s] = await api.read(self.cleaned[s], start, t1)
        avail = min((float(data[s]["t"][-1]) if len(data[s]["t"]) else start) for s in SENSORS)
        end = np.floor((avail + 1.0) / 60.0) * 60.0
        n = int((end - start) // 60)
        if n <= 0:
            return t0
        api.tap("scilibs", f"numpy: {n} minute means", {"calls": ["numpy.bincount", "numpy.log"], "minutes": n})
        rows = {s: bin_means(data[s]["t"], data[s], start, 60.0, n) for s in SENSORS}
        span = int(self.settings["tendency_hours"] * 60)
        hist = [r.get("pressure", np.nan) for r in list(self.minutes["bow"])[-span:]]
        derived = self._derived(rows, span, hist)
        api.tap("models", f"numpy: {n} minutes summarised", {"rows": n})
        for s in SENSORS:
            await api.publish_many(self.out[f"summary-1min-{s}"], rows[s])
        await api.publish_many(self.out["derived-1min"], derived)
        # Hours: from the minute means, once all sixty minutes of an hour are in.
        for s in SENSORS:
            for i in range(n):
                self.minutes[s].append({k: v[i] for k, v in rows[s].items()})
        await self._hours(api, end)
        return float(end)

    async def _hours(self, api, end):
        mins = {s: list(self.minutes[s]) for s in SENSORS}
        if not mins["bow"]:
            return
        first = np.ceil(mins["bow"][0]["t"] / 3600.0) * 3600.0
        h_end = np.floor(end / 3600.0) * 3600.0
        done = getattr(self, "hour_done", -1.0)
        hours = [h for h in np.arange(first, h_end, 3600.0) if h > done]
        if not hours:
            return
        rows = {}
        for s in SENSORS:
            t = np.array([m["t"] for m in mins[s]])
            cols = {p: np.array([m.get(p, np.nan) for m in mins[s]], dtype=float) for p in QUANTITIES if p in mins[s][0]}
            if "precipitation_type" in mins[s][0]:
                cols["precipitation_type"] = np.array([m.get("precipitation_type") for m in mins[s]], dtype=object)
            r = bin_means(t, cols, hours[0], 3600.0, len(hours))
            removed = np.array([m.get("readings_removed", 0.0) for m in mins[s]], dtype=float)
            idx = np.floor((t - hours[0]) / 3600.0).astype(int)
            ok = (idx >= 0) & (idx < len(hours))
            r["readings_removed"] = np.bincount(idx[ok], weights=removed[ok], minlength=len(hours))
            rows[s] = r
        span = int(round(self.settings["tendency_hours"]))
        derived = self._derived(rows, span, list(self.hours)[-span:])
        for p in rows["bow"].get("pressure", []):
            self.hours.append(p)
        api.tap("scilibs", f"numpy: {len(hours)} hourly means", {"calls": ["numpy.bincount"], "hours": len(hours)})
        api.tap("models", f"numpy: {len(hours)} hours summarised", {"rows": len(hours)})
        for s in SENSORS:
            await api.publish_many(self.out[f"summary-1h-{s}"], rows[s])
        await api.publish_many(self.out["derived-1h"], derived)
        self.hour_done = hours[-1]


MODEL = Summaries
