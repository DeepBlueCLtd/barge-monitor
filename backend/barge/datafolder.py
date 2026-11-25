"""The data folder (C-02, FR-15, FR-17): CSV recordings, generated at build time.

Four files, each a window of one world (seed 1) sampled by the bow and stern sensors
at 1 Hz, written in a deliberately awkward CSV dialect (docs/v4-interfaces.md §5):

* three comment lines, then a ``;``-separated header with units in brackets;
* a decimal **comma**; time as half-seconds since 1994-01-01 (``T_HS94``);
* air and water temperature in tenths of a degree, wind speed in **knots**;
* ``-9999`` for a missing number, ``VRB`` for a variable wind direction;
* both sensors as column groups (``BOW_``, ``STN_``) in one file; CRLF line ends.

Every random number comes from a named, seeded stream (FR-14). The same code and seed
give byte-identical files (FR-15a, AT-28). Nothing at run time writes here (FR-17a).
"""
from __future__ import annotations

import gzip
import hashlib
import json
from dataclasses import dataclass

import numpy as np

from . import config as C
from .truth import KIND_CODES, World
from .world import PARAMS, generate

SEED = 1
FOLDER_VERSION = "4.6.0"
LOGGER_EPOCH_UNIX = 757382400  # 1994-01-01T00:00:00Z
SENSORS = {"bow": "BOW", "stern": "STN"}
KNOT = 0.514444  # m/s
MISSING = "-9999"
CHUNK_S = 3600  # noise is drawn in hour-aligned blocks, so a reading never depends on chunking

# Column code, field, unit in brackets.
COLUMNS = [
    ("AT", "air_temperature", "dC"),
    ("RH", "relative_humidity", "%"),
    ("PR", "pressure", "hPa"),
    ("AWS", "apparent_wind_speed", "kn"),
    ("AWD", "apparent_wind_direction", "deg"),
    ("SR", "solar_irradiance", "W/m2"),
    ("WT", "water_temperature", "dC"),
    ("CO2", "co2", "ppm"),
]

# CO2 (FR-09a): baseline plus engine load. Load by what the boat is doing.
CO2_BASE = 415.0
CO2_DRIFT = 8.0
CO2_ENGINE = 180.0
CO2_LOAD = {KIND_CODES["move"]: 1.0, KIND_CODES["lock"]: 0.35, KIND_CODES["dwell"]: 0.05, KIND_CODES["stoppage"]: 0.05}
CO2_GAIN = {"bow": 1.0, "stern": 1.25}
CO2_SIGMA = 6.0
CO2_SPIKE_P = 2e-4

DAY = 86400


@dataclass(frozen=True)
class Mission:
    file: str
    label: str
    start: int  # simulated seconds since the simulation epoch
    duration: int
    drop: tuple = ()  # (sensor, field) columns left out of the file
    reexport_of: str | None = None


MISSIONS = [
    Mission("MISSION_A_20310407.csv", "Mission A", 0, DAY),
    Mission("MISSION_B_20310414.csv", "Mission B", 7 * DAY, DAY),
    Mission("MISSION_B_20310414_REEXPORT.csv", "Mission B (re-export)", 7 * DAY + 6 * 3600, DAY,
            reexport_of="MISSION_B_20310414.csv"),
    Mission("MISSION_C_20310421.csv", "Mission C", 14 * DAY, DAY // 2, drop=(("stern", "apparent_wind_speed"),)),
]
REEXPORT_FRACTION = 0.001  # readings in the re-export that differ (re-calibrated)
REEXPORT_OFFSET = {"air_temperature": 0.3, "relative_humidity": 1.0, "pressure": 0.2, "water_temperature": 0.2}


def _unix(t_sim) -> np.ndarray:
    return C.SIM_EPOCH_UNIX + np.asarray(t_sim, dtype=np.int64)


def iso(t_sim: float) -> str:
    return str(np.datetime64(int(C.SIM_EPOCH_UNIX + t_sim), "s")) + "Z"


class Sampler:
    """What the bow and stern sensors read, with declared noise, spikes and CO2 (FR-09, FR-09a, FR-11)."""

    def __init__(self, seed: int = SEED):
        self.manifest = generate(seed)
        self.world = World(self.manifest)
        m = self.manifest
        self.sigma = m["noise"]["sigma"]
        self.p_spike = m["noise"]["spike_probability"]
        self.spike_scale = m["noise"]["spike_scale"]
        self.seeds = {s: m["seeds"]["streams"][f"noise-{s}"] for s in SENSORS}
        # Named CO2 streams, derived from the seed and recorded in the manifest (FR-14).
        self.co2_seeds = {s: int(np.random.SeedSequence([seed, 0xC02, i]).generate_state(1)[0]) for i, s in enumerate(SENSORS)}
        self.reexport_seed = int(np.random.SeedSequence([seed, 0xE7]).generate_state(1)[0])

    def _noise(self, sensor: str, t: np.ndarray) -> dict:
        out = {p: np.empty(len(t)) for p in PARAMS + ["co2"]}
        blocks = (t // CHUNK_S).astype(int)
        for b in np.unique(blocks):
            rng = np.random.default_rng([self.seeds[sensor], int(b)])
            arr = {}
            for p in PARAMS:
                x = rng.normal(0.0, self.sigma[p], CHUNK_S)
                spikes = rng.random(CHUNK_S) < self.p_spike
                mag = rng.uniform(*self.spike_scale, CHUNK_S) * self.sigma[p] * rng.choice([-1.0, 1.0], CHUNK_S)
                arr[p] = x + np.where(spikes, mag, 0.0)
            crng = np.random.default_rng([self.co2_seeds[sensor], int(b)])
            x = crng.normal(0.0, CO2_SIGMA, CHUNK_S)
            spikes = crng.random(CHUNK_S) < CO2_SPIKE_P
            arr["co2"] = x + np.where(spikes, crng.uniform(15, 40, CHUNK_S) * CO2_SIGMA, 0.0)
            sel = blocks == b
            idx = (t[sel] - b * CHUNK_S).astype(int)
            for p in arr:
                out[p][sel] = arr[p][idx]
        return out

    def co2_truth(self, t: np.ndarray, sensor: str) -> np.ndarray:
        kind = self.world.boat(t)["kind"]
        load = np.vectorize(CO2_LOAD.get)(kind).astype(float)
        # A smoothed load: the engine does not change instantly (a 60 s moving average).
        k = np.ones(60) / 60.0
        load = np.convolve(np.pad(load, (59, 0), mode="edge"), k, mode="valid")
        drift = CO2_DRIFT * np.sin(2 * np.pi * t / (5.3 * 3600.0) + (0.7 if sensor == "stern" else 0.0))
        return CO2_BASE + drift + CO2_GAIN[sensor] * CO2_ENGINE * load

    def sample(self, sensor: str, t: np.ndarray) -> dict:
        tr = self.world.sensor_truth(t, sensor)
        noise = self._noise(sensor, t)
        v = {p: tr[p] + noise[p] for p in PARAMS}
        v["relative_humidity"] = np.clip(v["relative_humidity"], 0, 100)
        v["solar_irradiance"] = np.clip(v["solar_irradiance"], 0, None)
        v["apparent_wind_speed"] = np.clip(v["apparent_wind_speed"], 0, None)
        v["apparent_wind_direction"] = v["apparent_wind_direction"] % 360.0
        v["co2"] = np.clip(self.co2_truth(t, sensor) + noise["co2"], 0, None)
        return v


# --- the dialect --------------------------------------------------------------------------
def _fmt_int(x: np.ndarray) -> np.ndarray:
    ok = np.isfinite(x)
    out = np.full(len(x), MISSING, dtype=object)
    out[ok] = np.round(x[ok]).astype(np.int64).astype(str)
    return out


def _fmt_dec1(x: np.ndarray) -> np.ndarray:
    """One decimal place, with a decimal comma."""
    ok = np.isfinite(x)
    out = np.full(len(x), MISSING, dtype=object)
    tenths = np.round(x[ok] * 10).astype(np.int64)
    sign = np.where(tenths < 0, "-", "")
    a = np.abs(tenths)
    out[ok] = np.char.add(np.char.add(np.char.add(sign, (a // 10).astype(str)), ","), (a % 10).astype(str))
    return out


def encode(field: str, x: np.ndarray) -> np.ndarray:
    """A field's values as the file writes them (docs/v4-interfaces.md §5)."""
    if field in ("air_temperature", "water_temperature"):
        return _fmt_int(x * 10.0)
    if field == "apparent_wind_speed":
        return _fmt_dec1(x / KNOT)
    if field == "pressure":
        return _fmt_dec1(x)
    if field == "apparent_wind_direction":
        out = _fmt_int(x)
        out[np.isfinite(x) & (x < 0)] = "VRB"
        return out
    return _fmt_int(x)


def header_columns(drop: tuple = ()) -> list[tuple[str, str, str]]:
    """(column name, sensor, field) in file order."""
    cols = []
    for sensor, prefix in SENSORS.items():
        for code, field, unit in COLUMNS:
            if (sensor, field) in drop:
                continue
            cols.append((f"{prefix}_{code}[{unit}]", sensor, field))
    return cols


def write_csv(mission: Mission, sampler: Sampler) -> bytes:
    t = np.arange(mission.start, mission.start + mission.duration, dtype=float)
    data = {s: sampler.sample(s, t) for s in SENSORS}
    if mission.reexport_of:
        rng = np.random.default_rng(sampler.reexport_seed)
        for s in SENSORS:
            for f, off in REEXPORT_OFFSET.items():
                hit = rng.random(len(t)) < REEXPORT_FRACTION
                data[s][f] = np.where(hit, data[s][f] + off, data[s][f])
    cols = header_columns(mission.drop)
    ticks = ((_unix(t) - LOGGER_EPOCH_UNIX) * 2).astype(np.int64).astype(str)
    parts = [ticks] + [encode(field, data[sensor][field]) for _, sensor, field in cols]
    rows = parts[0].astype(object)
    for p in parts[1:]:
        rows = rows + ";" + p
    head = [
        "#LOGGER=BARGE-WX-2 SN 0417",
        f"#EXPORT=wxexport 2.3.1 ({FOLDER_VERSION})",
        f"#MISSION={mission.label}",
        ";".join(["T_HS94"] + [c for c, _, _ in cols]),
    ]
    return ("\r\n".join(head + rows.tolist()) + "\r\n").encode("ascii")


def build(seed: int = SEED) -> dict:
    """Every file of the data folder: {name: bytes}, plus manifest.json and index.json."""
    sampler = Sampler(seed)
    files: dict[str, bytes] = {}
    entries = []
    for m in MISSIONS:
        b = write_csv(m, sampler)
        files[m.file] = b
        sha = hashlib.sha256(b).hexdigest()
        entries.append({
            "file": m.file, "label": m.label, "size": len(b), "sha256": sha,
            "modified": iso(m.start + m.duration + 7200), "start": iso(m.start), "end": iso(m.start + m.duration - 1),
            "records": m.duration, "dropped": [f"{s}:{f}" for s, f in m.drop], "reexport_of": m.reexport_of,
        })
    manifest = {
        "folder_version": FOLDER_VERSION, "generator_version": C.GENERATOR_VERSION, "seed": seed,
        "co2_streams": sampler.co2_seeds, "reexport_stream": sampler.reexport_seed,
        "files": entries,
        "world": sampler.manifest,  # the ground truth, read only by the referee (FR-12, FR-37)
    }
    index = {"folder_version": FOLDER_VERSION,
             "files": [{k: e[k] for k in ("file", "size", "modified", "sha256")} for e in entries]}
    files["manifest.json"] = json.dumps(manifest, sort_keys=True).encode()
    files["index.json"] = json.dumps(index, indent=1).encode()
    return files


def gz(b: bytes) -> bytes:
    return gzip.compress(b, compresslevel=6, mtime=0)
