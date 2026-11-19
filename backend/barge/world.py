"""World generator (B-C02): the canal, timetable, air masses, fronts and noise.

Everything is declared here and written to the manifest (FR-10), which is the
ground truth that analysis results are scored against (FR-26). Randomness comes
only from named, seeded streams (FR-12), recorded in the manifest.
"""
from __future__ import annotations

import math

import numpy as np

from . import config as C

PARAMS = [
    "air_temperature",
    "relative_humidity",
    "pressure",
    "apparent_wind_speed",
    "apparent_wind_direction",
    "solar_irradiance",
    "water_temperature",
]

PARAM_META = {
    "air_temperature": {"label": "Air temperature", "unit": "°C", "symbol": "Cel"},
    "relative_humidity": {"label": "Relative humidity", "unit": "%", "symbol": "%"},
    "pressure": {"label": "Barometric pressure (station)", "unit": "hPa", "symbol": "hPa"},
    "apparent_wind_speed": {"label": "Apparent wind speed", "unit": "m/s", "symbol": "m/s"},
    "apparent_wind_direction": {
        "label": "Apparent wind direction (relative to bow)",
        "unit": "°",
        "symbol": "deg",
    },
    "solar_irradiance": {"label": "Solar irradiance", "unit": "W/m²", "symbol": "W/m2"},
    "water_temperature": {"label": "Water temperature", "unit": "°C", "symbol": "Cel"},
}

STREAMS = ["timetable", "airmass", "fronts", "anomaly", "noise-bow", "noise-stern"]

# --- The canal, declared --------------------------------------------------
CANAL_LENGTH_M = 9000.0

# Shape of the centreline in local metres (east, north) before scaling to
# CANAL_LENGTH_M. Declared, not random.
_SHAPE = [
    (0, 0), (900, -500), (1700, -1500), (2000, -2600), (2700, -3500),
    (3700, -3900), (4500, -4700), (4800, -5800), (5500, -6600),
    (6600, -7000), (7300, -7900), (7500, -9000),
]

# Reaches: (id, name, kind, start, end) in chainage metres.
_REACHES = [
    ("north-wharf", "North Wharf basin", "open", 0, 250),
    ("embankment-1", "Upper embankment", "open", 250, 1650),
    ("cutting", "Deep cutting", "cutting", 1650, 2600),
    ("tunnel", "Long tunnel", "tunnel", 2600, 3200),
    ("woodland", "Woodland reach", "woodland", 3200, 4500),
    ("aqueduct", "Valley aqueduct", "aqueduct", 4500, 4950),
    ("embankment-2", "Middle embankment", "open", 4950, 6300),
    ("town", "Town reach", "town", 6300, 7650),
    ("lock-flight", "Lock flight", "open", 7650, 8750),
    ("south-wharf", "South Wharf basin", "open", 8750, 9000),
]

# How each kind of reach modifies the weather (FR-08). Additive offsets for
# temperatures and humidity, multiplicative factors for wind and sun.
REACH_EFFECTS = {
    "open": {"dT": 0.0, "dRH": 0.0, "dWater": 0.0, "wind": 1.0, "solar": 1.0},
    "cutting": {"dT": 0.4, "dRH": 3.0, "dWater": 0.0, "wind": 0.45, "solar": 0.75},
    "tunnel": {"dT": -3.0, "dRH": 9.0, "dWater": -0.6, "wind": 0.08, "solar": 0.0},
    "woodland": {"dT": -0.8, "dRH": 5.0, "dWater": -0.2, "wind": 0.5, "solar": 0.45},
    "aqueduct": {"dT": -0.6, "dRH": -2.0, "dWater": -0.3, "wind": 1.5, "solar": 1.0},
    "town": {"dT": 1.6, "dRH": -6.0, "dWater": 0.4, "wind": 0.7, "solar": 0.9},
}
REACH_TRANSITION_M = 25.0  # width of the blend across a reach boundary

# Locks: (id, chainage, rise in metres going south).
_LOCKS = [
    ("lock-1", 1500, 3.0),
    ("lock-2", 6750, 2.5),
    ("lock-3", 7950, 3.0),
    ("lock-4", 8200, 3.0),
    ("lock-5", 8450, 3.0),
]
NORTH_LEVEL_M = 40.0
LOCK_TIME_S = 480.0  # stopped in a lock while the level changes
DWELL_S = 1800.0  # minimum loading time at each wharf
# Departures are timetabled: one from alternate wharves every half period. A
# period of 5 h 45 m does not divide a day, so passes drift through the
# clock (FR-06a); the dwell absorbs each leg's variation in speed.
TIMETABLE_PERIOD_S = 20700.0
BRIDGES = [600, 1100, 3900, 5550, 6550, 7200]  # chainage; slow zone ±25 m
BRIDGE_HALF_WIDTH_M = 25.0

# Stoppages (FR-06b): the boat waits `hours` at the first arrival at `place`
# after `after_day`.
_STOPPAGES = [
    {"kind": "lock-closed", "place": "lock-3", "after_day": 8.4, "hours": 9.0},
    {"kind": "wharf-delay", "place": "south-wharf", "after_day": 5.3, "hours": 6.0},
    {"kind": "lock-closed", "place": "lock-1", "after_day": 12.7, "hours": 14.0},
    {"kind": "wharf-delay", "place": "north-wharf", "after_day": 19.1, "hours": 5.0},
]

# --- Weather --------------------------------------------------------------
# Air masses: mean of the slow state and standard deviations of its
# anomalies (FR-09). wind_from is degrees true, clearness 0..1.
AIR_MASSES = [
    {"id": "maritime", "name": "Mild maritime", "T": 14.0, "RH": 78.0, "P": 1012.0,
     "wind": 6.0, "wind_from": 240.0, "clear": 0.45, "water": 13.0,
     "sd": {"T": 0.7, "RH": 4.0, "P": 1.2, "wind": 1.2, "wind_from": 12.0, "clear": 0.10}},
    {"id": "continental", "name": "Dry continental", "T": 18.0, "RH": 52.0, "P": 1025.0,
     "wind": 3.0, "wind_from": 80.0, "clear": 0.9, "water": 14.5,
     "sd": {"T": 0.8, "RH": 3.0, "P": 1.0, "wind": 0.8, "wind_from": 15.0, "clear": 0.05}},
    {"id": "polar", "name": "Showery polar", "T": 8.5, "RH": 68.0, "P": 1004.0,
     "wind": 9.0, "wind_from": 310.0, "clear": 0.6, "water": 11.0,
     "sd": {"T": 1.0, "RH": 6.0, "P": 1.5, "wind": 1.8, "wind_from": 15.0, "clear": 0.15}},
    {"id": "tropical", "name": "Warm humid", "T": 20.0, "RH": 82.0, "P": 1009.0,
     "wind": 4.5, "wind_from": 195.0, "clear": 0.3, "water": 16.0,
     "sd": {"T": 0.6, "RH": 3.0, "P": 1.0, "wind": 1.0, "wind_from": 12.0, "clear": 0.08}},
]
# Correlation of anomalies, in the order T, RH, P, wind, wind_from, clear.
ANOMALY_CORRELATION = [
    [1.0, -0.6, 0.0, -0.2, 0.0, 0.5],
    [-0.6, 1.0, -0.3, 0.1, 0.0, -0.5],
    [0.0, -0.3, 1.0, -0.4, 0.0, 0.3],
    [-0.2, 0.1, -0.4, 1.0, 0.0, -0.1],
    [0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
    [0.5, -0.5, 0.3, -0.1, 0.0, 1.0],
]

DIURNAL = {
    "T_amplitude_per_clear": 4.0,  # °C peak-to-mean amplitude at clearness 1
    "T_amplitude_base": 0.8,
    "T_peak_local_hour": 15.0,
    "RH_per_T": -2.5,  # % per °C of diurnal temperature anomaly
    "water_amplitude": 0.35,
    "water_peak_local_hour": 17.0,
    "solar_peak_wm2": 1000.0,
    "sunrise_local_hour": 6.0,
    "sunset_local_hour": 18.0,
}

PRESSURE_LAPSE_HPA_PER_M = 0.12

NOISE = {
    "air_temperature": 0.08,
    "relative_humidity": 0.8,
    "pressure": 0.05,
    "apparent_wind_speed": 0.25,
    "apparent_wind_direction": 4.0,
    "solar_irradiance": 8.0,
    "water_temperature": 0.04,
}
SPIKE_PROBABILITY = 2e-4  # per parameter per reading
SPIKE_SCALE = (15.0, 40.0)  # spike magnitude in units of the noise sigma


def _scaled_shape():
    pts = np.array(_SHAPE, dtype=float)
    seg = np.hypot(*np.diff(pts, axis=0).T)
    scale = CANAL_LENGTH_M / seg.sum()
    pts *= scale
    return pts


def _local_to_lonlat(x, y):
    lat = C.ORIGIN_LAT + (np.asarray(y) / 6371000.0) * 180.0 / math.pi
    lon = C.ORIGIN_LON + (np.asarray(x) / (6371000.0 * math.cos(math.radians(C.ORIGIN_LAT)))) * 180.0 / math.pi
    return lon, lat


def lonlat_to_local(lon, lat):
    y = (np.asarray(lat) - C.ORIGIN_LAT) * math.pi / 180.0 * 6371000.0
    x = (np.asarray(lon) - C.ORIGIN_LON) * math.pi / 180.0 * 6371000.0 * math.cos(math.radians(C.ORIGIN_LAT))
    return x, y


def _seed_streams(seed: int) -> dict:
    ss = np.random.SeedSequence(seed)
    children = ss.spawn(len(STREAMS))
    return {name: int(child.generate_state(1, dtype=np.uint32)[0]) for name, child in zip(STREAMS, children)}


def stream(manifest: dict, name: str) -> np.random.Generator:
    return np.random.default_rng(manifest["seeds"]["streams"][name])


# --- Timetable ------------------------------------------------------------

def _slow_zones():
    zones = [(b - BRIDGE_HALF_WIDTH_M, b + BRIDGE_HALF_WIDTH_M) for b in BRIDGES]
    for _id, _n, kind, a, b in _REACHES:
        if kind == "tunnel":
            zones.append((a, b))
    return zones


def _build_timetable(rng: np.random.Generator):
    """Segments of the boat's motion for the whole run.

    Each segment: [t0, t1, s0, s1, kind, place] where kind is one of
    move, lock, dwell, stoppage. Position is linear in time within a segment.
    """
    run_s = C.RUN_DAYS * 86400.0
    zones = _slow_zones()
    locks = {lid: s for lid, s, _ in _LOCKS}
    pending = [dict(st) for st in _STOPPAGES]
    segs = []
    t = 0.0
    s = 0.0
    direction = +1

    def stoppage_at(place, now):
        for st in pending:
            if st["place"] == place and now >= st["after_day"] * 86400.0 and not st.get("used"):
                st["used"] = True
                st["start"] = now
                return st
        return None

    # Start: dwell at North Wharf.
    segs.append([t, t + DWELL_S / 2, 0.0, 0.0, "dwell", "north-wharf"])
    t += DWELL_S / 2
    start = t
    legs = 0
    delay = 0.0
    while t < run_s:
        target = CANAL_LENGTH_M if direction > 0 else 0.0
        factor = float(rng.uniform(0.9, 1.05))
        cruise = min(C.CRUISE_SPEED_MS * factor, C.SPEED_LIMIT_MS)
        slow = C.SLOW_SPEED_MS * factor
        marks = {0.0, CANAL_LENGTH_M}
        for a, b in zones:
            marks.update([max(0.0, a), min(CANAL_LENGTH_M, b)])
        marks.update(locks.values())
        lo, hi = min(s, target), max(s, target)
        ordered = sorted(m for m in marks if lo <= m <= hi)
        if direction < 0:
            ordered = ordered[::-1]
        for a, b in zip(ordered[:-1], ordered[1:]):
            mid = (a + b) / 2
            v = slow if any(z0 <= mid <= z1 for z0, z1 in zones) else cruise
            dt = abs(b - a) / v
            segs.append([t, t + dt, a, b, "move", None])
            t += dt
            for lid, ls in locks.items():
                if abs(b - ls) < 1e-6 and b != target:
                    st = stoppage_at(lid, t)
                    if st:
                        segs.append([t, t + st["hours"] * 3600, b, b, "stoppage", lid])
                        st["end"] = t + st["hours"] * 3600
                        t += st["hours"] * 3600
                    segs.append([t, t + LOCK_TIME_S, b, b, "lock", lid])
                    t += LOCK_TIME_S
        s = target
        wharf = "south-wharf" if direction > 0 else "north-wharf"
        st = stoppage_at(wharf, t)
        if st:
            segs.append([t, t + st["hours"] * 3600, s, s, "stoppage", wharf])
            st["end"] = t + st["hours"] * 3600
            t += st["hours"] * 3600
        legs += 1
        depart = max(t + DWELL_S, start + legs * TIMETABLE_PERIOD_S / 2 + delay)
        if st:
            delay += st["hours"] * 3600
            depart = max(t + DWELL_S, start + legs * TIMETABLE_PERIOD_S / 2 + delay)
        segs.append([t, depart, s, s, "dwell", wharf])
        t = depart
        direction = -direction
    stoppages = [
        {k: st[k] for k in ("kind", "place", "hours", "start", "end") if k in st}
        for st in pending
        if st.get("used")
    ]
    return segs, stoppages


# --- Weather plan ------------------------------------------------------------

def _build_fronts(rng: np.random.Generator):
    run_s = C.RUN_DAYS * 86400.0
    n_masses = len(AIR_MASSES)
    seq = [int(rng.integers(n_masses))]
    fronts = []
    t = float(rng.uniform(0.6, 1.4)) * 86400.0
    while t < run_s:
        nxt = int(rng.integers(n_masses - 1))
        if nxt >= seq[-1]:
            nxt += 1
        duration = float(rng.uniform(1.5, 4.0)) * 3600.0
        fronts.append({
            "id": f"front-{len(fronts) + 1}",
            "arrival": t,
            "duration": duration,
            "from": AIR_MASSES[seq[-1]]["id"],
            "to": AIR_MASSES[nxt]["id"],
            "pressure_dip_hpa": float(rng.uniform(1.5, 4.0)),
            "wind_boost": float(rng.uniform(1.2, 1.8)),
        })
        seq.append(nxt)
        t += float(rng.uniform(1.6, 4.2)) * 86400.0
    return [AIR_MASSES[i]["id"] for i in seq], fronts


def _build_anomaly(rng: np.random.Generator, n_components: int = 6):
    """Smooth unit-variance processes, one per anomaly dimension."""
    dims = 6
    periods = rng.uniform(1.0, 14.0, size=(dims, n_components)) * 3600.0
    amps = rng.uniform(0.5, 1.0, size=(dims, n_components))
    amps /= np.sqrt((amps ** 2).sum(axis=1, keepdims=True) / 2.0)
    phases = rng.uniform(0, 2 * math.pi, size=(dims, n_components))
    gust_periods = rng.uniform(60.0, 900.0, size=5)
    gust_phases = rng.uniform(0, 2 * math.pi, size=5)
    return {
        "periods_s": periods.tolist(),
        "amplitudes": amps.tolist(),
        "phases": phases.tolist(),
        "gust_periods_s": gust_periods.tolist(),
        "gust_phases": gust_phases.tolist(),
        "gust_fraction": 0.15,
    }


def generate(seed: int) -> dict:
    """Generate the manifest for a run."""
    streams = _seed_streams(seed)
    pts = _scaled_shape()
    lon, lat = _local_to_lonlat(pts[:, 0], pts[:, 1])
    seg_len = np.hypot(*np.diff(pts, axis=0).T)
    chain = np.concatenate([[0.0], np.cumsum(seg_len)])

    manifest = {
        "generator_version": C.GENERATOR_VERSION,
        "fictional": "Everything here is fictional: canal, places and weather. "
                     "The location is open ocean, declared so no coordinate is a real place.",
        "origin": {"lat": C.ORIGIN_LAT, "lon": C.ORIGIN_LON},
        "epoch": C.SIM_EPOCH_ISO,
        "run_days": C.RUN_DAYS,
        "seeds": {"seed": seed, "streams": streams},
        "canal": {
            "length_m": CANAL_LENGTH_M,
            "centreline": {
                "lon": lon.tolist(), "lat": lat.tolist(),
                "x": pts[:, 0].tolist(), "y": pts[:, 1].tolist(),
                "chainage": chain.tolist(),
            },
            "reaches": [
                {"id": i, "name": n, "kind": k, "start": a, "end": b, "effects": REACH_EFFECTS[k]}
                for i, n, k, a, b in _REACHES
            ],
            "reach_transition_m": REACH_TRANSITION_M,
            "locks": [{"id": i, "chainage": s, "rise_m": r} for i, s, r in _LOCKS],
            "north_level_m": NORTH_LEVEL_M,
            "bridges": BRIDGES,
            "wharves": [
                {"id": "north-wharf", "name": "North Wharf", "chainage": 0.0},
                {"id": "south-wharf", "name": "South Wharf", "chainage": CANAL_LENGTH_M},
            ],
        },
        "boat": {
            "sensor_separation_m": C.SENSOR_SEPARATION_M,
            "speed_limit_ms": C.SPEED_LIMIT_MS,
            "cruise_speed_ms": C.CRUISE_SPEED_MS,
            "slow_speed_ms": C.SLOW_SPEED_MS,
            "lock_time_s": LOCK_TIME_S,
            "dwell_s": DWELL_S,
        },
        "air_masses": AIR_MASSES,
        "anomaly_correlation": ANOMALY_CORRELATION,
        "diurnal": DIURNAL,
        "pressure_lapse_hpa_per_m": PRESSURE_LAPSE_HPA_PER_M,
        "noise": {"sigma": NOISE, "spike_probability": SPIKE_PROBABILITY, "spike_scale": SPIKE_SCALE},
    }
    segs, stoppages = _build_timetable(np.random.default_rng(streams["timetable"]))
    manifest["voyage"] = {"segments": segs, "stoppages": stoppages}
    seq, fronts = _build_fronts(np.random.default_rng(streams["fronts"]))
    manifest["weather"] = {
        "mass_sequence": seq,
        "fronts": fronts,
        "anomaly": _build_anomaly(np.random.default_rng(streams["anomaly"])),
    }
    return manifest


def public_canal(manifest: dict) -> dict:
    """The canal as a chart shows it: geography without its weather effects."""
    canal = manifest["canal"]
    return {
        "length_m": canal["length_m"],
        "centreline": {k: canal["centreline"][k] for k in ("lon", "lat", "chainage")},
        "reaches": [{k: r[k] for k in ("id", "name", "kind", "start", "end")} for r in canal["reaches"]],
        "locks": canal["locks"],
        "bridges": canal["bridges"],
        "wharves": canal["wharves"],
        "sensor_separation_m": manifest["boat"]["sensor_separation_m"],
        "origin": manifest["origin"],
        "fictional": manifest["fictional"],
    }
