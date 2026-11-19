"""Analysis service (B-C08): derived values, correlation, detection, clustering.

Inputs are what the facade serves (positions, readings, QC flags) plus the
canal as a chart shows it (reach extents, no weather effects). The manifest is
used only by ``scoring`` to grade results after they are computed (FR-26).
"""
from __future__ import annotations

import math

import numpy as np

from . import config as C
from .world import PARAMS, lonlat_to_local

PRESSURE_LAPSE_HPA_PER_M = 0.12  # standard atmosphere, not read from the manifest
ANTENNA_HEIGHT_M = 1.5  # declared installation height of the GPS antenna
KMEANS_SEED = 20310407  # the analysis's own named stream
CLUSTER_FEATURES = ["air_temperature", "relative_humidity", "pressure_reduced", "true_wind_speed",
                    "solar_irradiance", "water_temperature", "dew_point"]
OFFSET_PARAMS = ["air_temperature", "relative_humidity", "water_temperature"]
WEATHER_SMOOTH_S = 7200.0  # time scale separating weather from place


class BoundError(ValueError):
    def __init__(self, name, message):
        super().__init__(message)
        self.name = name


def check_bounds(params: dict) -> dict:
    """Validate analysis parameters against the service's own bounds (FR-23)."""
    out = {}
    for name, b in C.ANALYSIS_BOUNDS.items():
        v = params.get(name, b["default"])
        try:
            v = float(v)
        except (TypeError, ValueError):
            raise BoundError(name, f"{name} must be a number")
        if not (b["minimum"] <= v <= b["maximum"]):
            raise BoundError(name, f"{name}={v:g} is out of range: minimum {b['minimum']}, maximum {b['maximum']}")
        out[name] = int(v) if name == "clusters" else v
    return out


# --- geometry against the chart --------------------------------------------

class Chart:
    def __init__(self, canal: dict):
        cl = canal["centreline"]
        x, y = lonlat_to_local(np.asarray(cl["lon"]), np.asarray(cl["lat"]))
        self.x, self.y = np.asarray(x), np.asarray(y)
        self.chain = np.asarray(cl["chainage"])
        self.reaches = canal["reaches"]
        self.r_start = np.array([r["start"] for r in self.reaches])
        self.separation = canal["sensor_separation_m"]

    def chainage(self, px, py):
        best_d = np.full(len(px), np.inf)
        best_s = np.zeros(len(px))
        for i in range(len(self.x) - 1):
            ax, ay, bx, by = self.x[i], self.y[i], self.x[i + 1], self.y[i + 1]
            dx, dy = bx - ax, by - ay
            L2 = dx * dx + dy * dy
            u = np.clip(((px - ax) * dx + (py - ay) * dy) / L2, 0, 1)
            d = np.hypot(px - (ax + u * dx), py - (ay + u * dy))
            better = d < best_d
            best_d[better] = d[better]
            best_s[better] = self.chain[i] + u[better] * math.sqrt(L2)
        return best_s

    def reach_index(self, s):
        return np.clip(np.searchsorted(self.r_start, s, side="right") - 1, 0, len(self.r_start) - 1)


# --- derived values (FR-20) -------------------------------------------------

def _smooth(x, n):
    if n <= 1 or len(x) < n:
        return x
    k = np.ones(n) / n
    pad = n // 2
    xp = np.pad(x, (pad, n - 1 - pad), mode="edge")
    return np.convolve(xp, k, mode="valid")


def dew_point(T, RH):
    a, b = 17.62, 243.12
    rh = np.clip(RH, 1.0, 100.0)
    g = np.log(rh / 100.0) + a * T / (b + T)
    return b * g / (a - g)


def align(bow: dict, stern: dict):
    """Pair bow and stern records by time (both sample at 1 Hz)."""
    tb, ts = bow["t"], stern["t"]
    common, ib, is_ = np.intersect1d(np.round(tb), np.round(ts), return_indices=True)
    return common, ib, is_


def derived(bow: dict, stern: dict, chart: Chart) -> dict:
    """Derived series at the bow's records. Inputs are QC-masked columns."""
    t, ib, is_ = align(bow, stern)
    b = {k: v[ib] for k, v in bow.items()}
    s = {k: v[is_] for k, v in stern.items()}
    bx, by = lonlat_to_local(b["lon"], b["lat"])
    sx, sy = lonlat_to_local(s["lon"], s["lat"])
    # Heading from the stern antenna to the bow antenna works even when stopped.
    hx, hy = _smooth(bx - sx, 15), _smooth(by - sy, 15)
    heading = np.degrees(np.arctan2(hx, hy)) % 360.0
    separation = np.hypot(bx - sx, by - sy)
    # Velocity from the midpoint's track, smoothed over 15 s.
    mx, my = _smooth((bx + sx) / 2, 15), _smooth((by + sy) / 2, 15)
    dt = np.gradient(t) if len(t) > 1 else np.ones_like(t)
    ve = np.gradient(mx) / dt if len(t) > 1 else np.zeros_like(t)
    vn = np.gradient(my) / dt if len(t) > 1 else np.zeros_like(t)
    speed = np.hypot(ve, vn)
    # Apparent wind: speed and from-direction relative to the bow.
    aws, awd = b["apparent_wind_speed"], b["apparent_wind_direction"]
    frm = np.radians((awd + heading) % 360.0)
    rel_e, rel_n = -aws * np.sin(frm), -aws * np.cos(frm)
    air_e, air_n = rel_e + ve, rel_n + vn
    tws = np.hypot(air_e, air_n)
    twd = np.degrees(np.arctan2(-air_e, -air_n)) % 360.0
    twd = np.where(np.isnan(awd), np.nan, twd)
    elevation = b["alt"] - ANTENNA_HEIGHT_M
    p_red = b["pressure"] + PRESSURE_LAPSE_HPA_PER_M * elevation
    dp = dew_point(b["air_temperature"], b["relative_humidity"])
    # Lag correction: the stern reaches the bow's position L / v seconds later.
    L = float(np.nanmedian(separation)) if np.isfinite(separation).any() else chart.separation
    moving = speed > 0.3
    lag = np.where(moving, L / np.maximum(speed, 0.3), 0.0)
    out = {
        "t": t, "lon": b["lon"], "lat": b["lat"],
        "heading": heading, "speed": speed,
        "true_wind_speed": tws, "true_wind_direction": twd,
        "pressure_reduced": p_red, "dew_point": dp,
        "air_minus_water": b["air_temperature"] - b["water_temperature"],
        "separation_estimate_m": L,
    }
    for p in ("air_temperature", "relative_humidity", "water_temperature"):
        raw = b[p] - s[p]
        ok = ~np.isnan(s[p])
        if ok.sum() > 1:
            stern_at = np.interp(t + lag, t[ok], s[p][ok], left=np.nan, right=np.nan)
        else:
            stern_at = np.full(len(t), np.nan)
        out[f"bow_minus_stern_{p}"] = raw
        out[f"bow_minus_stern_{p}_lag_corrected"] = b[p] - stern_at
    # Keep the bow's raw readings alongside, for clustering and correlation.
    for p in PARAMS:
        out[p] = b[p]
    out["chainage"] = chart.chainage(bx, by)
    return out


# --- correlation (FR-21) ----------------------------------------------------

def correlation(series: dict, names: list[str]):
    X = np.column_stack([series[n] for n in names])
    ok = ~np.isnan(X).any(axis=1)
    X = X[ok]
    if len(X) < 3:
        return np.full((len(names), len(names)), np.nan), int(len(X))
    sd = X.std(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        R = np.corrcoef(X, rowvar=False)
    R[:, sd == 0] = np.nan
    R[sd == 0, :] = np.nan
    return R, int(len(X))


# --- separating place from weather (FR-22) ----------------------------------

def _moving_mean_time(t, y, width_s):
    """Mean of y over a centred window in time, ignoring NaN (t sorted)."""
    ok = ~np.isnan(y)
    c = np.concatenate([[0.0], np.cumsum(np.where(ok, y, 0.0))])
    n = np.concatenate([[0], np.cumsum(ok)])
    lo = np.searchsorted(t, t - width_s / 2, "left")
    hi = np.searchsorted(t, t + width_s / 2, "right")
    cnt = n[hi] - n[lo]
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(cnt > 0, (c[hi] - c[lo]) / np.maximum(cnt, 1), np.nan)


def decompose(t, y, reach, chart: Chart, iterations: int = 6):
    """y = weather(t) + place(reach) + noise, by backfitting.

    Place offsets are relative to the open reaches (the chart's convention:
    open embankment is the reference).
    """
    nr = len(chart.reaches)
    p = np.zeros(nr)
    open_mask = np.array([r["kind"] == "open" for r in chart.reaches])
    for _ in range(iterations):
        w = _moving_mean_time(t, y - p[reach], WEATHER_SMOOTH_S)
        resid = y - w
        ok = ~np.isnan(resid)
        sums = np.bincount(reach[ok], resid[ok], minlength=nr)
        cnts = np.bincount(reach[ok], minlength=nr)
        p = np.where(cnts > 0, sums / np.maximum(cnts, 1), 0.0)
        ref = p[open_mask & (cnts > 0)]
        p = p - (ref.mean() if len(ref) else 0.0)
    w = _moving_mean_time(t, y - p[reach], WEATHER_SMOOTH_S)
    return w, p


def passes(t, reach, nr):
    """Number of separate passes through each reach (runs of consecutive records)."""
    out = np.zeros(nr, dtype=int)
    if len(reach) == 0:
        return out
    new_run = np.concatenate([[True], (np.diff(reach) != 0) | (np.diff(t) > 60)])
    np.add.at(out, reach[new_run], 1)
    return out


def reach_offsets(d: dict, chart: Chart) -> dict:
    t = d["t"]
    reach = chart.reach_index(d["chainage"])
    nr = len(chart.reaches)
    n_pass = passes(t, reach, nr)
    res = {"reach": [r["id"] for r in chart.reaches], "passes": n_pass}
    for p in OFFSET_PARAMS:
        w, off = decompose(t, d[p], reach, chart)
        res[p] = off
        # Standard error from the scatter of per-pass means about the offset.
        resid = d[p] - w
        new_run = np.concatenate([[True], (np.diff(reach) != 0) | (np.diff(t) > 60)])
        run_id = np.cumsum(new_run) - 1
        ok = ~np.isnan(resid)
        run_mean = np.bincount(run_id[ok], resid[ok]) / np.maximum(np.bincount(run_id[ok]), 1)
        run_reach = reach[new_run][: len(run_mean)]
        se = np.full(nr, np.nan)
        for r in range(nr):
            m = run_mean[run_reach == r]
            if len(m) > 1:
                se[r] = m.std(ddof=1) / math.sqrt(len(m))
        res[f"{p}_se"] = se
    return res


# --- change detection (FR-21, FR-22) ------------------------------------------

def _noise(y):
    """Reading-to-reading noise, robust to steps and to quantised values."""
    d = np.diff(y)
    if len(d) < 3:
        return 1.0
    cut = np.percentile(np.abs(d), 98)
    core = d[np.abs(d) <= cut]
    return float(np.sqrt(np.mean(core ** 2)) / math.sqrt(2)) + 1e-6


def _step_stat(t, y, half_s, grid):
    """Standardised step at each grid time, with any local linear trend removed.

    Uses four windows of length half_s: far-before, before, after, far-after.
    step = (after - before) - ((before - far_before) + (far_after - after)) / 2
    A steady trend contributes nothing; a step contributes 1.5x its height.
    """
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
    valid = n_min > 5
    noise = _noise(yy)
    z = np.abs(step) / (noise * np.sqrt(5.0 / np.maximum(n_min, 1)))
    return np.where(valid, z, 0.0)


def _peaks(grid, score, threshold, min_gap_s):
    idx = np.flatnonzero(score > threshold)
    picked = []
    for i in idx[np.argsort(-score[idx])]:
        if all(abs(grid[i] - grid[j]) > min_gap_s for j in picked):
            picked.append(i)
    return sorted(picked)


def detect_changes(d: dict, chart: Chart, sensitivity: float) -> dict:
    """Sustained changes, each attributed to place or weather.

    Place changes are steps over minutes in temperature, humidity and water
    temperature. A step is attributed to place when the reach offsets fitted
    from all passes explain most of it; otherwise to weather. Weather changes
    on the scale of fronts are steps over hours in quantities with no diurnal
    cycle: pressure reduced to datum, dew point and the true wind vector.
    """
    t = d["t"]
    if len(t) < 600:
        return {"t": np.array([]), "cause": np.array([], dtype=int), "strength": np.array([]),
                "lon": np.array([]), "lat": np.array([]), "scale": np.array([], dtype=int)}
    reach = chart.reach_index(d["chainage"])
    offsets = {p: decompose(t, d[p], reach, chart)[1] for p in OFFSET_PARAMS}
    # Short scale: steps over two minutes.
    g1 = np.arange(t[0] + 120, t[-1] - 120, 5.0)
    zs = np.sqrt(np.mean([_step_stat(t, d[p], 120.0, g1) ** 2 for p in OFFSET_PARAMS], axis=0))
    thr_short = 60.0 / sensitivity
    short_idx = _peaks(g1, zs, thr_short, 240.0)
    # Long scale: steps over 45 minutes in quantities free of the diurnal cycle.
    g2 = np.arange(t[0] + 2700, t[-1] - 2700, 60.0)
    ve = d["true_wind_speed"] * np.sin(np.radians(d["true_wind_direction"]))
    vn = d["true_wind_speed"] * np.cos(np.radians(d["true_wind_direction"]))
    smooth = lambda y: _moving_mean_time(t, y, 600.0)
    zl_parts = []
    for y in (d["pressure_reduced"], d["dew_point"], ve, vn):
        ys = smooth(y)
        zl_parts.append(_step_stat(t[::30], ys[::30], 2700.0, g2))
    # Normalise: per-quantity z from a smoothed series is inflated; use ranks
    # of a robust scale instead.
    zl = np.sqrt(np.mean([z / (np.median(z) + 1e-9) for z in zl_parts], axis=0) ** 2)
    thr_long = 16.0 / sensitivity
    long_idx = _peaks(g2, zl, thr_long, 3 * 3600.0)

    times, cause, strength, scale = [], [], [], []
    for i in short_idx:
        tc = g1[i]
        before = (t >= tc - 120) & (t < tc)
        after = (t >= tc) & (t < tc + 120)
        explained, observed = 0.0, 0.0
        for p in OFFSET_PARAMS:
            ob = np.nanmean(d[p][after]) - np.nanmean(d[p][before])
            rb = np.bincount(reach[before], minlength=len(chart.reaches)).argmax()
            ra = np.bincount(reach[after], minlength=len(chart.reaches)).argmax()
            ex = offsets[p][ra] - offsets[p][rb]
            sd = np.nanstd(d[p]) + 1e-9
            observed += (ob / sd) ** 2
            explained += (min(abs(ex), abs(ob)) * (1 if ex * ob > 0 else 0) / sd) ** 2
        is_place = observed > 0 and explained / observed > 0.25
        times.append(tc)
        cause.append(0 if is_place else 1)
        strength.append(float(zs[i]))
        scale.append(0)
    for i in long_idx:
        times.append(g2[i])
        cause.append(1)
        strength.append(float(zl[i]))
        scale.append(1)
    order = np.argsort(times)
    times = np.asarray(times)[order] if times else np.array([])
    lon = np.interp(times, t, d["lon"]) if len(times) else np.array([])
    lat = np.interp(times, t, d["lat"]) if len(times) else np.array([])
    return {
        "t": times,
        "cause": np.asarray(cause, dtype=int)[order] if cause else np.array([], dtype=int),
        "strength": np.asarray(strength)[order] if strength else np.array([]),
        "scale": np.asarray(scale, dtype=int)[order] if scale else np.array([], dtype=int),
        "lon": lon, "lat": lat,
    }


# --- clustering (FR-21) -------------------------------------------------------

def kmeans(X: np.ndarray, k: int, iters: int = 50, seed: int = KMEANS_SEED):
    rng = np.random.default_rng(seed)
    n = len(X)
    centres = [X[rng.integers(n)]]
    for _ in range(1, k):
        d2 = np.min(((X[:, None, :] - np.array(centres)[None]) ** 2).sum(-1), axis=1)
        centres.append(X[rng.choice(n, p=d2 / d2.sum())] if d2.sum() > 0 else X[rng.integers(n)])
    centres = np.array(centres)
    labels = np.zeros(n, dtype=int)
    for _ in range(iters):
        d2 = ((X[:, None, :] - centres[None]) ** 2).sum(-1)
        new = d2.argmin(axis=1)
        if np.array_equal(new, labels) and _ > 0:
            break
        labels = new
        for j in range(k):
            if (labels == j).any():
                centres[j] = X[labels == j].mean(axis=0)
    return labels, centres


def cluster(d: dict, k: int, features=CLUSTER_FEATURES, step: int = 30):
    idx = np.arange(0, len(d["t"]), step)
    X = np.column_stack([d[f][idx] for f in features])
    ok = ~np.isnan(X).any(axis=1)
    idx, X = idx[ok], X[ok]
    if len(X) < k:
        return idx, np.zeros(len(idx), dtype=int)
    Z = (X - X.mean(axis=0)) / (X.std(axis=0) + 1e-9)
    labels, _ = kmeans(Z, k)
    return idx, labels
