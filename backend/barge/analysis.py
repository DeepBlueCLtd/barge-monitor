"""Analysis service (B-C09): a *process* system (FR-32).

Inputs are only what the server serves: readings and their QC flags, by
time. The analysis never sees position or the manifest (FR-34); scoring
happens afterwards, in ``scoring``.
"""
from __future__ import annotations

import math

import numpy as np

KMEANS_SEED = 20310407  # the analysis's own named stream
CLUSTER_STEP_S = 60


def dew_point(T, RH):
    a, b = 17.62, 243.12
    rh = np.clip(RH, 1.0, 100.0)
    g = np.log(rh / 100.0) + a * T / (b + T)
    return b * g / (a - g)


def moving_mean_time(t, y, width_s):
    ok = ~np.isnan(y)
    c = np.concatenate([[0.0], np.cumsum(np.where(ok, y, 0.0))])
    n = np.concatenate([[0], np.cumsum(ok)])
    lo = np.searchsorted(t, t - width_s / 2, "left")
    hi = np.searchsorted(t, t + width_s / 2, "right")
    cnt = n[hi] - n[lo]
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(cnt > 0, (c[hi] - c[lo]) / np.maximum(cnt, 1), np.nan)


def tendency(t, y, span_s=10800.0):
    """y(t) minus y(t - span), from 10-minute means."""
    m = moving_mean_time(t, y, 600.0)
    back = np.interp(t - span_s, t, m, left=np.nan)
    return m - back


def _noise(y):
    d = np.diff(y)
    if len(d) < 3:
        return 1.0
    cut = np.percentile(np.abs(d), 98)
    core = d[np.abs(d) <= cut]
    return float(np.sqrt(np.mean(core ** 2)) / math.sqrt(2)) + 1e-6


def _step_stat(t, y, half_s, grid):
    """Standardised step at each grid time, with any local linear trend removed."""
    ok = ~np.isnan(y)
    tt, yy = t[ok], y[ok]
    if len(yy) < 10:
        return np.zeros(len(grid))
    c = np.concatenate([[0.0], np.cumsum(yy)])
    edges = [np.searchsorted(tt, grid + k * half_s) for k in (-2, -1, 0, 1, 2)]
    means, counts = [], []
    for a, b in zip(edges[:-1], edges[1:]):
        n = b - a
        counts.append(n)
        means.append((c[b] - c[a]) / np.maximum(n, 1))
    fb, bf, af, fa = means
    step = (af - bf) - 0.5 * ((bf - fb) + (fa - af))
    n_min = np.min(counts, axis=0)
    z = np.abs(step) / (_noise(yy) * np.sqrt(5.0 / np.maximum(n_min, 1)))
    return np.where(n_min > 5, z, 0.0)


def _peaks(grid, score, threshold, min_gap_s):
    idx = np.flatnonzero(score > threshold)
    picked = []
    for i in idx[np.argsort(-score[idx])]:
        if all(abs(grid[i] - grid[j]) > min_gap_s for j in picked):
            picked.append(i)
    return sorted(picked)


SHORT_PARAMS = ["air_temperature", "relative_humidity", "water_temperature"]
LONG_PARAMS = ["pressure", "dew_point"]


def detect_changes(d: dict, sensitivity: float) -> dict:
    """Sustained changes of regime, never a single spike.

    Minutes scale: steps over two minutes in temperature, humidity and water
    temperature (a change of surroundings). Hours scale: steps over 45
    minutes in pressure and dew point, which carry no diurnal cycle (a change
    of air mass). Each is reported with its scale and strength.
    """
    t = d["t"]
    out = {"t": [], "scale": [], "strength": []}
    if len(t) < 600:
        return {k: np.asarray(v) for k, v in out.items()}
    short = [p for p in SHORT_PARAMS if p in d]
    if short:
        g1 = np.arange(t[0] + 240, t[-1] - 240, 5.0)
        zs = np.sqrt(np.mean([_step_stat(t, d[p], 120.0, g1) ** 2 for p in short], axis=0))
        for i in _peaks(g1, zs, 60.0 / sensitivity, 240.0):
            out["t"].append(g1[i]); out["scale"].append(0); out["strength"].append(float(zs[i]))
    long = [p for p in LONG_PARAMS if p in d]
    if long and t[-1] - t[0] > 4 * 2700:
        g2 = np.arange(t[0] + 5400, t[-1] - 5400, 60.0)
        parts = []
        for p in long:
            ys = moving_mean_time(t, d[p], 600.0)
            z = _step_stat(t[::30], ys[::30], 2700.0, g2)
            parts.append(z / (np.median(z) + 1e-9))
        zl = np.mean(parts, axis=0)
        for i in _peaks(g2, zl, 16.0 / sensitivity, 3 * 3600.0):
            out["t"].append(g2[i]); out["scale"].append(1); out["strength"].append(float(zl[i]))
    order = np.argsort(out["t"])
    return {k: np.asarray(v)[order] for k, v in out.items()}


def correlation(d: dict, names: list[str]):
    X = np.column_stack([d[n] for n in names])
    X = X[~np.isnan(X).any(axis=1)]
    if len(X) < 3:
        return np.full((len(names), len(names)), np.nan), 0
    with np.errstate(invalid="ignore", divide="ignore"):
        R = np.corrcoef(X, rowvar=False)
    sd = X.std(axis=0)
    R[:, sd == 0] = np.nan
    R[sd == 0, :] = np.nan
    return np.atleast_2d(R), int(len(X))


def kmeans(X, k, iters=50, seed=KMEANS_SEED):
    rng = np.random.default_rng(seed)
    n = len(X)
    centres = [X[rng.integers(n)]]
    for _ in range(1, k):
        d2 = np.min(((X[:, None, :] - np.array(centres)[None]) ** 2).sum(-1), axis=1)
        centres.append(X[rng.choice(n, p=d2 / d2.sum())] if d2.sum() > 0 else X[rng.integers(n)])
    centres = np.array(centres)
    labels = np.zeros(n, dtype=int)
    for it in range(iters):
        new = ((X[:, None, :] - centres[None]) ** 2).sum(-1).argmin(axis=1)
        if it and np.array_equal(new, labels):
            break
        labels = new
        for j in range(k):
            if (labels == j).any():
                centres[j] = X[labels == j].mean(axis=0)
    return labels


def cluster(d: dict, names: list[str], k: int):
    idx = np.arange(0, len(d["t"]), CLUSTER_STEP_S)
    X = np.column_stack([d[n][idx] for n in names])
    ok = ~np.isnan(X).any(axis=1)
    idx, X = idx[ok], X[ok]
    if len(X) < k:
        return idx, np.zeros(len(idx), dtype=int)
    Z = (X - X.mean(axis=0)) / (X.std(axis=0) + 1e-9)
    return idx, kmeans(Z, k)
