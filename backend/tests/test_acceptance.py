"""Acceptance tests that run in CPython (SRD §14). Browser halves are in web/e2e."""
import time

import numpy as np
import pytest

from barge import config as C
from barge.server import iso, parse_iso
from tests.helpers import Rig


@pytest.fixture(scope="module")
def rig():
    return Rig(seed=12, days=3)


def ids(r):
    return {d["outputName"] + "@" + d["system@id"]: d["id"] for d in r.get("/datastreams")[1]["items"]}


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
        assert t.max() >= r.clock.now() - 2  # the store as it stands now
        truth = w.sensor_truth(t, "bow")
        for p in ("air_temperature", "relative_humidity", "pressure", "water_temperature"):
            v = np.array([o[p] for o in obs], dtype=float)
            good = np.array([o[f"{p}_qc"] == "1" for o in obs])
            q = 0.5 if p == "relative_humidity" else 0.05
            assert np.nanmax(np.abs(v[good] - truth[p][good])) <= 6 * sigma[p] + q, p


def test_at03_a_second_store_format_changes_the_adapter_only():
    """The same run over two stores: the first logger's fixed-width daily files, and a second, differently
    awkward one. Only the store's own writer and the store adapter differ; the data server, FastAPI, the
    models and every response are the same."""
    from tests.second_store import Format, SecondStoreAdapter

    first = Rig(seed=8, days=0.2)
    second = Rig(seed=8, days=0.2, store_format=Format(), adapter_class=SecondStoreAdapter)
    names = [n for n, _ in second.rt.logger.list_files()]
    assert names and all(n.endswith(".csv") for n in names)  # really the other store
    assert second.rt.logger.read(names[0]).startswith(b"serial;")
    for r in (first, second):
        r.advance(900)  # both stores grow
    w, sigma = second.rt.world, second.rt.manifest["noise"]["sigma"]
    d = second.ds("bow", "weather")
    st, obs, _ = second.get(f"/datastreams/{d['id']}/observations", {"phenomenonTime": "2031-04-07T04:00:00Z/..", "limit": "100000"})
    assert st == 200
    t = np.array([parse_iso(o["time"]) for o in obs])
    assert t.max() >= second.clock.now() - 2 and np.all(np.diff(t) == 1.0)
    truth = w.sensor_truth(t, "bow")
    for p in ("air_temperature", "relative_humidity", "pressure", "water_temperature"):  # AT-01 still passes
        v = np.array([o[p] for o in obs], dtype=float)
        good = np.array([o[f"{p}_qc"] == "1" for o in obs])
        assert np.nanmax(np.abs(v[good] - truth[p][good])) <= 6 * sigma[p] + (0.5 if p == "relative_humidity" else 0.05), p
    # Nothing above the adapter can tell the stores apart: sensors, models and discovery answer identically.
    for path, params in ((f"/datastreams/{d['id']}/observations", {"limit": "5000"}),
                         (f"/datastreams/{second.ds('stern', 'weather')['id']}/observations", {"resultTime": "latest"}),
                         (f"/datastreams/{second.ds('summaries', 'summary-1min-bow')['id']}/observations", {"limit": "500"}),
                         ("/datastreams", {"limit": "100"}), ("/systems/models/subsystems", None)):
        assert second.get(path, params)[2].content == first.get(path, params)[2].content, path
    second.rt.restart_server(); second.ready()  # the index is rebuilt from the second store, with identical results
    assert second.get(f"/datastreams/{d['id']}/observations", {"limit": "5000"})[2].content == \
        first.get(f"/datastreams/{d['id']}/observations", {"limit": "5000"})[2].content


def test_at13_a_new_model_registers_itself_and_is_served_by_schema_type():
    """The example for an empty slot, run as any model runs: it creates its own system and datastream with
    ordinary HTTP requests, and discovery then offers its output with no change to the server."""
    r = Rig(seed=14, days=0.2)
    import example_new_model  # backend/models is on the path once the in-process models are loaded
    before = {d["id"] for d in r.get("/datastreams", {"limit": "100"})[1]["items"]}
    runner = r.rt.local.add(example_new_model.MODEL())
    for _ in range(20):
        r.advance(60)
        if runner.phase == "live":
            break
    assert runner.phase == "live", runner.detail
    assert "new-model-1" in {s["id"] for s in r.get("/systems/models/subsystems")[1]["items"]}
    d = r.ds("new-model-1", "wind-chill")
    assert d["id"] not in before
    fields = r.get(f"/datastreams/{d['id']}/schema", {"obsFormat": "application/swe+json"})[1]["recordSchema"]["fields"]
    assert [(f["name"], f["type"]) for f in fields] == [("time", "Time"), ("wind_chill", "Quantity")]
    obs = r.get(f"/datastreams/{d['id']}/observations", {"limit": "5"})[1]
    assert len(obs) == 5 and all(isinstance(o["wind_chill"], float) for o in obs)
    r.rt.tap.drain()
    for _ in range(18):
        r.advance(10)  # now live: its traffic is drawn
    made = [m for m in r.rt.tap.drain() if m.get("model") == "new-model-1" and m["src"] == "models"]
    assert made and all(m["dst"] in ("fastapi", "scilibs") for m in made)  # HTTP and the libraries: no other way in


def test_at04_declared_queries_meet_budget_and_rebuild_identically():
    """AT-04 at one week: CI loads a week of history (decision D-37); four weeks is published."""
    r = Rig(seed=14, days=7)
    d = {s: r.ds(s, "weather")["id"] for s in ("bow", "stern")}
    now = r.clock.now()
    hour = f"{iso(now - 3600)}/.."
    t0 = time.perf_counter()
    last = {s: r.get(f"/datastreams/{d[s]}/observations", {"phenomenonTime": hour, "limit": "4000"})[2].content for s in d}
    assert (time.perf_counter() - t0) * 1000 < C.QUERY_BUDGET_MS["last-hour-each-sensor"]
    t0 = time.perf_counter()
    summary = r.ds("summaries", "summary-1h-bow")["id"]
    st, obs, _ = r.get(f"/datastreams/{summary}/observations", {"phenomenonTime": f"{iso(now - 28 * 86400)}/..", "limit": "1000"})
    assert (time.perf_counter() - t0) * 1000 < C.QUERY_BUDGET_MS["one-field-four-weeks-summary"]
    assert st == 200 and len(obs) >= 7 * 24 - 2
    r.rt.restart_server(); r.ready()  # the index is dropped and rebuilt from the store
    d2 = {s: r.ds(s, "weather")["id"] for s in ("bow", "stern")}
    again = {s: r.get(f"/datastreams/{d2[s]}/observations", {"phenomenonTime": hour, "limit": "4000"})[2].content for s in d}
    assert again == last


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
    assert pid in conf()  # a misconfigured server claims it anyway: the client must catch this (AT-08)


def test_at10_restart_server_waiting_mode_and_no_records_lost():
    r = Rig(seed=6, days=0.5)
    st, _, resp = r.get("/")
    first = resp.headers["x-server-instance"]
    r.rt.restart_server()
    st, body, resp = r.get("/datastreams")
    assert st == 503 and resp.headers["retry-after"] == str(C.RETRY_AFTER_S)
    assert all(not rr.ready or rr.phase == "live" for rr in r.rt.local.runners)  # the models carry on
    r.clock.play()
    r.clock.advance(120)
    r.rt.sensors.sample_until(r.clock.now() + 1)  # the store keeps receiving records (FR-18)
    r.ready()
    st, _, resp = r.get("/")
    assert st == 200 and resp.headers["x-server-instance"] != first
    d2 = r.ds("stern", "weather")
    obs = r.get(f"/datastreams/{d2['id']}/observations", {"phenomenonTime": "2031-04-07T11:50:00Z/..", "limit": "100000"})[1]
    t = np.array([parse_iso(o["time"]) for o in obs])
    assert np.all(np.diff(t) == 1.0) and t.max() >= 12 * 3600 + 110
    assert r.ds("analysis", "runs")  # the models' resources outlive the restart (D-11)


def test_at11_server_down_is_no_answer_store_and_models_carry_on():
    import asyncio

    from barge.bridge import Bridge

    b = Bridge(seed=13, pregen_days=0.05)
    n = b.rt.sensors.next_t
    b.control("down")
    assert asyncio.run(b.handle("GET", "/", "", None, "")) is None
    from barge.local_models import LocalModels, csmodel

    with pytest.raises(csmodel.Unavailable):  # a model gets no answer either, and tries again on its next step
        asyncio.run(LocalModels(b.rt, classes=())._transport("GET", "/systems", {}, None))
    b.rt.clock.play()
    b.rt.clock._sim += 30
    b.rt.tick()
    assert b.rt.sensors.next_t > n  # FR-18: sensors and store carry on
    b.control("up")
    while not b.rt.server.ready:
        b.rt.tick()
    st, headers, _ = asyncio.run(b.handle("GET", "/", "", None, ""))
    assert st == 200


def test_at12_field_toggles_apply_only_at_next_start_and_restore_history():
    r = Rig(seed=11, days=0.5)
    schema = lambda dsid: [f["name"] for f in r.get(f"/datastreams/{dsid}/schema", {"obsFormat": "application/swe+json"})[1]["recordSchema"]["fields"]]
    before = ids(r)
    r.rt.set_field("relative_humidity", False)
    for x in ("precipitation_type", "pressure_tendency_3h", "readings_removed"):
        r.rt.set_field(x, True)
    assert ids(r) == before  # nothing changes while running (FR-51)
    assert r.rt.control_state()["pending"]
    r.rt.restart_server(); r.ready()
    after = ids(r)
    assert after["weather@bow"] != before["weather@bow"]  # a new schema, a new identifier
    assert "relative_humidity" not in schema(after["weather@bow"])
    assert "relative_humidity" not in schema(after["summary-1min-bow@summaries"])
    derived = schema(after["derived-1min@summaries"])
    assert "dew_point" not in derived  # its inputs are off (FR-52)
    assert "pressure_tendency_3h" in derived and "bow_minus_stern" in derived
    assert "readings_removed" in schema(after["summary-1h-bow@summaries"])
    assert "precipitation_type" in schema(after["weather@bow"])
    r.rt.set_field("relative_humidity", True)
    for x in ("precipitation_type", "pressure_tendency_3h", "readings_removed"):
        r.rt.set_field(x, False)
    r.rt.restart_server(); r.ready()
    again = ids(r)
    assert again["weather@bow"] == before["weather@bow"]
    obs = r.get(f"/datastreams/{again['weather@bow']}/observations", {"limit": "5"})[1]
    assert obs[0]["time"] == "2031-04-07T00:00:00Z" and "relative_humidity" in obs[0]  # full history restored


def test_at14_a_failing_or_stuck_model_leaves_the_rest_running():
    import csmodel

    class Broken(csmodel.Model):
        id, label, interval = "new-model-1", "New model 1", 10.0

        async def step(self, api, t0, t1):
            raise RuntimeError("a bug in a new model")

    r = Rig(seed=15, days=0.1)
    broken = r.rt.local.add(Broken())
    r.advance(120)
    assert broken.phase == "failed"
    assert all(x.phase == "live" for x in r.rt.local.runners if x is not broken)
    assert r.get("/")[0] == 200
    assert "new-model-1" in {s["id"] for s in r.get("/systems/models/subsystems")[1]["items"]}  # it registered first


def test_at15_models_other_than_data_cleanse_read_only_its_output():
    r = Rig(seed=16, days=0.2)
    r.rt.tap.drain()
    cs = {c["system@id"]: c["id"] for c in r.get("/controlstreams")[1]["items"]}
    for period in ("PT1H", "P1D", "P7D"):
        r.request("POST", f"/controlstreams/{cs['analysis']}/commands",
                  json={"parameters": {"period": period, "fields": "air_temperature,dew_point"}})
    for _ in range(70):
        r.advance(10)
    owner = {d["id"]: d["system@id"] for d in r.get("/datastreams", {"limit": "1000"})[1]["items"]}
    reads = [m for m in r.rt.tap.drain() if m["src"] == "models" and m["dst"] == "fastapi" and "/observations?" in m["summary"]
             and " GET " in m["summary"]]
    by = {}
    for m in reads:
        ds = m["summary"].split("/datastreams/")[1].split("/")[0]
        by.setdefault(m["model"], set()).add(owner[ds])
    assert by["data-cleanse"] == {"bow", "stern"}
    assert by["summaries"] == {"data-cleanse"}
    assert by["analysis"] <= {"data-cleanse", "summaries"} and by["analysis"]


def test_at16_change_detection_and_clustering_recover_the_manifest(rig):
    cs = {c["system@id"]: c["id"] for c in rig.get("/controlstreams")[1]["items"]}
    runs = rig.ds("analysis", "runs")["id"]
    rig.request("POST", f"/controlstreams/{cs['analysis']}/commands",
                json={"parameters": {"period": "PT1H", "fields": "air_temperature,relative_humidity,water_temperature",
                                     "algorithm": "A", "sensitivity": 6}})
    rig.advance(2)  # the model looks at its control stream once a simulated second
    hour = rig.get(f"/datastreams/{runs}/observations", {"resultTime": "latest"})[1][0]
    assert hour["period"] == "PT1H" and hour["scored_against"] == "reach kinds"
    assert hour["score_changes"] is None or hour["score_changes"] >= 0.5, hour
    rig.request("POST", f"/controlstreams/{cs['analysis']}/commands",
                json={"parameters": {"period": "P7D", "fields": "air_temperature,pressure,dew_point", "algorithm": "B"}})
    rig.advance(2)
    week = rig.get(f"/datastreams/{runs}/observations", {"resultTime": "latest"})[1][0]
    assert week["period"] == "P7D" and week["scored_against"] == "air masses"
    assert week["score_clusters"] > 0.2, week  # clusters follow air masses
    changes = rig.get(f"/datastreams/{rig.ds('analysis', 'changes')['id']}/observations", {"limit": "1000"})[1]
    assert all(c["run_id"] == week["run_id"] for c in changes)


def test_at18_capture_changes_nothing_and_every_busy_boundary_is_tapped():
    bodies = []
    for capture in (True, False):
        r = Rig(seed=9, days=0.3, capture=capture)
        for _ in range(9):
            r.advance(10)
        out = [r.get(f"/datastreams/{r.ds('bow', 'weather')['id']}/observations", {"limit": "50"})[2].content,
               r.get(f"/datastreams/{r.ds('summaries', 'summary-1min-bow')['id']}/observations", {"limit": "50"})[2].content,
               bytes(r.rt.logger.read(r.rt.logger.list_files()[0][0]))]
        cs = {c["system@id"]: c["id"] for c in r.get("/controlstreams")[1]["items"]}
        r.request("POST", f"/controlstreams/{cs['analysis']}/commands", json={"parameters": {"algorithm": "A"}})
        r.advance(2)
        bodies.append(out)
        if capture:
            keys = {k.split(":")[0] for k in r.rt.tap.counts}
            for edge in ("platform>store", "server>adapter", "adapter>store", "store>adapter", "adapter>server",
                         "models>fastapi", "fastapi>models", "models>scilibs", "scilibs>models",
                         "fastapi>server", "server>fastapi", "client>fastapi", "fastapi>client"):
                assert edge in keys, edge
            assert all(m["letter"] in "QDOKPHSLI" for m in r.rt.tap.drain())
    assert bodies[0] == bodies[1]


def test_at19_paused_means_silent_and_play_resumes_as_if_never_paused():
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
