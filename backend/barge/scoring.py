"""Scoring against the manifest (FR-26).

Analysis results are graded here, after they are computed, against the
ground truth the world generator declared. A result is never presented as
correct because it looks plausible: it carries its score.
"""
from __future__ import annotations

import numpy as np

from .truth import World

PLACE_TOLERANCE_S = 120.0
FRONT_MARGIN_S = 3600.0


def _ari(a: np.ndarray, b: np.ndarray) -> float:
    """Adjusted Rand index between two labellings."""
    if len(a) < 2:
        return float("nan")
    _, ai = np.unique(a, return_inverse=True)
    _, bi = np.unique(b, return_inverse=True)
    table = np.zeros((ai.max() + 1, bi.max() + 1))
    np.add.at(table, (ai, bi), 1)
    comb = lambda x: x * (x - 1) / 2.0
    sum_ij = comb(table).sum()
    sum_a = comb(table.sum(axis=1)).sum()
    sum_b = comb(table.sum(axis=0)).sum()
    expected = sum_a * sum_b / comb(len(a))
    maximum = (sum_a + sum_b) / 2.0
    if maximum == expected:
        return 1.0
    return float((sum_ij - expected) / (maximum - expected))


def place_events(world: World, t0: float, t1: float) -> np.ndarray:
    """Times the bow crossed a boundary between reaches of different kinds."""
    t = np.arange(np.floor(t0), np.ceil(t1) + 1, 1.0)
    b = world.boat(t)
    s = world.sensor_chainage(b, "bow")
    r = world.reach_index(s)
    kinds = np.array([rr["kind"] for rr in world.m["canal"]["reaches"]])
    change = np.flatnonzero((np.diff(r) != 0) & (kinds[r[1:]] != kinds[r[:-1]]))
    return t[change + 1]


def front_windows(world: World, t0: float, t1: float):
    out = []
    for f in world.m["weather"]["fronts"]:
        a, e = f["arrival"], f["arrival"] + f["duration"]
        if e >= t0 and a <= t1:
            out.append((a, e, f["id"]))
    return out


def score_changes(world: World, det: dict, t0: float, t1: float) -> dict:
    events = place_events(world, t0, t1)
    fronts = front_windows(world, t0, t1)
    times, cause = det["t"], det["cause"]
    truth = []
    for tc in times:
        if len(events) and np.min(np.abs(events - tc)) <= PLACE_TOLERANCE_S:
            truth.append(0)
        elif any(a - FRONT_MARGIN_S <= tc <= e + FRONT_MARGIN_S for a, e, _ in fronts):
            truth.append(1)
        else:
            truth.append(-1)
    truth = np.asarray(truth, dtype=int)
    place_det = times[cause == 0] if len(times) else np.array([])
    found = sum(1 for e in events if len(place_det) and np.min(np.abs(place_det - e)) <= PLACE_TOLERANCE_S)
    weather_det = times[cause == 1] if len(times) else np.array([])
    fronts_found = sum(
        1 for a, e, _ in fronts
        if len(weather_det) and np.any((weather_det >= a - FRONT_MARGIN_S) & (weather_det <= e + FRONT_MARGIN_S))
    )
    labelled = truth >= 0
    attributed = int(labelled.sum())
    correct = int((cause[labelled] == truth[labelled]).sum()) if attributed else 0
    return {
        "detections": int(len(times)),
        "reach_boundaries_crossed": int(len(events)),
        "reach_boundaries_found": int(found),
        "reach_boundary_recall": found / len(events) if len(events) else None,
        "fronts_in_window": len(fronts),
        "fronts_found": int(fronts_found),
        "front_recall": fronts_found / len(fronts) if fronts else None,
        "false_alarms": int((truth < 0).sum()),
        "precision": float(labelled.mean()) if len(times) else None,
        "attribution_correct": correct,
        "attribution_rate": correct / attributed if attributed else None,
        "tolerance": {"place_s": PLACE_TOLERANCE_S, "front_margin_s": FRONT_MARGIN_S},
    }


def score_clusters(world: World, t: np.ndarray, labels: np.ndarray) -> dict:
    b = world.boat(t)
    reach = world.reach_index(world.sensor_chainage(b, "bow"))
    kinds = np.array([r["kind"] for r in world.m["canal"]["reaches"]])[reach]
    mass = world.mass_label(t)
    return {
        "samples": int(len(t)),
        "ari_vs_reach": _ari(labels, reach),
        "ari_vs_reach_kind": _ari(labels, kinds),
        "ari_vs_air_mass": _ari(labels, mass),
        "air_masses_in_window": int(len(np.unique(mass))),
        "reach_kinds_in_window": int(len(np.unique(kinds))),
    }


def score_true_wind(world: World, t, speed, direction) -> dict:
    tr = world.sensor_truth(t, "bow")
    ok = ~np.isnan(speed) & ~np.isnan(direction)
    if not ok.any():
        return {"samples": 0}
    ds = speed[ok] - tr["true_wind_speed"][ok]
    dd = (direction[ok] - tr["true_wind_from"][ok] + 180.0) % 360.0 - 180.0
    strong = tr["true_wind_speed"][ok] > 2.0
    return {
        "samples": int(ok.sum()),
        "speed_rmse_ms": float(np.sqrt(np.mean(ds ** 2))),
        "speed_bias_ms": float(np.mean(ds)),
        "direction_rmse_deg_where_wind_over_2ms": float(np.sqrt(np.mean(dd[strong] ** 2))) if strong.any() else None,
    }


def score_lag(world: World, d: dict) -> dict:
    declared = world.m["boat"]["sensor_separation_m"]
    out = {"declared_separation_m": declared, "estimated_separation_m": float(d["separation_estimate_m"]),
           "separation_error_m": float(d["separation_estimate_m"] - declared)}
    moving = d["speed"] > 0.5
    for p in ("air_temperature",):
        raw = d[f"bow_minus_stern_{p}"][moving]
        cor = d[f"bow_minus_stern_{p}_lag_corrected"][moving]
        out[f"{p}_rms_bow_minus_stern_raw"] = float(np.sqrt(np.nanmean(raw ** 2))) if raw.size else None
        out[f"{p}_rms_bow_minus_stern_lag_corrected"] = float(np.sqrt(np.nanmean(cor ** 2))) if cor.size else None
    sigma = world.m["noise"]["sigma"]["air_temperature"]
    out["air_temperature_noise_floor_rms"] = float(np.sqrt(2) * sigma)
    return out


def score_offsets(world: World, res: dict) -> dict:
    reaches = world.m["canal"]["reaches"]
    key = {"air_temperature": "dT", "relative_humidity": "dRH", "water_temperature": "dWater"}
    rows = []
    for i, r in enumerate(reaches):
        row = {"reach": r["id"], "passes": int(res["passes"][i])}
        for p, k in key.items():
            est = float(res[p][i])
            dec = float(r["effects"][k])
            se = res[f"{p}_se"][i]
            row[p] = {"estimated": est, "declared": dec, "error": est - dec,
                      "standard_error": None if np.isnan(se) else float(se)}
        rows.append(row)
    return {"reaches": rows, "reference": "offsets relative to the open reaches"}
