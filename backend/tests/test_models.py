"""The models on import (SRD §6.4; interfaces §10): the runner of §10.2 and the core models, in CPython.

AT-13 to AT-16, AT-34, AT-56, AT-57 and AT-61, with ``runs__{ds}`` progress (FR-35b), settings commands
starting new runs, and Data cleanse's output in blocks (D-280). The browser halves are in
``web/e2e/models.spec.ts``."""
import json
import time

import numpy as np
import pytest

from tests.helpers import Rig

DC, SUM, AN = "urn:x-barge:process:data-cleanse", "urn:x-barge:process:summaries", "urn:x-barge:process:analysis"
IMPORTER = "urn:x-barge:importer"
CORE = ("data-cleanse", "summaries", "analysis")
SWE = {"f": "application/swe+json"}


@pytest.fixture(scope="module")
def rig(data_folder):
    """The back end and the core models over the data folder: Mission A imported silently and processed."""
    t = time.perf_counter()
    r = Rig(folder=data_folder)
    r.ready_s = time.perf_counter() - t
    return r


def ds_of(r, uid, output, user=None):
    sid = r.systems(user=user)[uid]
    _, body, _ = r.get(f"/systems/{sid}/datastreams", {"limit": "1000"}, user=user)
    return next((d for d in body["items"] if d["outputName"] == output), None)


def rows(r, uid, output, params=None, user=None):
    d = ds_of(r, uid, output)
    return r.obs(d["id"], {"limit": "100000", **(params or {})}, user=user)


def runs(r, uid, a):
    """The runs log of a model on a dataset, folded: run id -> its latest entry."""
    out = {}
    for e in rows(r, uid, f"runs__{a}"):
        out[e["run_id"]] = e
    return out


def settle(r, until, steps=3000):
    for _ in range(steps):
        if until():
            return
        r.step()
    raise AssertionError("never settled")


def live(r):
    return all(x.phase == "live" for x in r.rt.local.runners)


def blocks(r, uid, output, run_id):
    """A cleaned output's blocks of one run, decoded into columns (D-280)."""
    import csmodel

    obs = [o for o in rows(r, uid, output) if o["run_id"] == run_id]
    names = [k for k in obs[0] if k not in ("time", "run_id", "offsets", "removed")] if obs else []
    cols = {"t": csmodel.from_iso([o["time"] for o in obs]), "offsets": [o["offsets"] for o in obs],
            **{n: [o[n] for o in obs] for n in names}}
    return csmodel.decode_blocks(cols, names)


def doi(r, a, sources, start=None, end=None, resolution="PT1M"):
    row = next(x for x in r.rt.importer.datasets.values() if x["id"] == a)
    return json.dumps({"version": 1, "dataset": {"file": row["file"], "sha256": row["sha256"], "size": 0, "modified": ""},
                       "start": start or "2031-04-07T00:00:00Z", "end": end or "2031-04-07T23:59:59Z",
                       "resolution": resolution, "aggregation": "as-stored", "sources": sources})


WEATHER = [{"system": "urn:x-barge:sensor:bow", "output": "weather", "fields": ["air_temperature", "relative_humidity"]}]
CO2 = [{"system": "urn:x-barge:sensor:bow:co2", "output": "co2", "fields": ["co2"]}]


def test_each_core_model_processes_mission_a_and_logs_its_progress(rig):
    """FR-35, FR-35b, D-227: on import, run 1 of each core model on the whole dataset, logged in runs__{ds}:
    processing at its start and every 10 %, complete at its end, with the settings it used."""
    a = rig.dataset("MISSION_A")
    assert live(rig)
    for uid, model in ((DC, "data-cleanse"), (SUM, "summaries"), (AN, "analysis")):
        log = rows(rig, uid, f"runs__{a}")
        rid = f"{model}-{a}-1"
        assert {e["run_id"] for e in log} == {rid}
        assert [e["status"] for e in log][-1] == "complete" and log[-1]["pct"] == 100
        assert log[0]["status"] == "processing" and log[0]["pct"] == 0
        assert log[-1]["done_until"] == "2031-04-08T00:00:00Z"
        pct = [e["pct"] for e in log]
        assert pct == sorted(pct)
    assert rows(rig, DC, f"runs__{a}")[-1]["spike_threshold"] == 6.0
    assert rows(rig, SUM, f"runs__{a}")[-1]["tendency_hours"] == 3.0
    assert len(rows(rig, DC, f"runs__{a}")) >= 11  # every 10 %
    print(f"Mission A processed by the three core models, from server start, in {rig.ready_s:.1f} s (CPython)")


def test_outputs_are_per_dataset_and_whole(rig):
    a = rig.dataset("MISSION_A")
    bow = blocks(rig, DC, f"cleaned-bow__{a}", f"data-cleanse-{a}-1")
    assert len(bow["t"]) == 86400 and bow["t"][0] == pytest.approx(1933286400.0)
    assert np.isfinite(bow["air_temperature"]).mean() > 0.95
    raw = rows(rig, "urn:x-barge:sensor:bow", f"weather__{a}", {"phenomenonTime": "2031-04-07T12:00:00Z/2031-04-07T12:09:59Z"})
    t = np.array([o["air_temperature"] for o in raw], dtype=float)
    c = bow["air_temperature"][43200:43800]
    ok = np.isfinite(t) & np.isfinite(c)
    assert np.max(np.abs(t[ok] - c[ok])) < 1.0  # cleaned and smoothed, not invented
    m = rows(rig, SUM, f"summary-1min-bow__{a}")
    assert len(m) == 1440 and m[0]["time"] == "2031-04-07T00:00:00Z" and m[-1]["time"] == "2031-04-07T23:59:00Z"
    assert m[0]["air_temperature_min"] <= m[0]["air_temperature"] <= m[0]["air_temperature_max"]
    assert len(rows(rig, SUM, f"summary-1h-stern__{a}")) == 24
    d = rows(rig, SUM, f"derived-1min__{a}")
    assert len(d) == 1440 and isinstance(d[100]["dew_point"], float) and isinstance(d[100]["bow_minus_stern"], float)
    an = f"analysis-{a}-1"
    assert rows(rig, AN, f"clusters__{a}") and all(x["run_id"] == an for x in rows(rig, AN, f"clusters__{a}"))
    cor = rows(rig, AN, f"correlation__{a}")
    assert len(cor) == 1 and len(json.loads(cor[0]["matrix"])) == 4


def test_at15_every_model_but_data_cleanse_reads_only_its_output(rig, data_folder):
    """AT-15: a fresh back end, whose models' every read is recorded as it processes Mission A."""
    r = Rig(folder=data_folder, models=False)
    from barge.local_models import LocalModels

    local = LocalModels(r.rt, loop=r.rt.loop)
    r.rt.local = local
    seen = {}
    for x in local.runners:
        inner = x.api._transport

        async def rec(method, path, headers, body, inner=inner, m=x.model.id):
            if method == "GET" and "/observations" in path:
                seen.setdefault(m, set()).add(path.split("/datastreams/")[1].split("/")[0])
            return await inner(method, path, headers, body)
        x.api._transport = rec
    settle(r, lambda: live(r) and all(x.completed for x in local.runners))
    owner = {}
    sy = {i: u for u, i in r.systems().items()}
    for d in r.get("/datastreams", {"limit": "1000"})[1]["items"]:
        owner[d["id"]] = (sy[d["system@id"]], d["outputName"])
    for m, ids in seen.items():
        read = {owner[i] for i in ids}
        others = {(u, o) for u, o in read if not u.startswith(f"urn:x-barge:process:{m}") and u != IMPORTER}
        systems = {u for u, _ in others}
        if m == "data-cleanse":
            assert systems == {"urn:x-barge:sensor:bow", "urn:x-barge:sensor:stern",
                               "urn:x-barge:sensor:bow:co2", "urn:x-barge:sensor:stern:co2"}, systems
        else:
            assert systems <= {DC, DC + ":restricted"} and systems, (m, systems)


def test_at34_a_new_run_with_the_same_settings_publishes_the_same_outputs(rig):
    """AT-34, D-227: a settings command starts a new run over every dataset; the latest complete run is the one
    read; with the same settings its outputs are identical, whenever it ran."""
    a = rig.dataset("MISSION_A")
    before = runs(rig, DC, a)
    st = rig.wait(rig.command(DC, "settings", {"spike_threshold": 6}).json()["id"])
    assert [s["statusCode"] for s in st] == ["ACCEPTED", "COMPLETED"]
    second = f"data-cleanse-{a}-{len(before) + 1}"
    assert second in st[-1]["message"]
    settle(rig, lambda: runs(rig, DC, a).get(second, {}).get("status") == "complete")
    log = rows(rig, DC, f"runs__{a}")
    assert log[-1]["run_id"] == second and log[-1]["status"] == "complete"  # the latest complete run
    one, two = (blocks(rig, DC, f"cleaned-stern__{a}", f"data-cleanse-{a}-{n}") for n in (1, len(before) + 1))
    assert set(one) == set(two)
    for k in one:
        np.testing.assert_array_equal(one[k], two[k])
    # Another threshold is another result.
    st = rig.wait(rig.command(DC, "settings", {"spike_threshold": 2}).json()["id"])
    third = f"data-cleanse-{a}-{len(before) + 2}"
    settle(rig, lambda: runs(rig, DC, a).get(third, {}).get("status") == "complete")
    three = blocks(rig, DC, f"cleaned-stern__{a}", third)
    assert np.isnan(three["air_temperature"]).sum() > np.isnan(one["air_temperature"]).sum()
    assert rows(rig, DC, f"runs__{a}")[-1]["spike_threshold"] == 2.0
    settle(rig, lambda: live(rig))


def test_a_bound_outside_the_control_stream_is_rejected_naming_it(rig):
    st = rig.wait(rig.command(SUM, "settings", {"tendency_hours": 9}).json()["id"])
    assert st[-1]["statusCode"] == "REJECTED" and "tendency_hours" in st[-1]["message"]
    st = rig.wait(rig.command(AN, "clustering", {"algorithm": "A", "doi": "{}", "clusters": 4, "sensitivity": 5}).json()["id"])
    assert st[-1]["statusCode"] == "REJECTED" and "doi" in st[-1]["message"]


def test_at56_at57_co2_is_restricted_and_refused_to_a_sender_without_emissions(rig):
    a = rig.dataset("MISSION_A")
    # AT-57: the friend (weather only) asks for CO₂: rejected by the model, whatever the client sent.
    p = {"algorithm": "A", "doi": doi(rig, a, CO2), "clusters": 3, "sensitivity": 5}
    st = rig.wait(rig.command(AN, "clustering", p, user="friend").json()["id"])
    assert st[-1]["statusCode"] == "REJECTED" and st[-1]["message"] == "a requested source is not available"
    # The analyst may: the run, its outputs and its runs entry are restricted (FR-112).
    st = rig.wait(rig.command(AN, "clustering", p, user="analyst").json()["id"])
    assert st[-1]["statusCode"] == "COMPLETED", st
    rid = st[-1]["message"].split(": ")[1]
    settle(rig, lambda: any(e["run_id"] == rid and e["status"] == "complete" for e in rows(rig, AN + ":restricted", f"runs__{a}")))
    assert not any(e["run_id"] == rid for e in rows(rig, AN, f"runs__{a}"))
    assert any(x["run_id"] == rid for x in rows(rig, AN + ":restricted", f"clusters__{a}"))
    # AT-56: no datastream the friend may read carries a CO₂ value or name; the restricted ones answer 403.
    for d in rig.get("/datastreams", {"limit": "1000"}, user="friend")[1]["items"]:
        st, body, _ = rig.get(f"/datastreams/{d['id']}/schema", {"obsFormat": "application/swe+json"}, user="friend")
        if st == 403:
            continue
        names = [f["name"] for f in body["recordSchema"]["fields"]]
        assert not any("co2" in n for n in names), (d["outputName"], names)
        assert "co2" not in d["outputName"], d["outputName"]
        if d["outputName"].startswith("runs__"):
            assert "co2" not in json.dumps(rig.obs(d["id"], {"limit": "10000"}, user="friend")).lower()
    for uid, out in ((DC + ":restricted", f"cleaned-co2-bow__{a}"), (SUM + ":restricted", f"summary-1min-co2-stern__{a}"),
                     (AN + ":restricted", f"runs__{a}")):
        d = ds_of(rig, uid, out)
        assert rig.get(f"/datastreams/{d['id']}/observations", SWE, user="friend")[0] == 403
        assert rig.get(f"/datastreams/{d['id']}/observations", SWE, user="analyst")[0] == 200


def test_at16_change_detection_and_clustering_recover_the_manifest_with_scores(rig):
    """AT-16 on a dataset: run 1 finds the changes of surroundings at the full resolution (scored against the
    reach boundaries the bow crossed); a clustering command on the whole day is scored against the air masses."""
    a = rig.dataset("MISSION_A")
    one = runs(rig, AN, a)[f"analysis-{a}-1"]
    assert one["score_changes"] >= 0.5, one
    assert isinstance(one["score_clusters"], float) and one["records"] > 80000
    p = {"algorithm": "B", "doi": doi(rig, a, [{"system": "urn:x-barge:sensor:bow", "output": "weather",
                                                 "fields": ["air_temperature", "relative_humidity", "pressure"]}]),
         "clusters": 4, "sensitivity": 5}
    st = rig.wait(rig.command(AN, "clustering", p).json()["id"])
    rid = st[-1]["message"].split(": ")[1]
    settle(rig, lambda: runs(rig, AN, a).get(rid, {}).get("status") == "complete")
    run = runs(rig, AN, a)[rid]
    assert run["algorithm"] == "B" and run["resolution"] == "PT1M" and run["records"] > 1400
    assert isinstance(run["score_clusters"], float), run
    assert {x["run_id"] for x in rows(rig, AN, f"clusters__{a}")} >= {f"analysis-{a}-1", rid}  # appended (FR-28a)


def test_at13_a_new_model_registers_and_processes_every_dataset(rig):
    import example_new_model

    a = rig.dataset("MISSION_A")
    runner = rig.rt.local.add(example_new_model.MODEL())
    settle(rig, lambda: runner.phase == "live" and runner.completed)
    subs = rig.get(f"/systems/{rig.sid('models')}/subsystems", {"f": "application/sml+json"})[1]["items"]
    assert "urn:x-barge:process:new-model-1" in {s["uniqueId"] for s in subs}
    d = ds_of(rig, "urn:x-barge:process:new-model-1", f"wind-chill__{a}")
    fields = rig.get(f"/datastreams/{d['id']}/schema", {"obsFormat": "application/swe+json"})[1]["recordSchema"]["fields"]
    assert [(f["name"], f["type"]) for f in fields] == [("time", "Time"), ("run_id", "Text"), ("wind_chill", "Quantity")]
    obs = rig.obs(d["id"], {"limit": "100000"})
    assert len(obs) == 1440 and isinstance(obs[0]["wind_chill"], float)
    assert rows(rig, "urn:x-barge:process:new-model-1", f"runs__{a}")[-1]["status"] == "complete"
    rig.rt.local.runners.remove(runner)


def test_at61_a_new_model_cannot_read_co2(rig):
    """AT-61, FR-113: a new model's service account reads Data cleanse's weather output, never its CO₂."""
    import asyncio

    import csmodel
    from barge.accounts import password_of

    a = rig.dataset("MISSION_A")
    local = rig.rt.local
    api = csmodel.Api("new-model-2", local._transport, "svc-new-model-2", password_of("svc-new-model-2"))
    loop = rig.rt.loop

    async def go():
        ok = await api.find(DC, f"cleaned-bow__{a}")
        await api.read(ok, 1933286400, 1933290000)
        bad = await api.find(DC + ":restricted", f"cleaned-co2-bow__{a}")
        with pytest.raises(csmodel.Refused):
            await api.read(bad, 1933286400, 1933290000)
    loop.run_until_complete(go())


def test_at14_a_failing_model_leaves_the_rest_running(rig):
    import csmodel

    class Broken(csmodel.Model):
        id, label, window = "new-model-2", "New model 2", 3600.0

        async def process(self, api, ds, t0, t1, run):
            raise RuntimeError("a bug in a new model")

    broken = rig.rt.local.add(Broken())
    for _ in range(30):
        rig.step()
    assert broken.phase == "failed" and "a bug in a new model" in broken.detail
    assert all(x.phase == "live" for x in rig.rt.local.runners if x is not broken)
    assert rig.get("/")[0] == 200
    assert "urn:x-barge:process:new-model-2" in rig.systems()  # it registered first
    rig.rt.local.runners.remove(broken)


def test_importing_a_dataset_starts_runs_on_it_and_a_restart_starts_none(rig):
    st = rig.wait(rig.command(IMPORTER, "import", {"action": "import", "file": "MISSION_C_20310421.csv"}).json()["id"])
    assert st[-1]["statusCode"] == "COMPLETED"
    c = rig.dataset("MISSION_C")
    settle(rig, lambda: live(rig) and all(runs(rig, u, c).get(f"{m}-{c}-1", {}).get("status") == "complete"
                                          for u, m in ((DC, "data-cleanse"), (SUM, "summaries"), (AN, "analysis"))))
    stern = rows(rig, SUM, f"summary-1min-stern__{c}")
    assert len(stern) == 720 and "apparent_wind_speed" not in stern[0]  # Mission C's stern has no wind speed
    # After a restart the models register again; results persist, so no new run is needed (D-228).
    before = {u: rows(rig, u, f"runs__{c}") for u in (DC, SUM, AN)}
    rig.rt.restart_server()
    rig.ready()
    for _ in range(20):
        rig.step()
    assert live(rig)
    assert {u: rows(rig, u, f"runs__{c}") for u in (DC, SUM, AN)} == before
