"""The server as a configured stock OpenSensorHub (interfaces §9.1-§9.4), in CPython: what the contract suite
cannot reach from outside (the admin stub, restarts, the capture). Plan Phase 4: AT-11, AT-29, AT-38, AT-39,
AT-49, AT-53."""
import json

import pytest

from barge import accounts as A
from barge.api import ServerUnavailable
from tests.helpers import Rig


@pytest.fixture(scope="module")
def r():
    return Rig(seed=21, days=0.2)


def cs_of(r, system):
    return next(c["id"] for c in r.get("/controlstreams")[1]["items"] if c["system@id"] == r.sid(system))


def test_at49_credentials_are_needed_and_the_challenge_is_basic(r):
    for path in ("/", "/systems", "/profile.json", f"/datastreams/{r.ds('bow', 'weather')['id']}/observations"):
        st, body, resp = r.get(path, user=False)
        assert st == 401 and resp.headers["www-authenticate"] == "basic", path  # the relay drops it (D-226)
        assert resp.headers["content-type"].startswith("text/html") and "<title>401 Unauthorized</title>" in body
    resp = r.request("GET", "/", headers={"Authorization": A.basic("owner", "demo-friend")}, user=False)
    assert resp.status_code == 401


def test_at59_a_role_change_takes_effect_on_the_next_request(r):
    """FR-116, D-151: the server reads the user-to-role assignment on every request."""
    bow_co2 = r.systems()["urn:x-barge:sensor:bow:co2"]
    assert r.get(f"/systems/{bow_co2}", user="friend")[0] == 403
    r.rt.set_role("friend", "viewer-emissions")
    try:
        assert r.get(f"/systems/{bow_co2}", user="friend")[0] == 200
    finally:
        r.rt.set_role("friend", "viewer")
    assert r.get(f"/systems/{bow_co2}", user="friend")[0] == 403
    with pytest.raises(ValueError):
        r.rt.set_role("friend", "service")  # a user account takes a user's role only


def test_restricted_model_subsystems_are_refused_too(r):
    """urn:x-barge:process:*:restricted is restricted like the CO₂ analysers (§9.3)."""
    sy = r.systems(user="svc-analysis")
    body = {"type": "SimpleProcess", "uniqueId": "urn:x-barge:process:analysis:restricted",
            "label": "Analysis, restricted outputs", "assetType": "Process"}
    resp = r.request("POST", f"/systems/{sy['urn:x-barge:process:analysis']}/subsystems", json=body,
                     headers={"content-type": "application/sml+json"}, user="svc-analysis")
    assert resp.status_code == 201
    sid = resp.headers["location"].rsplit("/", 1)[-1]
    assert r.get(f"/systems/{sid}", user="friend")[0] == 403
    assert r.get(f"/systems/{sid}", user="analyst")[0] == 200
    assert sid in {s["id"] for s in r.get("/systems", {"searchMembers": "true"}, user="friend")[1]["items"]}


def test_at29_creating_what_exists_answers_201_with_its_location(r):
    models = r.sid("models")
    body = {"type": "SimpleProcess", "uniqueId": "urn:x-barge:process:summaries", "label": "Summaries"}
    resp = r.request("POST", f"/systems/{models}/subsystems", json=body, headers={"content-type": "application/sml+json"},
                     user="svc-summaries")
    assert resp.status_code == 201 and resp.headers["location"].endswith("/" + r.sid("summaries"))


def test_at39_the_sender_reads_the_outcome_before_its_post_answers(r):
    """FR-27, D-199: the receiver's COMPLETED is there while the sender's POST is still held; once the POST answers,
    PENDING is stored after it, and the outcome is still COMPLETED."""
    r.rt.hold_s = 0.3
    try:
        import threading
        import time

        cs = cs_of(r, "data-cleanse")
        out = {}
        th = threading.Thread(target=lambda: out.update(resp=r.request(
            "POST", f"/controlstreams/{cs}/commands", json={"parameters": {"spike_threshold": 4}})))
        th.start()  # the sender's POST, held by the server
        time.sleep(0.1)
        r.rt.local.settle()  # the model takes the pushed command at once
        mid = r.get(f"/controlstreams/{cs}/status")[1]["items"]
        th.join()
        resp = out["resp"]
        assert resp.status_code == 200 and resp.json()["currentStatus"] == "PENDING"
        cid = resp.json()["id"]
        assert [x["statusCode"] for x in mid if x["command@id"] == cid] == ["ACCEPTED", "COMPLETED"]
        after = r.get(f"/controlstreams/{cs}/status")[1]["items"]
        codes = [x["statusCode"] for x in after if x["command@id"] == cid]
        assert codes == ["ACCEPTED", "COMPLETED", "PENDING"]
        import csmodel

        assert csmodel.outcome(after, cid)["statusCode"] == "COMPLETED"
        assert all(x.get("id") for x in after)  # every report has its own id (D-181)
    finally:
        r.rt.hold_s = 0.01


def test_a_bound_is_rejected_by_the_receiver_naming_it(r):
    cs = cs_of(r, "data-cleanse")
    resp = r.request("POST", f"/controlstreams/{cs}/commands", json={"parameters": {"spike_threshold": 40}})
    assert resp.status_code == 200
    r.rt.local.settle()
    cid = resp.json()["id"]
    out = [x for x in r.get(f"/controlstreams/{cs}/status")[1]["items"] if x["command@id"] == cid]
    rej = next(x for x in out if x["statusCode"] == "REJECTED")
    assert "spike_threshold" in rej["message"] and "[1, 10]" in rej["message"]
    resp = r.request("POST", f"/controlstreams/{cs}/commands", json={"parameters": {}})
    assert resp.status_code == 400  # every parameter, on every command


def test_at38_receivers_resubscribe_after_a_restart_and_starting_answers_nothing():
    r = Rig(seed=22, days=0.1)
    assert all(x.subscribed.is_set() for x in r.rt.local.runners)
    r.rt.restart_server()
    with pytest.raises(ServerUnavailable):
        r.get("/")
    assert not r.rt.hub.subs  # every subscription ended with the server
    r.ready()
    assert all(x.subscribed.is_set() for x in r.rt.local.runners) and len(r.rt.hub.subs) == 3
    cs = cs_of(r, "summaries")
    resp = r.request("POST", f"/controlstreams/{cs}/commands", json={"parameters": {"tendency_hours": 2}})
    assert resp.status_code == 200  # a subscriber was there
    r.rt.local.settle()
    cid = resp.json()["id"]
    assert any(x["statusCode"] == "COMPLETED" and x["command@id"] == cid for x in r.get(f"/controlstreams/{cs}/status")[1]["items"])


def test_at53_no_captured_message_shows_a_credential(r):
    r.rt.tap.drain()
    r.get("/systems")
    r.request("POST", f"/systems/{r.systems()['urn:x-barge:workspace:owner']}/datastreams",
              json={"password": "demo-owner", "outputName": "x"})
    r.advance(10)
    text = json.dumps(r.rt.tap.drain())
    for pw in A.DEMO_PASSWORDS:
        assert pw not in text, pw
    assert "Authorization: ****" in text


def test_pushed_commands_are_captured_as_push(r):
    r.rt.tap.drain()
    cs = cs_of(r, "summaries")
    r.request("POST", f"/controlstreams/{cs}/commands", json={"parameters": {"tendency_hours": 3}})
    msgs = r.rt.tap.drain()
    push = [m for m in msgs if m.get("push")]
    assert push and push[0]["src"] == "server" and push[0]["dst"] == "models" and push[0]["letter"] == "K"
    assert '"sender": "owner"' in push[0]["content"]
