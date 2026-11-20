"""Acceptance tests that run in CPython (SRD §12). Browser halves are in web/e2e."""
import math
import time

import numpy as np
import pytest

from barge import config as C
from barge.server import parse_iso
from tests.helpers import Rig


@pytest.fixture(scope="module")
def rig():
    return Rig(seed=12, days=3)


def test_at01_observations_match_ground_truth_while_store_grows():
    r = Rig(seed=8, days=0.5)
    w = r.rt.world
    sigma = r.rt.manifest["noise"]["sigma"]
    d = r.ds("bow", "weather")
    for _ in range(3):
        r.advance(900)  # the store grows between requests
        st, obs, _ = r.get(f"/datastreams/{d['id']}/observations", {"phenomenonTime": "2031-04-07T11:00:00Z/..", "limit": "100000"})
        assert st == 200
        t = np.array([parse_iso(o["time"]) for o in obs])
        assert t.max() >= r.clock.now() - 2  # FR-28: the store as it stands now
        truth = w.sensor_truth(t, "bow")
        for p in ("air_temperature", "relative_humidity", "pressure", "water_temperature"):
            v = np.array([o[p] for o in obs], dtype=float)
            good = np.array([o[f"{p}_qc"] == "1" for o in obs])
            q = 0.5 if p == "relative_humidity" else 0.05
            assert np.nanmax(np.abs(v[good] - truth[p][good])) <= 6 * sigma[p] + q, p


def test_at04_detector_and_clustering_recover_truth_with_reported_scores(rig):
    cs = rig.get("/controlstreams")[1]["items"][0]["id"]
    r = rig.request("POST", f"/controlstreams/{cs}/commands", json={"parameters": {"window_hours": 72, "sensitivity": 6}})
    assert r.status_code == 201, r.text
    runs = rig.ds("analysis", "runs")
    run = rig.get(f"/datastreams/{runs['id']}/observations", {"resultTime": "latest"})[1][0]
    assert run["window_hours"] == 72
    assert run["score_boundary_recall"] >= 0.8, run
    assert run["score_boundary_precision"] >= 0.8, run
    assert run["score_ari_air_mass"] > run["score_ari_reach_kind"], run  # weather dominates the readings
    det = rig.get(f"/datastreams/{rig.ds('analysis', 'changes')['id']}/observations", {"limit": "1000"})[1]
    assert det and all(o["run_id"] == run["run_id"] for o in det)


def test_at07_server_side_profile_claim_is_honest_unless_misconfigured():
    r = Rig(seed=4, days=0.2)
    conf = lambda: r.get("/conformance")[1]["conformsTo"]
    pid = r.get("/profile")[1]["id"]
    assert pid in conf()
    r.rt.set_field("air_temperature", False)
    r.rt.restart_server(); r.ready()
    assert pid not in conf()  # an honest server drops the claim it cannot meet
    r.rt.set_profile_lie(True)
    r.rt.restart_server(); r.ready()
    assert pid in conf()  # a misconfigured server claims it anyway: the client must catch this


def test_at09_restart_server_waiting_mode_and_no_records_lost():
    r = Rig(seed=6, days=0.5)
    d = r.ds("stern", "weather")
    st, _, resp = r.get("/")
    first = resp.headers["x-server-instance"]
    r.rt.restart_server()
    st, body, resp = r.get("/datastreams")
    assert st == 503 and resp.headers["retry-after"] == str(C.RETRY_AFTER_S)
    r.clock.play()
    r.clock.advance(120)
    r.rt.sensors.sample_until(r.clock.now() + 1)  # the store keeps receiving records (FR-20)
    r.ready()
    st, _, resp = r.get("/")
    assert st == 200 and resp.headers["x-server-instance"] != first
    d2 = r.ds("stern", "weather")
    obs = r.get(f"/datastreams/{d2['id']}/observations", {"phenomenonTime": "2031-04-07T11:50:00Z/..", "limit": "100000"})[1]
    t = np.array([parse_iso(o["time"]) for o in obs])
    assert np.all(np.diff(t) == 1.0) and t.max() >= 12 * 3600 + 110


def test_at10_capture_changes_nothing_and_every_busy_boundary_is_tapped():
    bodies = []
    for capture in (True, False):
        r = Rig(seed=9, days=0.3, capture=capture)
        r.advance(30)
        d = r.ds("bow", "weather")
        der = r.ds("analysis", "derived")
        out = [r.get(f"/datastreams/{d['id']}/observations", {"limit": "50"})[2].content,
               r.get(f"/datastreams/{der['id']}/observations", {"limit": "50"})[2].content,
               bytes(r.rt.logger.read(r.rt.logger.list_files()[0][0]))]
        bodies.append(out)
        if capture:
            keys = {k.split(":")[0] for k in r.rt.tap.counts}
            for edge in ("clock>barge", "barge>sensors", "world>sensors", "sensors>logger", "relay>fastapi",
                         "fastapi>server", "server>adapter", "adapter>logger", "logger>adapter", "adapter>server",
                         "server>fastapi", "fastapi>relay", "server>analysis", "analysis>scilibs", "scilibs>analysis",
                         "analysis>server"):
                assert edge in keys, edge
            assert all(m["letter"] in "QDOKPHLI" for m in r.rt.tap.drain())
    assert bodies[0] == bodies[1]


def test_at11_paused_means_silent_and_play_resumes_as_if_never_paused():
    r = Rig(seed=10, days=0.1)
    r.rt.tap.drain()
    n = r.rt.sensors.next_t
    for _ in range(5):
        r.rt.tick()  # the clock is off: nothing advances, nothing is sent
    assert r.rt.sensors.next_t == n and r.rt.tap.drain() == []
    r.clock.play(); r.clock.advance(100); r.rt.tick()
    a = r.rt.logger.read(r.rt.logger.list_files()[0][0])
    s = Rig(seed=10, days=0.1)
    s.clock.play(); s.clock.advance(50); s.rt.tick(); s.clock.pause(); s.rt.tick()
    s.clock.play(); s.clock.advance(50); s.rt.tick()
    b = s.rt.logger.read(s.rt.logger.list_files()[0][0])
    assert a == b


def test_at14_field_toggles_apply_only_at_next_start_and_restore_history():
    r = Rig(seed=11, days=0.5)
    ids = lambda: {d["outputName"] + "@" + d["system@id"]: d["id"] for d in r.get("/datastreams")[1]["items"]}
    schema = lambda dsid: [f["name"] for f in r.get(f"/datastreams/{dsid}/schema", {"obsFormat": "application/swe+json"})[1]["recordSchema"]["fields"]]
    before = ids()
    r.rt.set_field("relative_humidity", False)
    r.rt.set_field("pressure_tendency_3h", True)
    assert ids() == before  # nothing changes while running (FR-46d)
    assert r.rt.control_state()["pending"]
    r.rt.restart_server(); r.ready()
    after = ids()
    assert after["weather@bow"] != before["weather@bow"]  # a new schema, a new identifier (FR-46c)
    assert "relative_humidity" not in schema(after["weather@bow"])
    derived = schema(after["derived@analysis"])
    assert "dew_point" not in derived and "bow_minus_stern_relative_humidity" not in derived  # inputs off (FR-32a)
    assert "pressure_tendency_3h" in derived
    r.rt.set_field("relative_humidity", True)
    r.rt.restart_server(); r.ready()
    again = ids()
    assert again["weather@bow"] == before["weather@bow"]
    obs = r.get(f"/datastreams/{again['weather@bow']}/observations", {"limit": "5"})[1]
    assert obs[0]["time"] == "2031-04-07T00:00:00Z" and "relative_humidity" in obs[0]  # full history restored


def test_at15_server_down_is_no_answer_and_store_carries_on():
    import asyncio

    from barge.bridge import Bridge

    b = Bridge(seed=13, pregen_days=0.05)
    n = b.rt.sensors.next_t
    b.control("down")
    assert asyncio.run(b.handle("GET", "/", "", None, "")) is None
    b.rt.clock.play()
    b.rt.clock._sim += 30
    b.rt.tick()
    assert b.rt.sensors.next_t > n  # FR-20: sensors and store carry on
    b.control("up")
    while not b.rt.server.ready:
        b.rt.tick()
    st, headers, _ = asyncio.run(b.handle("GET", "/", "", None, ""))
    assert st == 200


def test_at05_a_week_of_history_declared_queries_meet_budget_and_rebuild_identically():
    """AT-05 at one week: CI loads a week of history (decision D-37); four weeks is published."""
    r = Rig(seed=14, days=7)
    d = {s: r.ds(s, "weather")["id"] for s in ("bow", "stern")}
    now = r.clock.now()
    hour = f"{_iso(now - 3600)}/.."
    t0 = time.perf_counter()
    last = {s: r.get(f"/datastreams/{d[s]}/observations", {"phenomenonTime": hour, "limit": "4000"})[2].content for s in d}
    assert (time.perf_counter() - t0) * 1000 < C.QUERY_BUDGET_MS["last-hour-each-sensor"]
    t0 = time.perf_counter()
    week, url, params = [], f"/datastreams/{d['bow']}/observations", {"phenomenonTime": f"{_iso(now - 7 * 86400)}/..", "limit": str(C.MAX_LIMIT)}
    while url:
        resp = r.request("GET", url, params)
        week += [o["water_temperature"] for o in resp.json()]
        link = resp.headers.get("link", "")
        url = link[1:link.index(">")] if link else None
        params = None
    assert (time.perf_counter() - t0) * 1000 < C.QUERY_BUDGET_MS["one-parameter-across-a-week"]
    assert len(week) >= 7 * 86400 - 2
    r.rt.restart_server(); r.ready()  # the index is dropped and rebuilt from the store
    d2 = {s: r.ds(s, "weather")["id"] for s in ("bow", "stern")}
    again = {s: r.get(f"/datastreams/{d2[s]}/observations", {"phenomenonTime": hour, "limit": "4000"})[2].content for s in d}
    assert again == last


def _iso(t):
    from barge.server import iso
    return iso(t)
