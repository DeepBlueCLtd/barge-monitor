"""Data cleanse: the core model that runs first (FR-34).

For each imported dataset it reads each sensor's ``weather__{ds}`` (and each analyser's ``co2__{ds}``),
removes readings the QC flags mark as suspect, failed or missing and readings that stand out from
their neighbours by more than its ``spike_threshold`` setting, then smooths what is left over five
seconds. **Every other model reads its output, never the sensors' datastreams** (AT-15).

It publishes ``cleaned-<sensor>__{ds}``, and CO₂ only under its restricted subsystem
(``cleaned-co2-<sensor>__{ds}``, FR-112), one **block** per window of an hour: each quantity's
readings as a JSON array (D-280), so that a whole day is a few hundred observations, not a few
hundred thousand. A removed reading is ``null`` in its block.

Windows are whole hours aligned to the dataset's start (D-129); each reads two seconds either side,
so its first and last readings have neighbours. Its outputs depend only on the dataset and its
settings (AT-34).
"""
from __future__ import annotations

import numpy as np

from csmodel import QUANTITIES, SENSORS, URN, Model, block_fields, encode_block

SMOOTH = 5  # readings in the moving mean
MARGIN = 2.0  # seconds read either side of a window, so its edge readings have neighbours


def robust_noise(v: np.ndarray) -> float:
    d = np.diff(v[np.isfinite(v)])
    if len(d) < 10:
        return np.inf
    step = np.abs(d[d != 0])
    floor = 0.5 * float(step.min()) if len(step) else 0.0  # readings written to a resolution (whole %, tenths)
    return max(float(1.4826 * np.median(np.abs(d - np.median(d))) / np.sqrt(2)), floor) + 1e-9


def clean(cols: dict, names: list, threshold: float) -> tuple[dict, int]:
    """Cleaned columns and the number of readings removed (QC flag other than 1, or a spike)."""
    out = {"t": cols["t"]}
    removed = 0
    for p in names:
        v = np.asarray(cols[p], dtype=float).copy()
        flags = cols.get(f"{p}_qc")
        bad = (np.asarray([str(x) for x in flags], dtype=object) != "1") if flags is not None else ~np.isfinite(v)
        bad = bad | ~np.isfinite(v)
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
    window = 3600.0
    uses_co2 = True
    control = ("settings", "controlstreams/data-cleanse-settings.json")
    defaults = {"spike_threshold": 6.0}
    runs_master = "runs-data-cleanse.json"
    reads_cleanse = False  # it is the one that reads the sensors (AT-15)

    def __init__(self):
        super().__init__()
        self.src: dict = {}  # dataset -> {source: (key, fields, output key)}

    async def outputs(self, api, ds):
        d = ds["id"]
        src = {}
        for s in SENSORS:
            k = await api.find(f"{URN}sensor:{s}", f"weather__{d}")
            if k is None:
                return False
            names = [n for n in (await api.schema(k)) if n in QUANTITIES]
            out = await api.create_datastream(self.system, {
                "name": f"Cleaned {s} record · {d}", "outputName": f"cleaned-{s}__{d}",
                "schema": {"type": "DataRecord", "name": "record", "label": f"Cleaned {s} record",
                           "fields": block_fields(names)}})
            src[s] = (k, names, out)
        for s in SENSORS:  # CO₂ only under the restricted subsystem (FR-112)
            kc = await api.find(f"{URN}sensor:{s}:co2", f"co2__{d}")
            if kc is None:
                continue
            out = await api.create_datastream(self.restricted, {
                "name": f"Cleaned {s} CO₂ · {d}", "outputName": f"cleaned-co2-{s}__{d}",
                "schema": {"type": "DataRecord", "name": "record", "label": f"Cleaned {s} CO₂",
                           "fields": block_fields(["co2"])}})
            src[f"co2-{s}"] = (kc, ["co2"], out)
        self.src[d] = src
        return True

    async def process(self, api, ds, t0, t1, run):
        thr = float(run.settings["spike_threshold"])
        for name, (key, names, out) in self.src[ds["id"]].items():
            cols = await api.read(key, t0 - MARGIN, t1 + MARGIN - 0.001)
            t = cols["t"]
            if not len(t):
                continue
            api.tap("scilibs", f"numpy: clean {len(t)} {name} readings",
                    {"calls": ["numpy.diff", "numpy.median", "numpy.cumsum"], "readings": int(len(t)), "spike_threshold": thr})
            cleaned, _ = clean(cols, names, thr)
            keep = (t >= t0) & (t < t1)
            block = {k: np.asarray(v)[keep] for k, v in cleaned.items()}
            removed = int(sum(int(np.sum(~np.isfinite(block[n]))) for n in names))
            api.tap("models", f"numpy: {int(keep.sum())} cleaned, {removed} removed", {"rows": int(keep.sum()), "removed": removed})
            await api.publish(out, encode_block(t0, block, names, removed, run.id))


MODEL = DataCleanse
