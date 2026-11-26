"""The server stand-in behind the access gateway (§9): authentication, permissions, CO₂ restriction,
restarts and resubscription, capture. AT-12, AT-38, AT-49, AT-52, AT-53, AT-55 to AT-57, AT-59, AT-61."""
import base64
import json
import time

import pytest

from barge import accounts as A
from barge import asgi
from barge import config as C
from barge.api import create_server
from tests.helpers import Rig

URN = "urn:x-barge:"
AN = URN + "process:analysis"


def co2_doi(r, fields=("co2",)):
    ds = r.rt.importer.datasets[r.dataset("MISSION_A")]
    return json.dumps({"version": 1, "label": "co2", "dataset": {k: ds[k] for k in ("file", "size", "modified", "sha256")},
                       "start": "2031-04-07T00:10:00Z", "end": "2031-04-07T00:40:00Z", "resolution": "PT1S",
                       "aggregation": "as-stored",
                       "sources": [{"system": URN + "sensor:bow:co2", "output": "co2", "fields": list(fields)}],
                       "created": {"at": "2026-11-25T12:00:00Z", "by": "owner"}})


def clustering(r, doi, user="owner", algorithm="A"):
    resp = r.command(AN, "clustering", {"algorithm": algorithm, "doi": doi, "clusters": 3, "sensitivity": 5}, user=user)
    assert resp.status == 200, (resp.status, resp.body)
    cid = resp.json["id"]
    for _ in range(50):
        st = r.status_of(AN, "clustering", cid)
        if st and st[-1]["statusCode"] in ("COMPLETED", "REJECTED", "FAILED"):
            return st[-1]
        r.spin(20)
    raise AssertionError(f"no answer to {cid}")


def test_at49_every_request_and_subscription_needs_credentials(played):
    r = played
    cs = r.cs(AN, "clustering")
    for path, params in (("/", None), ("/systems", None), ("/profile.json", None), ("/datastreams", None),
                         (f"/controlstreams/{cs['id']}/commands", {"subscribe": "1"})):
        for user, pw in ((None, None), ("owner", "nope"), ("nobody", "demo-owner")):
            resp = r.get(path, params, user=user, password=pw)
            assert resp.status == 401, (path, user, resp.status)
            assert "www-authenticate" not in resp.headers  # stripped by the gateway (D-153)
            assert resp.headers["content-type"].startswith("text/html")


def test_the_server_itself_challenges_and_applies_no_permissions(played):
    """Behind the gateway the server behaves as OpenSensorHub: 401 with WWW-Authenticate: basic; no hiding."""
    server = create_server(played.rt)
    r = played.run(asgi.call(server, "GET", "/systems", "", None, "", [], "http://t"))
    assert r[0] == 401 and dict((k.lower(), v) for k, v in r[1])["www-authenticate"].lower().startswith("basic")
    friend = [("authorization", A.basic("friend", "demo-friend"))]
    r = played.run(asgi.call(server, "GET", "/collections/all_systems/items", "f=application/sml%2Bjson", None, "",
                             friend, "http://t"))
    assert r[0] == 200 and b":co2" in r[2]  # OpenSensorHub cannot hide: the gateway does (§9.5)


def discovery_text(r, user):
    """Every discovery response a client can reach, concatenated."""
    out = []
    for path in ("/systems", "/datastreams", "/controlstreams", "/collections/all_systems/items",
                 "/collections/all_datastreams/items"):
        resp = r.get(path, {"limit": "100000"}, user=user)
        assert resp.status == 200
        out.append(resp.body.decode())
        for item in resp.json["items"]:
            if path == "/systems":
                for sub in ("subsystems", "datastreams", "controlstreams"):
                    out.append(r.get(f"/systems/{item['id']}/{sub}", user=user).body.decode())
            if path == "/datastreams":
                out.append(r.get(f"/datastreams/{item['id']}/schema", {"obsFormat": "application%2Fswe%2Bjson"},
                                 user=user).body.decode())
            if path == "/controlstreams":
                out.append(r.get(f"/controlstreams/{item['id']}/schema", user=user).body.decode())
    return "\n".join(out)


def test_at55_weather_only_finds_no_co2_anywhere_and_404_by_id(played):
    r = played
    text = discovery_text(r, "friend").lower()
    assert "co2" not in text and "co₂" not in text and ":restricted" not in text
    owner = discovery_text(r, "owner").lower()
    assert "co2__" in owner and "cleaned-co2-" in owner and ":restricted" in owner
    ds = r.dataset("MISSION_A")
    sysm = r.systems()
    for uid in (URN + "sensor:bow:co2", URN + "process:data-cleanse:restricted", AN + ":restricted"):
        assert r.get(f"/systems/{sysm[uid]['id']}", user="friend").status == 404
    for uid, out in ((URN + "sensor:bow:co2", f"co2__{ds}"), (URN + "process:data-cleanse:restricted", f"cleaned-co2-bow__{ds}")):
        d = r.ds(uid, out)
        for path in (f"/datastreams/{d['id']}", f"/datastreams/{d['id']}/observations", f"/datastreams/{d['id']}/schema"):
            assert r.get(path, user="friend").status == 404, path
        assert r.get(f"/datastreams/{d['id']}/observations", user="analyst").status == 200


def test_at56_at57_co2_outputs_only_under_restricted_subsystems(played):
    r = played
    ds = r.dataset("MISSION_A")
    rej = clustering(r, co2_doi(r), user="friend")
    assert rej["statusCode"] == "REJECTED" and rej["message"] == "a requested source is not available"  # AT-57
    done = clustering(r, co2_doi(r), user="owner")
    assert done["statusCode"] == "COMPLETED", done
    open_runs = r.obs(r.ds(AN, f"runs__{ds}")["id"])
    restricted = r.obs(r.ds(AN + ":restricted", f"runs__{ds}")["id"])
    assert any("co2" in x["sources"] for x in restricted) and restricted[-1]["sender"] == "owner"
    assert not any("co2" in json.dumps(x) for x in open_runs)
    assert r.obs(r.ds(AN + ":restricted", f"clusters__{ds}")["id"])
    # No datastream the friend can see holds a CO₂ name or value (AT-56).
    for d in r.get("/datastreams", {"limit": "100000"}, user="friend").json["items"]:
        assert "co2" not in d["outputName"] and "co2" not in json.dumps(r.get(
            f"/datastreams/{d['id']}/schema", {"obsFormat": "application%2Fswe%2Bjson"}, user="friend").json)


def test_at47_a_resolution_with_no_datastream_is_refused(played):
    doi = json.loads(co2_doi(played))
    doi["resolution"] = "PT10S"
    doi["sources"] = [{"system": URN + "sensor:bow", "output": "weather", "fields": ["air_temperature"]}]
    st = clustering(played, json.dumps(doi))
    assert st["statusCode"] == "REJECTED" and "PT1S, PT1M, PT1H" in st["message"]
    rej = clustering(played, json.dumps({**doi, "resolution": "PT1S"}), algorithm="Z")
    assert rej["statusCode"] == "REJECTED" and "algorithm" in rej["message"]  # the receiver validates (FR-27)


def test_at59_a_role_change_takes_effect_at_once(played):
    r = played
    ds = r.dataset("MISSION_A")
    d = r.ds(URN + "sensor:bow:co2", f"co2__{ds}", user="analyst")
    assert d and r.get(f"/datastreams/{d['id']}", user="analyst").status == 200
    try:
        r.control("set-role", {"user": "analyst", "role": "viewer"})
        assert r.get(f"/datastreams/{d['id']}", user="analyst").status == 404  # the next request (D-151)
        assert "co2" not in discovery_text(r, "analyst").lower()
        assert clustering(r, co2_doi(r), user="analyst")["statusCode"] == "REJECTED"
        assert {"user": "analyst", "role": "viewer"}.items() <= next(
            a for a in r.rt.control_state()["accounts"] if a["user"] == "analyst").items()
    finally:
        r.control("set-role", {"user": "analyst", "role": "viewer-emissions"})
    assert r.get(f"/datastreams/{d['id']}", user="analyst").status == 200


def test_at61_a_new_model_reads_no_co2_unless_granted(played):
    r = played
    d = r.ds(URN + "sensor:bow:co2", f"co2__{r.dataset('MISSION_A')}")
    assert r.get(f"/datastreams/{d['id']}/observations", user="svc-new-model-1").status == 404
    assert r.get(f"/datastreams/{d['id']}/observations", user="svc-data-cleanse").status == 200
    try:
        r.control("set-role", {"user": "svc-new-model-1", "role": "service"})
        assert r.get(f"/datastreams/{d['id']}/observations", user="svc-new-model-1").status == 200
    finally:
        r.control("set-role", {"user": "svc-new-model-1", "role": "service-no-co2"})


def test_at52_workspaces_are_private_and_services_write_only_their_own(played):
    r = played
    mine = r.ds(URN + "workspace:friend", "data-of-interest", user="friend")
    owners = r.ds(URN + "workspace:owner", "data-of-interest")
    rec = {"time": "2026-11-25T12:00:00Z", "doi_id": "d1", "action": "save", "record": "{}"}
    assert r.request("POST", f"/datastreams/{mine['id']}/observations", body=rec, user="friend",
                     ctype="application/swe+json").status == 201
    assert r.get(f"/datastreams/{mine['id']}/observations", user="owner").status == 404
    assert r.request("POST", f"/datastreams/{owners['id']}/observations", body=rec, user="friend").status == 404
    sysm = r.systems()
    ds = r.dataset("MISSION_A")
    body = {"name": "x", "outputName": "intruder", "schema": {"obsFormat": "application/swe+json", "recordSchema": {
        "type": "DataRecord", "fields": [{"type": "Time", "name": "time"}]}}}
    assert r.request("POST", f"/systems/{sysm[URN + 'process:data-cleanse']['id']}/datastreams", body=body,
                     user="svc-summaries").status == 403
    cleaned = r.ds(URN + "process:data-cleanse", f"cleaned-bow__{ds}")
    obs = {"time": "2031-04-07T00:00:00Z", "run": "x"}
    assert r.request("POST", f"/datastreams/{cleaned['id']}/observations", body=obs, user="svc-summaries",
                     ctype="application/swe+json").status == 403
    weather = r.ds(URN + "sensor:bow", f"weather__{ds}")
    assert r.request("POST", f"/datastreams/{weather['id']}/observations", body=obs, user="owner").status == 403
    assert r.request("POST", f"/systems/{sysm[URN + 'process:models']['id']}/subsystems",
                     body={"uniqueId": URN + "process:analysis", "label": "x"}, user="svc-summaries").status == 403
    cs = r.cs(AN, "clustering")
    assert r.get(f"/controlstreams/{cs['id']}/commands", {"subscribe": "1"}, user="owner").status == 403


def test_at53_no_captured_message_shows_a_credential(played):
    r = played
    r.request("POST", "/systems", body={"uniqueId": "urn:x", "label": "x", "password": "demo-owner"})
    r.get("/systems", user="friend")
    r.get("/systems", user="owner", password="demo-friend")
    text = json.dumps(r.rt.tap.buffer)
    assert r.rt.tap.buffer
    for pw in A.DEMO_PASSWORDS:
        assert pw not in text, pw
    for user, pw in (("owner", "demo-owner"), ("friend", "demo-friend"), ("svc-analysis", "svc-demo")):
        assert base64.b64encode(f"{user}:{pw}".encode()).decode() not in text
    assert "Authorization: ****" in text


def test_each_hop_through_the_gateway_is_captured(played):
    r = played
    r.rt.tap.drain()
    r.get("/systems", headers={"x-tap-chain": "z1"})
    hops = [(m["src"], m["dst"], m["letter"], m["hop"]) for m in r.rt.tap.buffer if m["chain"] == "z1"]
    assert [h[:3] for h in hops] == [("client", "gateway", "Q"), ("gateway", "server", "Q"), ("server", "gateway", "D"),
                                     ("gateway", "client", "D")]
    assert [h[3] for h in hops] == sorted(h[3] for h in hops) and len({h[3] for h in hops}) == 4
    assert all(isinstance(m["t"], float) and m["t"] > 1.7e9 for m in r.rt.tap.buffer)  # real seconds (§3)
    pushes = [m for m in r.rt.tap.buffer if m["letter"] == "K"]
    assert all(m.get("push") for m in pushes if m["src"] in ("server", "gateway") and m["dst"] != "server")


@pytest.fixture(scope="module")
def small():
    from data_cleanse import DataCleanse

    return Rig(classes=(DataCleanse,))


def test_at12_a_field_toggle_waits_for_the_next_start(small):
    r = small
    ds = r.dataset("MISSION_A")

    def fields():
        d = r.ds(URN + "sensor:bow", f"weather__{ds}")
        return [f["name"] for f in r.get(f"/datastreams/{d['id']}/schema", {"obsFormat": "application%2Fswe%2Bjson"}).json[
            "recordSchema"]["fields"]]
    assert "relative_humidity" in fields()
    state = r.control("field", {"name": "relative_humidity", "on": False})
    assert state["pending"] and "relative_humidity" in fields()
    r.restart()
    assert "relative_humidity" not in fields() and "relative_humidity_qc" not in fields()
    r.control("field", {"name": "relative_humidity", "on": True})
    r.restart()
    assert "relative_humidity" in fields() and not r.rt.control_state()["pending"]


def test_at38_receivers_resubscribe_after_every_restart_and_starting_answers_nothing(small):
    r = small
    runner = r.local.runners[0]
    assert runner.subscribed.is_set() and r.rt.hub.subscribers(r.cs(URN + "process:data-cleanse", "settings")["id"])
    r.rt.start_s = 5.0
    r.control("restart-server")
    assert r.get("/systems") is None  # connections refused while starting (§9.1)
    r.step(1.0)
    assert r.get("/") is None and not runner.subscribed.is_set()
    for _ in range(6):
        r.step(1.0)
    r.rt.start_s = 0.0
    assert r.rt.running and runner.subscribed.is_set()
    cs = r.cs(URN + "process:data-cleanse", "settings")
    assert len(r.rt.hub.subscribers(cs["id"])) == 1
    resp = r.command(URN + "process:data-cleanse", "settings", {"spike_threshold": 5})
    st = r.status_of(URN + "process:data-cleanse", "settings", resp.json["id"])
    assert [s["statusCode"] for s in st] == ["ACCEPTED", "COMPLETED"]
    resp = r.command(URN + "process:data-cleanse", "settings", {"spike_threshold": 50})
    assert r.status_of(URN + "process:data-cleanse", "settings", resp.json["id"])[-1]["statusCode"] == "REJECTED"
    r.command(URN + "process:data-cleanse", "settings", {"spike_threshold": 6})
    r.control("down")
    assert r.get("/") is None
    r.control("up")
    r.step(1.0)
    r.step(1.0)
    # After a restart the server answers the models first, until they are ready (D-186, at most
    # MODEL_READY_TIMEOUT_S + 1 of real time), so another client may wait a little longer.
    for _ in range(int(C.MODEL_READY_TIMEOUT_S) + 3):
        if r.get("/") is not None:
            break
        time.sleep(0.5)
        r.step(1.0)
    assert r.get("/").status == 200 and runner.subscribed.is_set()
