"""Data cleanse: the core model that runs first (FR-34).

It reads each sensor's raw records from the data server, removes readings the
server's QC flags mark as suspect, failed or missing and readings that stand
out from their neighbours by more than its ``spike_threshold`` setting, then
smooths what is left over five seconds. It publishes one cleaned datastream
per sensor. **Every other model reads these, not the raw datastreams** (AT-15).

Cleaned values lag the raw records by two seconds: a reading is judged only
once both its neighbours have arrived.
"""
from __future__ import annotations

import numpy as np

from csmodel import PRECIP, QUANTITIES, Model, category, measurement_fields, quantity, record, time_field

SENSORS = ("bow", "stern")
LAG_S = 2.0
SMOOTH = 5  # readings in the moving mean


def robust_noise(v: np.ndarray) -> float:
    d = np.diff(v[np.isfinite(v)])
    if len(d) < 10:
        return np.inf
    return float(1.4826 * np.median(np.abs(d - np.median(d))) / np.sqrt(2)) + 1e-9


def clean(cols: dict, threshold: float) -> tuple[dict, int]:
    """Cleaned columns and the number of readings removed."""
    out = {"t": cols["t"]}
    removed = 0
    for p in QUANTITIES:
        if p not in cols:
            continue
        v = np.asarray(cols[p], dtype=float).copy()
        flag = np.asarray(cols.get(f"{p}_qc", np.ones(len(v))), dtype=float)
        bad = flag != 1.0
        if len(v) >= 3 and p != "apparent_wind_direction":
            mid = np.full(len(v), np.nan)
            mid[1:-1] = 0.5 * (v[:-2] + v[2:])
            with np.errstate(invalid="ignore"):
                bad |= np.abs(v - mid) > threshold * robust_noise(v)
        v[bad] = np.nan
        removed += int(bad.sum())
        if p != "apparent_wind_direction":  # an angle is not averaged across north
            ok = np.isfinite(v)
            c = np.concatenate([[0.0], np.cumsum(np.where(ok, v, 0.0))])
            n = np.concatenate([[0], np.cumsum(ok)])
            h = SMOOTH // 2
            i = np.arange(len(v))
            lo, hi = np.clip(i - h, 0, len(v)), np.clip(i + h + 1, 0, len(v))
            with np.errstate(invalid="ignore", divide="ignore"):
                v = np.where(ok, (c[hi] - c[lo]) / np.maximum(n[hi] - n[lo], 1), np.nan)
        out[p] = np.round(v, 3)
    if "precipitation_type" in cols:
        out["precipitation_type"] = np.asarray(cols["precipitation_type"], dtype=object)
    return out, removed


class DataCleanse(Model):
    id = "data-cleanse"
    label = "Data cleanse"
    description = "Core model, runs first: flags and removes noise before any other model sees the data."
    interval = 10.0
    catch_up_chunk = 86400.0

    def __init__(self):
        self.settings = {"spike_threshold": 6.0}
        self.raw = {}
        self.out = {}

    async def setup(self, api):
        await super().setup(api)
        fields = [time_field()] + measurement_fields() + [category("precipitation_type", "Precipitation", PRECIP)]
        for s in SENSORS:
            self.raw[s] = await api.find(f"urn:x-barge:sensor:{s}", "weather")
            self.out[s] = await api.create_datastream(self.system, {
                "name": f"Cleaned {s} record", "outputName": f"cleaned-{s}",
                "schema": record(f"Cleaned {s} record", fields)})
        self.control_key = await api.create_controlstream(self.system, {
            "name": "Data cleanse settings", "inputName": "settings",
            "schema": record("Data cleanse settings", [
                quantity("spike_threshold", "Spike threshold, in multiples of the local noise", "1", lo=1, hi=10)])})

    async def on_command(self, api, cmd):
        self.settings.update(cmd["parameters"])
        return f"spike threshold {self.settings['spike_threshold']}"

    async def step(self, api, t0, t1):
        done = t1
        for s in SENSORS:
            cols = await api.read(self.raw[s], t0 - LAG_S, t1)
            t = cols["t"]
            if len(t) < 3:
                return t0
            api.tap("scilibs", f"numpy: clean {len(t)} {s} readings",
                    {"calls": ["numpy.diff", "numpy.median", "numpy.cumsum"], "readings": int(len(t)),
                     "spike_threshold": self.settings["spike_threshold"]})
            out, removed = clean(cols, float(self.settings["spike_threshold"]))
            last = float(t[-1]) - LAG_S
            keep = ((t > t0) if t0 > 0 else (t >= 0)) & (t <= last)
            out = {k: np.asarray(v)[keep] for k, v in out.items()}
            api.tap("models", f"numpy: {int(keep.sum())} cleaned, {removed} removed", {"rows": int(keep.sum()), "removed": removed})
            await api.publish(self.out[s], out)
            done = min(done, last)
        return done


MODEL = DataCleanse
