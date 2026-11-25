"""Data cleanse: the core model that runs first (FR-34).

For each dataset it reads each sensor's ``weather`` (and each analyser's ``co2``) datastream,
removes readings the QC flags mark as suspect, failed or missing and readings that stand out
from their neighbours by more than its ``spike_threshold`` setting, then smooths what is left
over five seconds. It publishes ``cleaned-<sensor>__<ds>``, and CO₂ only under its restricted
subsystem (``cleaned-co2-<sensor>__<ds>``, FR-112). **Every other model reads these, never the
sensors' datastreams** (AT-15).

It works in whole windows aligned to the dataset's start, so its outputs are the same at any
replay rate (AT-34). A removed reading is published as "NaN".
"""
from __future__ import annotations

import numpy as np

from csmodel import QUANTITIES, SENSORS, URN, Model, quantity, record, run_field, time_field

SMOOTH = 5  # readings in the moving mean
MARGIN = 2.0  # seconds read before the window, so its first readings have neighbours


def robust_noise(v: np.ndarray) -> float:
    d = np.diff(v[np.isfinite(v)])
    if len(d) < 10:
        return np.inf
    return float(1.4826 * np.median(np.abs(d - np.median(d))) / np.sqrt(2)) + 1e-9


def clean(cols: dict, names: list, threshold: float) -> tuple[dict, int]:
    """Cleaned columns and the number of readings removed."""
    out = {"t": cols["t"]}
    removed = 0
    for p in names:
        v = np.asarray(cols[p], dtype=float).copy()
        flag = np.asarray([x if x is not None else "9" for x in cols.get(f"{p}_qc", ["1"] * len(v))], dtype=object)
        bad = flag != "1"
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
    return out, removed


class DataCleanse(Model):
    id = "data-cleanse"
    label = "Data cleanse"
    description = "Core model, runs first: removes noise before any other model sees the data."
    max_rate = 100.0
    window = 60.0
    uses_co2 = True
    control = ("settings", "Data cleanse settings",
               [quantity("spike_threshold", "Spike threshold, in multiples of the local noise", "1", lo=1, hi=10)])

    def __init__(self):
        self.settings = {"spike_threshold": 6.0}
        self.src: dict[str, dict] = {}  # dataset -> {sensor or co2-sensor: (key, fields)}
        self.out: dict[str, dict] = {}

    async def on_command(self, api, cmd):
        self.settings.update(cmd["parameters"])
        return f"spike threshold {self.settings['spike_threshold']:g}"

    async def datasets(self, api, ds):
        d = ds["id"]
        src, out = {}, {}
        for s in SENSORS:
            k = await api.find(f"{URN}sensor:{s}", f"weather__{d}")
            if k is None:
                return False
            names = [n for n in (await api.schema(k)) if n in QUANTITIES]
            src[s] = (k, names)
            out[s] = await api.create_datastream(self.system, {
                "name": f"Cleaned {s} record · {d}", "outputName": f"cleaned-{s}__{d}",
                "schema": record(f"Cleaned {s} record", [time_field()] + [quantity(n) for n in names] + [run_field()])})
            if self.restricted:
                kc = await api.find(f"{URN}sensor:{s}:co2", f"co2__{d}")
                if kc is not None:
                    src[f"co2-{s}"] = (kc, ["co2"])
                    out[f"co2-{s}"] = await api.create_datastream(self.restricted, {
                        "name": f"Cleaned {s} CO₂ · {d}", "outputName": f"cleaned-co2-{s}__{d}",
                        "schema": record(f"Cleaned {s} CO₂", [time_field(), quantity("co2"), run_field()])})
        self.src[d], self.out[d] = src, out
        return True

    async def process(self, api, ds, t0, t1, run):
        thr = float(self.settings["spike_threshold"])
        for name, (key, fields) in self.src[ds["id"]].items():
            cols = await api.read(key, t0 - MARGIN, t1 - 0.001)
            t = cols["t"]
            if not len(t):
                continue
            api.tap("scilibs", f"numpy: clean {len(t)} {name} readings",
                    {"calls": ["numpy.diff", "numpy.median", "numpy.cumsum"], "readings": int(len(t)), "spike_threshold": thr})
            out, removed = clean(cols, fields, thr)
            keep = t >= t0
            api.tap("models", f"numpy: {int(keep.sum())} cleaned, {removed} removed", {"rows": int(keep.sum()), "removed": removed})
            rows = {k: np.asarray(v)[keep] for k, v in out.items()}
            rows["run"] = np.array([run] * int(keep.sum()), dtype=object)
            await api.publish_many(self.out[ds["id"]][name], rows)


MODEL = DataCleanse
