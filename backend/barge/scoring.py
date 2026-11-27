"""Scoring against the manifest (FR-34): after the analysis, never inside it."""
from __future__ import annotations

import numpy as np

from .truth import World

_FOLDER_WORLD = None


def folder_world() -> World:
    """The ground truth of the data folder's datasets (4.7): the world it was generated from, by its seed (FR-15a).
    Only the referee reads it."""
    global _FOLDER_WORLD
    if _FOLDER_WORLD is None:
        from .datafolder import SEED
        from .world import generate

        _FOLDER_WORLD = World(generate(SEED))
    return _FOLDER_WORLD


PLACE_TOLERANCE_S = 120.0
FRONT_MARGIN_S = 3600.0


def ari(a, b) -> float:
    if len(a) < 2:
        return float("nan")
    _, ai = np.unique(a, return_inverse=True)
    _, bi = np.unique(b, return_inverse=True)
    table = np.zeros((ai.max() + 1, bi.max() + 1))
    np.add.at(table, (ai, bi), 1)
    comb = lambda x: x * (x - 1) / 2.0
    s_ij, s_a, s_b = comb(table).sum(), comb(table.sum(1)).sum(), comb(table.sum(0)).sum()
    expected = s_a * s_b / comb(len(a))
    maximum = (s_a + s_b) / 2.0
    return 1.0 if maximum == expected else float((s_ij - expected) / (maximum - expected))


def boundary_crossings(world: World, t0, t1) -> np.ndarray:
    """Times the bow crossed between reaches of different kinds."""
    t = np.arange(np.floor(t0), np.ceil(t1) + 1, 1.0)
    b = world.boat(t)
    r = world.reach_index(world.sensor_chainage(b, "bow"))
    kinds = np.array([rr["kind"] for rr in world.m["canal"]["reaches"]])
    ch = np.flatnonzero((np.diff(r) != 0) & (kinds[r[1:]] != kinds[r[:-1]]))
    return t[ch + 1]


def fronts(world: World, t0, t1):
    return [(f["arrival"], f["arrival"] + f["duration"]) for f in world.m["weather"]["fronts"]
            if f["arrival"] + f["duration"] >= t0 and f["arrival"] <= t1]


def score_changes(world: World, det: dict, t0, t1) -> dict:
    ev = boundary_crossings(world, t0, t1)
    fr = fronts(world, t0, t1)
    times, scale = det["t"], det["scale"]
    short, long = times[scale == 0], times[scale == 1]
    found = sum(1 for e in ev if len(short) and np.min(np.abs(short - e)) <= PLACE_TOLERANCE_S)
    true_short = sum(1 for s in short if len(ev) and np.min(np.abs(ev - s)) <= PLACE_TOLERANCE_S)
    fronts_found = sum(1 for a, e in fr if len(long) and np.any((long >= a - FRONT_MARGIN_S) & (long <= e + FRONT_MARGIN_S)))
    return {
        "boundary_recall": found / len(ev) if len(ev) else None,
        "boundary_precision": true_short / len(short) if len(short) else None,
        "front_recall": fronts_found / len(fr) if fr else None,
        "boundaries_crossed": int(len(ev)),
        "fronts_in_window": len(fr),
    }


def score_clusters(world: World, t, labels) -> dict:
    b = world.boat(t)
    reach = world.reach_index(world.sensor_chainage(b, "bow"))
    kinds = np.array([r["kind"] for r in world.m["canal"]["reaches"]])[reach]
    return {"ari_air_mass": ari(labels, world.mass_label(t)), "ari_reach_kind": ari(labels, kinds)}


def referee(kind: str, payload: dict) -> dict:
    """The demonstrator's referee (scaffolding, FR-37): a model's result scored against the data folder's world,
    outside the model. Times are Unix seconds (4.7); the world counts from its epoch. Raises ``KeyError``,
    ``TypeError`` or ``ValueError`` for a payload it cannot read, ``LookupError`` for a kind it does not score.
    Served by the demonstrator's server at ``/demonstrator/referee/{kind}``; beside OpenSensorHub, by the AT-32
    harness (D-347)."""
    from . import config as C

    w = folder_world()
    epoch = C.SIM_EPOCH_UNIX
    if kind == "changes":
        det = {"t": np.asarray(payload["t"], dtype=float) - epoch, "scale": np.asarray(payload["scale"], dtype=int)}
        r = score_changes(w, det, float(payload["t0"]) - epoch, float(payload["t1"]) - epoch)
        return {k: (None if v is None else float(v)) for k, v in r.items()}
    if kind == "clusters":
        t = np.asarray(payload["t"], dtype=float) - epoch
        if len(t) < 2:
            return {"ari_air_mass": None, "ari_reach_kind": None}
        r = score_clusters(w, t, np.asarray(payload["labels"]))
        return {k: (None if not np.isfinite(v) else float(v)) for k, v in r.items()}
    raise LookupError(f"the referee scores changes and clusters, not {kind}")
