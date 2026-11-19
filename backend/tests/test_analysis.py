"""AT-04, AT-05, AT-06 and FR-23/FR-24: the analysis service, scored against the manifest."""
import math

import numpy as np

from barge import config as C
from tests.helpers import Rig

_RIG = {}


def rig(days=3, seed=12):
    key = (days, seed)
    if key not in _RIG:
        r = Rig(seed=seed)
        r.clock.advance(days * 86400)
        _RIG[key] = r
    return _RIG[key]


def analysis(r, cid, **params):
    params = {"coords": r.route(), **{k.replace("_", "-"): str(v) for k, v in params.items()}}
    st, body, _ = r.get(f"/collections/{cid}/trajectory", params)
    assert st == 200, body
    return body


def test_at04_detector_recovers_boundaries_and_attributes_cause():
    r = rig()
    body = analysis(r, "analysis-changes", window_hours=72)
    sc = body["barge:analysis"]["scores"]
    assert sc["reach_boundaries_crossed"] > 100
    # Known, reported scores: the test holds them to a floor, it does not hide them.
    assert sc["reach_boundary_recall"] >= 0.8, sc
    assert sc["precision"] >= 0.9, sc
    assert sc["attribution_rate"] >= 0.9, sc
    assert sc["fronts_in_window"] >= 1


def test_at04_sensitivity_trades_recall_for_precision():
    r = rig()
    lo = analysis(r, "analysis-changes", window_hours=72, sensitivity=2)["barge:analysis"]["scores"]
    hi = analysis(r, "analysis-changes", window_hours=72, sensitivity=9)["barge:analysis"]["scores"]
    assert hi["detections"] > lo["detections"]
    assert hi["reach_boundary_recall"] >= lo["reach_boundary_recall"]


def test_at04_clustering_is_scored_against_air_masses_and_reaches():
    r = rig()
    body = analysis(r, "analysis-clusters", window_hours=72, clusters=4)
    sc = body["barge:analysis"]["scores"]
    for k in ("ari_vs_reach", "ari_vs_air_mass", "ari_vs_reach_kind"):
        assert -1.0 <= sc[k] <= 1.0
    assert sc["samples"] > 1000
    # Weather dominates the readings, so regimes follow air masses more than reaches.
    assert sc["ari_vs_air_mass"] > sc["ari_vs_reach"]


def test_at05_lag_correction_brings_bow_minus_stern_to_the_noise_floor():
    r = rig()
    body = analysis(r, "analysis-derived", window_hours=72)
    sc = body["barge:analysis"]["scores"]["lag_correction"]
    sigma = r.sim.manifest["noise"]["sigma"]["air_temperature"]
    floor = math.sqrt(2) * sigma  # two independent readings
    quant = 0.1 / math.sqrt(12) * math.sqrt(2)  # the logger keeps tenths
    bound = math.sqrt(floor ** 2 + quant ** 2) * 1.15
    assert sc["air_temperature_rms_bow_minus_stern_lag_corrected"] <= bound, (sc, bound)
    assert sc["air_temperature_rms_bow_minus_stern_raw"] > sc["air_temperature_rms_bow_minus_stern_lag_corrected"]
    assert abs(sc["separation_error_m"]) < 0.5


def test_at05_true_wind_recovers_the_declared_wind():
    r = rig()
    sc = analysis(r, "analysis-derived", window_hours=24)["barge:analysis"]["scores"]["true_wind"]
    sig = r.sim.manifest["noise"]["sigma"]
    assert sc["speed_rmse_ms"] < 2.5 * sig["apparent_wind_speed"]
    assert sc["direction_rmse_deg_where_wind_over_2ms"] < 3 * sig["apparent_wind_direction"]


def _offset_errors(body, param):
    rows = body["barge:analysis"]["scores"]["reaches"]
    errs, bounds, passes = [], [], []
    for row in rows:
        se = row[param]["standard_error"]
        if se is None:
            continue
        errs.append(abs(row[param]["error"]))
        bounds.append(4 * se)
        passes.append(row["passes"])
    return np.array(errs), np.array(bounds), np.array(passes)


def test_at06_reach_offsets_recover_declared_effects_and_tighten():
    r = rig(days=4)
    short = analysis(r, "analysis-reach-offsets", window_hours=12)
    long = analysis(r, "analysis-reach-offsets", window_hours=96)
    sigma = r.sim.manifest["noise"]["sigma"]
    for p in ("air_temperature", "water_temperature"):
        e, b, n = _offset_errors(long, p)
        # Bound from the scatter of per-pass means (SE ~ 1/sqrt(passes)), with
        # the instrument noise as a floor.
        assert np.all(e <= b + 3 * sigma[p]), (p, e, b)
        es, bs, ns = _offset_errors(short, p)
        assert n.min() > ns.min()  # more passes
        assert np.median(b) < np.median(bs)  # and so a tighter bound
        assert e.mean() <= es.mean() + 3 * sigma[p]


def test_fr23_bounds_come_from_the_service():
    r = rig(days=1, seed=13)
    st, coll, _ = r.get("/collections/analysis-clusters")
    props = coll["barge:analysis_parameters"]["properties"]
    assert props["clusters"]["maximum"] == C.ANALYSIS_BOUNDS["clusters"]["maximum"]
    st, body, _ = r.get("/collections/analysis-clusters/trajectory",
                        {"coords": r.route(), "sensitivity": "11"})
    assert st == 400 and body["refused"] == "sensitivity" and "maximum 10" in body["description"]
