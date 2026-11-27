"""Acceptance tests that run in CPython (SRD §14). Browser halves are in web/e2e.

These are the Version 4.1 acceptance tests, kept while the 4.1 world and logger run, on a server that
now behaves as a configured stock OpenSensorHub (4.7, plan Phase 4): every request carries credentials,
observations are asked for with ``f=application/swe+json``, identifiers are opaque, there is no ``503``
and no instance identifier, and commands are pushed to the models. The models are 4.7's (plan Phase 6):
they process each imported dataset, so the tests that need their outputs run on the data folder, and
``test_models.py`` has the models' own."""
import time

import numpy as np
import pytest

from barge import config as C
from barge.api import ServerUnavailable
from barge.server import iso, parse_iso
from tests.helpers import Rig



def ids(r):
    names = {i: u.rsplit(":", 1)[-1] for u, i in r.systems().items()}
    return {d["outputName"] + "@" + names[d["system@id"]]: d["id"] for d in r.get("/datastreams")[1]["items"]}


def cs_of(r, system):
    return next(c["id"] for c in r.get("/controlstreams")[1]["items"] if c["system@id"] == r.sid(system))


def values(obs, p):
    return np.array([o[p] for o in obs], dtype=float)  # "NaN" reads as nan


def test_at01_observations_match_ground_truth_while_store_grows():
    r = Rig(seed=8, days=0.5)
    w = r.rt.world
    sigma = r.rt.manifest["noise"]["sigma"]
    d = r.ds("bow", "weather")
    for _ in range(3):
        r.advance(900)  # the store grows between requests
        obs = r.obs(d["id"], {"phenomenonTime": "2031-04-07T11:00:00Z/..", "limit": "100000"})
        t = np.array([parse_iso(o["time"]) for o in obs])
        assert t.max() >= r.clock.now() - 2  # the store as it stands now
        truth = w.sensor_truth(t, "bow")
        for p in ("air_temperature", "relative_humidity", "pressure", "water_temperature"):
            v = values(obs, p)
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
    obs = second.obs(d["id"], {"phenomenonTime": "2031-04-07T04:00:00Z/..", "limit": "100000"})
    t = np.array([parse_iso(o["time"]) for o in obs])
    assert t.max() >= second.clock.now() - 2 and np.all(np.diff(t) == 1.0)
    truth = w.sensor_truth(t, "bow")
    for p in ("air_temperature", "relative_humidity", "pressure", "water_temperature"):  # AT-01 still passes
        v = values(obs, p)
        good = np.array([o[f"{p}_qc"] == "1" for o in obs])
        assert np.nanmax(np.abs(v[good] - truth[p][good])) <= 6 * sigma[p] + (0.5 if p == "relative_humidity" else 0.05), p
    # Nothing above the adapter can tell the stores apart: sensors, models and discovery answer identically.
    swe = {"f": "application/swe+json"}
    for path, params in ((f"/datastreams/{d['id']}/observations", {"limit": "5000", **swe}),
                         (f"/datastreams/{second.ds('stern', 'weather')['id']}/observations", {"resultTime": "latest", **swe}),
                         ("/datastreams", {"limit": "100"}), (f"/systems/{second.sid('models')}/subsystems", None)):
        assert second.get(path, params)[2].content == first.get(path, params)[2].content, path
    second.rt.restart_server(); second.ready()  # the index is rebuilt from the second store, with identical results
    p = {"limit": "5000", **swe}
    assert second.get(f"/datastreams/{d['id']}/observations", p)[2].content == \
        first.get(f"/datastreams/{d['id']}/observations", p)[2].content


def test_at04_declared_queries_meet_budget_and_rebuild_identically():
    """AT-04 at one week of the logger's history: CI loads a week (decision D-37). Summaries are per dataset in
    4.7: their budget is checked on a dataset (``test_import.py``, ``test_models.py``)."""
    r = Rig(seed=14, days=7)
    d = {s: r.ds(s, "weather")["id"] for s in ("bow", "stern")}
    now = r.clock.now()
    hour = {"phenomenonTime": f"{iso(now - 3600)}/..", "limit": "4000", "f": "application/swe+json"}
    t0 = time.perf_counter()
    last = {s: r.get(f"/datastreams/{d[s]}/observations", hour)[2].content for s in d}
    assert (time.perf_counter() - t0) * 1000 < C.QUERY_BUDGET_MS["last-hour-each-sensor"]
    r.rt.restart_server(); r.ready()  # the index is dropped and rebuilt from the store
    d2 = {s: r.ds(s, "weather")["id"] for s in ("bow", "stern")}
    again = {s: r.get(f"/datastreams/{d2[s]}/observations", hour)[2].content for s in d}
    assert again == last


def test_at07_server_side_profile_claim_is_honest_unless_misconfigured(data_folder):
    """The 4.7 template's essentials are per dataset: met for the claim by some dataset (D-301)."""
    r = Rig(seed=4, days=0.2, folder=data_folder)
    conf = lambda: r.get("/conformance")[1]["conformsTo"]
    pid = r.get("/profile.json")[1]["id"]
    assert pid in conf()
    r.rt.set_field("air_temperature", False)
    r.rt.restart_server(); r.ready()
    assert pid not in conf()  # an honest server drops the claim it cannot meet
    r.rt.set_profile_lie(True)
    r.rt.restart_server(); r.ready()
    assert pid in conf()  # a misconfigured server claims it anyway: the client must catch this (AT-08)


def test_at10_restart_server_answers_nothing_while_starting_and_no_records_lost():
    """4.7, §9.1: no 503 and no instance identifier; while starting, the server answers nothing."""
    r = Rig(seed=6, days=0.5)
    st, _, resp = r.get("/")
    assert st == 200 and "x-server-instance" not in resp.headers and "etag" not in resp.headers
    before = ids(r)
    r.rt.restart_server()
    with pytest.raises(ServerUnavailable):  # in the browser the relay reports a network failure
        r.get("/datastreams")
    r.clock.play()
    r.clock.advance(120)
    r.rt.sensors.sample_until(r.clock.now() + 1)  # the store keeps receiving records (FR-18)
    r.ready()
    st, _, resp = r.get("/")
    assert st == 200 and "x-server-instance" not in resp.headers
    assert ids(r) == before  # the same resources, under the same identifiers: they outlive the restart (D-11)
    d2 = r.ds("stern", "weather")
    obs = r.obs(d2["id"], {"phenomenonTime": "2031-04-07T11:50:00Z/..", "limit": "100000"})
    t = np.array([parse_iso(o["time"]) for o in obs])
    assert np.all(np.diff(t) == 1.0) and t.max() >= 12 * 3600 + 110
    assert r.sid("analysis")  # the models registered again


def test_at11_server_down_is_no_answer_store_and_models_carry_on():
    import asyncio

    from barge.bridge import Bridge

    b = Bridge(seed=13, pregen_days=0.05)
    while not b.rt.running:
        b.rt.tick()
    n = b.rt.sensors.next_t
    b.control("down")
    assert asyncio.run(b.handle("GET", "/", "", None, "")) is None
    from barge.local_models import LocalModels, csmodel

    with pytest.raises(csmodel.Unavailable):  # a model gets no answer either, and tries again on its next step
        asyncio.run(LocalModels(b.rt, classes=())._transport("GET", "/systems", {}, None))
    with pytest.raises(csmodel.Unavailable):  # nor does a subscription
        asyncio.run(LocalModels(b.rt, classes=())._stream("/controlstreams/x/commands?subscribe=1", {}, True))
    b.rt.clock.play()
    b.rt.clock._sim += 30
    b.rt.tick()
    assert b.rt.sensors.next_t > n  # FR-18: sensors and store carry on
    b.control("up")
    while not b.rt.server.ready:
        b.rt.tick()
    st, headers, _ = asyncio.run(b.handle("GET", "/", "", None, ""))
    assert st == 401  # it answers again: without credentials, 401


def test_at12_field_toggles_apply_only_at_next_start_and_restore_history(data_folder):
    r = Rig(seed=11, days=0.5, folder=data_folder)
    a = r.dataset("MISSION_A")
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
    assert "relative_humidity" not in schema(after[f"summary-1min-bow__{a}@summaries"])  # every datastream's (FR-50)
    derived = schema(after[f"derived-1min__{a}@summaries"])
    assert "dew_point" not in derived  # its inputs are off (FR-52)
    assert "pressure_tendency_3h" in derived and "bow_minus_stern" in derived
    assert "readings_removed" in schema(after[f"summary-1h-bow__{a}@summaries"])
    assert "precipitation_type" in schema(after["weather@bow"])
    r.rt.set_field("relative_humidity", True)
    for x in ("precipitation_type", "pressure_tendency_3h", "readings_removed"):
        r.rt.set_field(x, False)
    r.rt.restart_server(); r.ready()
    again = ids(r)
    assert again["weather@bow"] == before["weather@bow"]
    obs = r.obs(again["weather@bow"], {"limit": "5"})
    assert obs[0]["time"] == "2031-04-07T00:00:00Z" and "relative_humidity" in obs[0]  # full history restored


def test_at18_capture_changes_nothing_and_every_busy_boundary_is_tapped(data_folder):
    bodies = []
    for capture in (True, False):
        r = Rig(seed=9, days=0.3, capture=capture, folder=data_folder)
        a = r.dataset("MISSION_A")
        for _ in range(9):
            r.advance(10)
        out = [r.get(f"/datastreams/{r.ds('bow', 'weather')['id']}/observations", {"limit": "50"})[2].content,
               r.get(f"/datastreams/{r.ds('summaries', f'summary-1min-bow__{a}')['id']}/observations",
                     {"limit": "50", "f": "application/swe+json"})[2].content,
               bytes(r.rt.logger.read(r.rt.logger.list_files()[0][0]))]
        r.request("POST", f"/controlstreams/{cs_of(r, 'data-cleanse')}/commands", json={"parameters": {"spike_threshold": 5}})
        r.advance(2)
        bodies.append(out)
        if capture:
            keys = {k.split(":")[0] for k in r.rt.tap.counts}
            for edge in ("platform>store", "server>adapter", "adapter>store", "store>adapter", "adapter>server",
                         "models>server", "server>models", "models>scilibs", "scilibs>models",
                         "client>server", "server>client"):
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
