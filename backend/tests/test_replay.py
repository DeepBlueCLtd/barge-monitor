"""The replay controller and the two kinds of time (SRD §6.6, §9.6): AT-33 to AT-36, freeze."""
import asyncio

import pytest

from tests.helpers import Rig
from barge.times import iso

REPLAY = "urn:x-barge:replay"
DC = "urn:x-barge:process:data-cleanse"
SUM = "urn:x-barge:process:summaries"


@pytest.fixture(scope="module")
def r():
    """Data cleanse and Summaries only, so the bound is 100× (Analysis's 10× is tested on the full set)."""
    from data_cleanse import DataCleanse
    from summaries import Summaries

    return Rig(classes=(DataCleanse, Summaries))


def log(r):
    return r.obs(r.ds(REPLAY, "log")["id"])


def test_at33_replay_is_driven_by_pushed_commands_and_logged(r):
    st = r.state()
    assert st["dataset"] == r.dataset("MISSION_A") and not st["playing"] and st["models_ready"]
    n = len(log(r))
    before = r.rt.tap.counts.get("server>replay:K", 0)
    r.replay("play", rate=10)
    assert r.state()["playing"] and r.state()["rate"] == 10  # within one real second: at once
    r.step(1.0)
    assert r.state()["time"] == "2031-04-07T00:00:10Z"
    r.replay("pause")
    r.step(1.0)
    assert r.state()["time"] == "2031-04-07T00:00:10Z" and not r.state()["playing"]
    r.replay("seek", position="2031-04-07T00:05:00Z")
    assert r.state()["time"] == "2031-04-07T00:05:00Z"
    entries = log(r)[n:]
    assert [e["action"] for e in entries] == ["play", "pause", "seek"]
    assert all(e["sender"] == "owner" and e["command_id"] for e in entries)
    # D-198: the log's time is the real time each took effect; the replay time is its position
    assert [e["position"] for e in entries] == ["2031-04-07T00:00:00Z", "2031-04-07T00:00:10Z", "2031-04-07T00:05:00Z"]
    times = [e["time"] for e in entries]
    assert times == sorted(times) and times[-1] == iso(r.clock.t) and all(t < "2031" for t in times), times
    assert r.rt.tap.counts.get("server>replay:K", 0) == before + 3
    pushes = [m for m in r.rt.tap.buffer if m["dst"] == "replay" and m["letter"] == "K"]
    assert pushes and all(m.get("push") for m in pushes)
    states = r.obs(r.ds(REPLAY, "state")["id"])
    assert states[-1]["time"] == "2031-04-07T00:05:00Z"  # phenomenonTime is the replay time
    latest = r.obs(r.ds(REPLAY, "state")["id"], {"resultTime": "latest"})
    assert latest[-1]["position"] == "2031-04-07T00:05:00Z"  # the latest is the current state, even after a seek back
    r.replay("seek", position="2031-04-07T00:00:00Z")


def test_two_log_entries_at_one_replay_time_are_both_kept(r):
    """D-198: a load and a pause at one position are two entries, told apart by the real time they took effect."""
    n = len(log(r))
    r.replay("pause")
    r.step(1.0)
    r.replay("pause")
    entries = log(r)[n:]
    assert [e["action"] for e in entries] == ["pause", "pause"]
    assert entries[0]["position"] == entries[1]["position"] and entries[0]["time"] < entries[1]["time"]


def test_state_once_per_real_second_while_playing(r):
    d = r.ds(REPLAY, "state")["id"]
    n = len(r.obs(d))
    r.replay("play", rate=1)
    for _ in range(5):
        r.step(1.0)
    r.replay("pause")
    assert 5 <= len(r.obs(d)) - n <= 7
    r.replay("seek", position="2031-04-07T00:00:00Z")


def test_rejections_name_the_bound(r):
    cid = r.replay("play", rate=7)
    assert r.status_of(REPLAY, "replay", cid)[-1]["statusCode"] == "REJECTED"
    cid = r.replay("load", dataset="mission-z-00000000")
    st = r.status_of(REPLAY, "replay", cid)[-1]
    assert st["statusCode"] == "REJECTED" and "mission-z-00000000" in st["message"] and "not imported" in st["message"]
    cid = r.replay("seek", position="2031-05-01T00:00:00Z")
    assert r.status_of(REPLAY, "replay", cid)[-1]["statusCode"] == "REJECTED"


def test_at35_a_rate_above_the_slowest_model_is_rejected(played):
    """AT-35: with Analysis registered the bound is 10×, named with the model."""
    st = played.state()
    assert st["max_rate"] == 10 and st["max_rate_model"] == "Analysis"
    cid = played.replay("play", rate=100)
    rep = played.status_of(REPLAY, "replay", cid)[-1]
    assert rep["statusCode"] == "REJECTED" and rep["message"] == "rate 100 exceeds 10, the highest Analysis sustains"
    assert not played.state()["playing"]


def rows_of(r, uid, output, run):
    d = r.ds(uid, output)
    return [{k: v for k, v in x.items() if k != "run"} for x in r.obs(d["id"]) if x["run"] == run]


def test_at34_at36_outputs_identical_at_any_rate_and_runs_never_mix(r):
    ds = r.dataset("MISSION_A")
    out = {}
    for rate in (100, 1, 0.1):
        r.replay("seek", position="2031-04-07T00:00:00Z", rate=rate)
        run = r.state()["run"]
        r.play_until("2031-04-07T00:02:00Z", rate=rate, max_steps=20000)
        out[rate] = (run, rows_of(r, DC, f"cleaned-bow__{ds}", run), rows_of(r, SUM, f"summary-1min-bow__{ds}", run),
                     rows_of(r, SUM, f"derived-1min__{ds}", run))
    runs = {v[0] for v in out.values()}
    assert len(runs) == 3  # every seek starts a new run (AT-36)
    a = out[100]
    assert len(a[1]) == 120 and len(a[2]) == 2 and a[1][0]["time"] == "2031-04-07T00:00:00Z"
    for rate in (1, 0.1):
        assert out[rate][1:] == a[1:], f"outputs at {rate}× differ from those at 100× (AT-34)"
    # Runs never mix: every row of a run lies in that run's span, and each row is in one run only.
    d = r.ds(DC, f"cleaned-bow__{ds}")
    allrows = r.obs(d["id"], {"phenomenonTime": "2031-04-07T00:00:00Z/2031-04-07T00:01:59Z"})
    by_run = {}
    for x in allrows:
        by_run.setdefault(x["run"], []).append(x["time"])
    for run in runs:
        assert len(by_run[run]) == len(set(by_run[run])) == 120


def test_pause_at_the_end_of_the_dataset(r):
    r.replay("seek", position="2031-04-07T23:59:50Z", rate=10)
    r.replay("play", rate=10)
    r.step(1.0)
    r.step(1.0)
    st = r.state()
    assert st["at_end"] and not st["playing"] and st["time"] == "2031-04-07T23:59:59Z"
    r.replay("seek", position="2031-04-07T00:00:00Z", rate=1)


def test_freeze_holds_the_clock_requests_and_pushes(r):
    r.replay("play", rate=10)
    r.control("freeze", {"on": True})
    t = r.state()["time"]
    for _ in range(2):  # models' requests would be held too: only the host's tick runs here
        r.clock.advance(1.0)
        r.rt.tick()
    assert r.state()["time"] == t  # the replay clock does not advance
    fut = asyncio.ensure_future(r.app_request("GET", "/systems"), loop=r.loop)
    r.spin(20)
    assert not fut.done()  # held, unanswered
    r.control("freeze", {"on": False})
    r.spin(20)
    assert fut.done() and fut.result().status == 200
    r.step(1.0)
    assert r.state()["time"] > t
    r.replay("pause")
    r.replay("seek", position="2031-04-07T00:00:00Z")
