"""Summaries: minimum, mean and maximum per quantity, and derived values (FR-29, FR-34).

From Data cleanse's output only (AT-15), per dataset, reading Data cleanse's latest complete run on it:

* ``summary-1min-<sensor>__{ds}`` and ``summary-1h-<sensor>__{ds}``: ``<f>_min``, ``<f>``, ``<f>_max`` for
  each quantity, and the readings Data cleanse removed;
* ``derived-1min__{ds}`` and ``derived-1h__{ds}``: dew point, bow minus stern air temperature and the
  pressure tendency over its ``tendency_hours`` setting;
* the CO₂ summaries only under its restricted subsystem (FR-112).

A window is an hour aligned to the dataset's start: its sixty minutes, then the hour itself. Minutes and
hours are aligned to the dataset's start too (D-129), so the outputs depend only on the dataset and the
settings (AT-34).
"""
from __future__ import annotations

import numpy as np

from csmodel import QUANTITIES, SENSORS, Model, count, quantity, record, text, time_field

MINUTE, HOUR = 60.0, 3600.0
DC = "urn:x-barge:process:data-cleanse"


def dew_point(T, RH):
    a, b = 17.62, 243.12
    with np.errstate(invalid="ignore", divide="ignore"):
        g = np.log(np.clip(RH, 1.0, 100.0) / 100.0) + a * T / (b + T)
        return b * g / (a - g)


def summarise(t, cols: dict, names: list, starts) -> list[dict]:
    """One row per interval ``[s, s + width)``: min, mean and max per quantity; readings removed."""
    rows = []
    for a, b in starts:
        sel = (t >= a) & (t < b)
        row = {"t": float(a)}
        removed = 0
        for p in names:
            v = np.asarray(cols[p], dtype=float)[sel]
            good = v[np.isfinite(v)]
            removed += int(len(v) - len(good))
            row[f"{p}_min"] = round(float(good.min()), 3) if len(good) else np.nan
            row[p] = round(float(good.mean()), 3) if len(good) else np.nan
            row[f"{p}_max"] = round(float(good.max()), 3) if len(good) else np.nan
        row["readings_removed"] = removed
        rows.append(row)
    return rows


def summary_fields(names: list) -> list:
    fields = [time_field("time", "Start of the interval"), text("run_id", "Run")]
    for p in names:
        mean = quantity(p)
        lo = dict(mean, name=f"{p}_min", label=f"{mean['label']}: minimum")
        hi = dict(mean, name=f"{p}_max", label=f"{mean['label']}: maximum")
        fields += [lo, mean, hi]  # each has the definition and unit of its raw quantity (§6)
    return fields + [count("readings_removed", "Readings removed")]


DERIVED = [time_field("time", "Start of the interval"), text("run_id", "Run"), quantity("dew_point", "Dew point", "Cel"),
           quantity("bow_minus_stern", "Bow − stern", "Cel"), quantity("pressure_tendency_3h", "Pressure tendency", "hPa")]


class Summaries(Model):
    id = "summaries"
    label = "Summaries"
    description = "Core model: 1-minute and hourly minimum, mean and maximum, and derived values."
    window = HOUR
    uses_co2 = True
    control = ("settings", "controlstreams/summaries-settings.json")
    defaults = {"tendency_hours": 3.0}
    runs_master = "runs-summaries.json"

    def __init__(self):
        super().__init__()
        self.src: dict = {}  # dataset -> {source: fields}
        self.out: dict = {}  # dataset -> {name: key}

    async def outputs(self, api, ds):
        d = ds["id"]
        src, out = {}, {}
        for s in SENSORS:
            k = await api.find(DC, f"cleaned-{s}__{d}")
            if k is None:
                return False  # Data cleanse has not declared it yet
            # The quantities the sensor's record offers now (its schema, never its observations: AT-15). Data cleanse
            # takes the same, so both declare alike after a restart with another offering, whichever is first (FR-51).
            w = await api.find(f"urn:x-barge:sensor:{s}", f"weather__{d}")
            src[s] = [n for n in (await api.schema(w)) if n in QUANTITIES] if w else []
            for res, label in (("1min", "1-minute"), ("1h", "hourly")):
                out[f"{res}-{s}"] = await api.create_datastream(self.system, {
                    "name": f"{s.capitalize()} {label} summary · {d}", "outputName": f"summary-{res}-{s}__{d}",
                    "schema": record(f"{s.capitalize()} {label} summary", summary_fields(src[s]))})
        for s in SENSORS:  # CO₂ only under the restricted subsystem (FR-112)
            if await api.find(DC + ":restricted", f"cleaned-co2-{s}__{d}") is None:
                continue
            src[f"co2-{s}"] = ["co2"]
            for res, label in (("1min", "1-minute"), ("1h", "hourly")):
                out[f"{res}-co2-{s}"] = await api.create_datastream(self.restricted, {
                    "name": f"{s.capitalize()} CO₂ {label} summary · {d}", "outputName": f"summary-{res}-co2-{s}__{d}",
                    "schema": record(f"{s.capitalize()} CO₂ {label} summary", summary_fields(["co2"]))})
        for res, label in (("1min", "1-minute"), ("1h", "hourly")):
            out[f"derived-{res}"] = await api.create_datastream(self.system, {
                "name": f"Derived values, {label} · {d}", "outputName": f"derived-{res}__{d}",
                "schema": record(f"Derived values, {label}", DERIVED)})
        self.src[d], self.out[d] = src, out
        return True

    @staticmethod
    def _derived(bow: dict, stern: dict, past: float, run_id: str) -> dict:
        T, RH = bow.get("air_temperature", np.nan), bow.get("relative_humidity", np.nan)
        Ts, P = stern.get("air_temperature", np.nan), bow.get("pressure", np.nan)
        return {"t": bow["t"], "run_id": run_id,
                "dew_point": round(float(dew_point(T, RH)), 3) if np.isfinite(T) and np.isfinite(RH) else np.nan,
                "bow_minus_stern": round(T - Ts, 3) if np.isfinite(T) and np.isfinite(Ts) else np.nan,
                "pressure_tendency_3h": round(P - past, 3) if np.isfinite(P) and np.isfinite(past) else np.nan}

    async def process(self, api, ds, t0, t1, run):
        d = ds["id"]
        src, out = self.src[d], self.out[d]
        span = float(run.settings["tendency_hours"]) * HOUR
        minutes = [(a, min(a + MINUTE, t1)) for a in np.arange(t0, t1, MINUTE)]
        mins, hours = {}, {}
        for name, names in src.items():
            cols = await self.read_cleaned(api, d, name, t0, t1, run.source, names)
            mins[name] = summarise(cols["t"], cols, names, minutes)
            hours[name] = summarise(cols["t"], cols, names, [(t0, t1)])[0]
        api.tap("scilibs", f"numpy: summaries of the hour from {api.iso(t0)}",
                {"calls": ["numpy.min", "numpy.mean", "numpy.max"], "minutes": len(minutes)})
        # The pressure tendency: this interval's bow pressure minus the same interval `span` earlier (this run's own).
        pmin = run.state.setdefault("pressure_1min", {})
        phour = run.state.setdefault("pressure_1h", {})
        rid = run.id
        for name, rows in mins.items():
            await api.publish_many(out[f"1min-{name}"], _cols([dict(r, run_id=rid) for r in rows]))
            await api.publish(out[f"1h-{name}"], dict(hours[name], run_id=rid))
        derived = []
        for b, s in zip(mins["bow"], mins["stern"]):
            pmin[b["t"]] = b.get("pressure", np.nan)
            derived.append(self._derived(b, s, pmin.get(b["t"] - span, np.nan), rid))
        await api.publish_many(out["derived-1min"], _cols(derived))
        phour[t0] = hours["bow"].get("pressure", np.nan)
        await api.publish(out["derived-1h"], self._derived(hours["bow"], hours["stern"], phour.get(t0 - span, np.nan), rid))
        api.tap("models", f"summaries published for the hour from {api.iso(t0)}", {"minutes": len(minutes)})


def _cols(rows: list[dict]) -> dict:
    """Rows as columns, for publish_many."""
    keys = list(rows[0]) if rows else ["t"]
    return {k: np.array([r.get(k) for r in rows], dtype=object if k == "run_id" else float) for k in keys}


MODEL = Summaries
