"""Acceptance tests of the server's lifecycle and the capture that run in CPython (SRD §14). Browser halves are
in web/e2e.

The 4.1 world, logger store and store adapter are retired (plan Phase 8, D-320), and with them the 4.1 versions of
AT-01, AT-03 and AT-04 over the logger: those tests run on the data folder in ``test_import.py``. What stays here
runs on the data folder: Mission A imported silently at the first start, its models' outputs published on import."""
import asyncio

import pytest

from barge.api import ServerUnavailable
from tests.helpers import Rig


def ids(r):
    names = {i: u.rsplit(":", 1)[-1] for u, i in r.systems().items()}
    return {d["outputName"] + "@" + names[d["system@id"]]: d["id"] for d in r.get("/datastreams")[1]["items"]}


def cs_of(r, system):
    return next(c["id"] for c in r.get("/controlstreams")[1]["items"] if c["system@id"] == r.sid(system))


def schema(r, dsid):
    return [f["name"] for f in r.get(f"/datastreams/{dsid}/schema", {"obsFormat": "application/swe+json"})[1]["recordSchema"]["fields"]]


def test_at07_server_side_profile_claim_is_honest_unless_misconfigured(data_folder):
    """The 4.7 template's essentials are per dataset: met for the claim by some dataset (D-301). A misconfigured
    server (D-210) serves the catalogue without ``status`` and claims the profile all the same."""
    r = Rig(folder=data_folder)
    conf = lambda: r.get("/conformance")[1]["conformsTo"]
    pid = r.get("/profile.json")[1]["id"]
    assert pid in conf()
    cat = r.ds("importer", "catalogue")["id"]
    assert "status" in schema(r, cat)
    r.rt.set_field("air_temperature", False)
    r.rt.restart_server(); r.ready()
    assert pid not in conf()  # an honest server drops the claim it cannot meet
    r.rt.set_field("air_temperature", True)
    r.rt.set_profile_lie(True)
    r.rt.restart_server(); r.ready()
    assert pid in conf()  # a misconfigured server claims it anyway: the client must catch this (AT-08)
    assert "status" not in schema(r, cat)
    assert all("status" not in o for o in r.obs(cat, {"limit": "10"}))
    r.rt.set_profile_lie(False)
    r.rt.restart_server(); r.ready()
    assert "status" in schema(r, cat) and pid in conf()


def test_at10_restart_server_answers_nothing_while_starting_and_nothing_is_lost(data_folder):
    """4.7, §9.1: no 503 and no instance identifier; while starting, the server answers nothing."""
    r = Rig(folder=data_folder)
    a = r.dataset("MISSION_A")
    st, _, resp = r.get("/")
    assert st == 200 and "x-server-instance" not in resp.headers and "etag" not in resp.headers
    before = ids(r)
    obs = r.obs(before[f"weather__{a}@bow"], {"limit": "100"})
    r.rt.restart_server()
    with pytest.raises(ServerUnavailable):  # in the browser the relay reports a network failure
        r.get("/datastreams")
    r.ready()
    st, _, resp = r.get("/")
    assert st == 200 and "x-server-instance" not in resp.headers
    assert ids(r) == before  # the same resources, under the same identifiers: they outlive the restart (D-11)
    assert r.obs(before[f"weather__{a}@bow"], {"limit": "100"}) == obs
    assert r.sid("analysis")  # the models registered again


def test_at11_server_down_is_no_answer_and_up_again():
    from barge.bridge import Bridge

    b = Bridge()
    while not b.rt.running:
        b.rt.tick()
    b.control("down")
    assert asyncio.run(b.handle("GET", "/", "", None, "")) is None
    from barge.local_models import LocalModels, csmodel

    with pytest.raises(csmodel.Unavailable):  # a model gets no answer either, and tries again on its next step
        asyncio.run(LocalModels(b.rt, classes=())._transport("GET", "/systems", {}, None))
    with pytest.raises(csmodel.Unavailable):  # nor does a subscription
        asyncio.run(LocalModels(b.rt, classes=())._stream("/controlstreams/x/commands?subscribe=1", {}, True))
    b.control("up")
    while not b.rt.running:
        b.rt.tick()
    st, headers, _ = asyncio.run(b.handle("GET", "/", "", None, ""))
    assert st == 401  # it answers again: without credentials, 401


def test_at12_field_toggles_apply_only_at_next_start_and_restore_the_datasets(data_folder):
    """FR-50 to FR-52 on the imported datasets and the models' per-dataset outputs (the 4.1 logger's ``weather``
    and its ``precipitation_type`` are retired, D-320)."""
    r = Rig(folder=data_folder)
    a = r.dataset("MISSION_A")
    before = ids(r)
    weather = before[f"weather__{a}@bow"]
    first = r.obs(weather, {"limit": "5"})
    r.rt.set_field("relative_humidity", False)
    for x in ("pressure_tendency_3h", "readings_removed"):
        r.rt.set_field(x, True)
    assert ids(r) == before and "relative_humidity" in schema(r, weather)  # nothing changes while running (FR-51)
    assert r.rt.control_state()["pending"]
    r.rt.restart_server(); r.ready()
    assert not r.rt.control_state()["pending"]
    after = ids(r)
    assert "relative_humidity" not in schema(r, after[f"weather__{a}@bow"])
    assert "relative_humidity" not in r.obs(after[f"weather__{a}@bow"], {"limit": "5"})[0]
    assert "relative_humidity" not in schema(r, after[f"summary-1min-bow__{a}@summaries"])  # every datastream's (FR-50)
    derived = schema(r, after[f"derived-1min__{a}@summaries"])
    assert "dew_point" not in derived  # its inputs are off (FR-52)
    assert "pressure_tendency_3h" in derived and "bow_minus_stern" in derived
    assert "readings_removed" in schema(r, after[f"summary-1h-bow__{a}@summaries"])
    r.rt.set_field("relative_humidity", True)
    for x in ("pressure_tendency_3h", "readings_removed"):
        r.rt.set_field(x, False)
    r.rt.restart_server(); r.ready()
    again = ids(r)
    assert again == before
    assert r.obs(again[f"weather__{a}@bow"], {"limit": "5"}) == first  # nothing stored was altered (FR-22)


def test_at18_capture_changes_nothing_and_every_boundary_is_tapped(data_folder):
    """AT-18: every flow of SRD §3.1 produces captured messages, and the outputs are identical with capture off.
    The display client's side is the test's own requests (``client``); the importer's flows come from an import
    asked for over HTTP (the silent one is counted, not drawn)."""
    bodies = []
    for capture in (True, False):
        r = Rig(capture=capture, folder=data_folder)
        r.rt.tap.drain()
        a = r.dataset("MISSION_A")
        cmd = r.command("urn:x-barge:importer", "import", {"action": "import", "file": "MISSION_C_20310421.csv"})
        r.wait(cmd.json()["id"], steps=2000)
        r.request("POST", f"/controlstreams/{cs_of(r, 'data-cleanse')}/commands", json={"parameters": {"spike_threshold": 5}})
        r.rt.local.settle()
        r.step(50)
        c = r.dataset("MISSION_C")
        out = [r.get(f"/datastreams/{r.ds('bow', f'weather__{a}')['id']}/observations",
                     {"limit": "50", "f": "application/swe+json"})[2].content,
               r.get(f"/datastreams/{r.ds('stern', f'weather__{c}')['id']}/observations",
                     {"limit": "50", "f": "application/swe+json"})[2].content,
               r.get(f"/datastreams/{r.ds('summaries', f'summary-1min-bow__{a}')['id']}/observations",
                     {"limit": "50", "f": "application/swe+json"})[2].content]
        bodies.append(out)
        msgs = r.rt.tap.drain()
        if capture:
            edges = {f"{m['src']}>{m['dst']}" for m in msgs}
            for edge in ("importer>folder", "folder>importer", "importer>server", "server>importer",
                         "models>server", "server>models", "models>scilibs", "scilibs>models",
                         "client>server", "server>client"):
                assert edge in edges, edge
            assert all(m["letter"] in "QDOKPHSLI" for m in msgs)
        else:
            assert msgs == []
    assert bodies[0] == bodies[1]


def test_at19_with_nothing_asked_and_every_dataset_processed_nothing_is_drawn(data_folder):
    """There is no clock to pause (D-220, D-320): once the models have processed every dataset and nobody asks
    anything, ticking draws nothing."""
    r = Rig(folder=data_folder)
    r.step(20)
    r.rt.tap.drain()
    for _ in range(20):
        r.rt.tick()
    drawn = r.rt.tap.drain()
    assert drawn == [], drawn[:3]
