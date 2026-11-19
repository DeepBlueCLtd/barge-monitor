"""FR-16..FR-19 and AT-01 against the app in-process."""
import numpy as np

from barge import config as C
from barge import covjson as CJ
from tests.helpers import Rig


def test_at01_trajectory_matches_ground_truth_while_logger_grows():
    rig = Rig(seed=8, start_hours=2)
    w = rig.sim.world
    for step in range(3):
        rig.clock.advance(1800)  # the logger grows between queries
        now = rig.sim.clock.now()
        t = np.arange(now - 1200, now - 1, 60.0)
        tr = w.sensor_truth(t, "bow")
        from barge.world import _local_to_lonlat

        lon, lat = _local_to_lonlat(tr["x"], tr["y"])
        coords = "LINESTRINGM(" + ",".join(
            f"{x:.7f} {y:.7f} {tt + C.SIM_EPOCH_UNIX:.0f}" for x, y, tt in zip(lon, lat, t)) + ")"
        st, cov, _ = rig.get("/collections/bow/trajectory", {"coords": coords})
        assert st == 200, cov
        times = np.array([CJ.parse_iso(v[0]) for v in cov["domain"]["axes"]["composite"]["values"]])
        assert len(times) > 1000  # nearly every second of the 20 minutes
        truth = w.sensor_truth(times, "bow")
        sigma = rig.sim.manifest["noise"]["sigma"]
        for p in ("air_temperature", "relative_humidity", "pressure", "water_temperature"):
            v = np.array(cov["ranges"][p]["values"], dtype=float)
            qc = np.array(cov["ranges"][f"{p}_qc"]["values"])
            good = qc == 0
            err = np.abs(v[good] - truth[p][good])
            assert np.nanmax(err) <= 6 * sigma[p] + 0.5 * (1 if p == "relative_humidity" else 0.1), p
        # Responses reflect the store at the moment of the request (FR-18).
        assert times.max() >= now - 61


def test_spikes_are_flagged_not_removed():
    rig = Rig(seed=9)
    rig.clock.advance(12 * 3600)
    st, cov, _ = rig.get("/collections/bow/trajectory", {"coords": rig.route()})
    assert st == 200
    found = 0
    for p in ("air_temperature", "pressure", "water_temperature"):
        qc = np.array(cov["ranges"][f"{p}_qc"]["values"])
        v = np.array(cov["ranges"][p]["values"], dtype=float)
        spikes = qc == 1
        found += spikes.sum()
        assert np.all(np.isfinite(v[spikes]))  # raw values remain retrievable
    assert found > 0


def test_gps_dropout_in_tunnel_is_flagged_and_filled():
    rig = Rig(seed=9)
    rig.clock.advance(12 * 3600)
    st, cov, _ = rig.get("/collections/bow/trajectory", {"coords": rig.route(), "parameter-name": "air_temperature"})
    pq = np.array(cov["ranges"]["position_qc"]["values"])
    assert (pq == 1).sum() > 100
    xy = np.array([[v[1], v[2]] for v in cov["domain"]["axes"]["composite"]["values"]], dtype=float)
    assert np.isfinite(xy).all()


def test_too_large_is_refused_naming_limit():
    rig = Rig(seed=1)
    rig.clock.advance(3 * 86400)
    st, body, _ = rig.get("/collections/bow/trajectory", {"coords": rig.route()})
    assert st == 413 and body["refused"] == "size"
    assert body["limit"] == C.MAX_RESPONSE_POINTS and "datetime" in body["description"]


def test_declared_queries_meet_budget_after_a_week_and_rebuild_identically():
    """AT-07, scaled to one week in CPython (the browser figure is measured in e2e)."""
    import time

    rig = Rig(seed=10)
    rig.clock.advance(7 * 86400)
    rig.get("/sim/clock")  # generate and index
    canal = rig.app.canal
    tun = next(r for r in canal["reaches"] if r["kind"] == "tunnel")
    ch = np.asarray(canal["centreline"]["chainage"])
    s = np.linspace(tun["start"], tun["end"], 5)
    lon = np.interp(s, ch, canal["centreline"]["lon"])
    lat = np.interp(s, ch, canal["centreline"]["lat"])
    reach = "LINESTRING(" + ",".join(f"{x} {y}" for x, y in zip(lon, lat)) + ")"
    now = rig.sim.clock.now()
    hour = CJ.iso1(now - 3600) + "/.."
    queries = {
        "last-hour-along-route": ("/collections/bow/trajectory", {"coords": rig.route(), "datetime": hour}),
        "one-reach-all-passes": ("/collections/bow/corridor",
                                 {"coords": reach, "corridor-width": "40", "width-units": "m",
                                  "parameter-name": "air_temperature"}),
    }
    first = {}
    for name, (path, params) in queries.items():
        t0 = time.perf_counter()
        st, body, _ = rig.get(path, params)
        ms = (time.perf_counter() - t0) * 1000
        assert st == 200, body
        assert ms < C.QUERY_BUDGET_MS[name], (name, ms)
        first[name] = body
    rig.app.handle("DELETE", "/sim/index", "", b"")
    for name, (path, params) in queries.items():
        st, body, _ = rig.get(path, params)
        assert body == first[name], name
