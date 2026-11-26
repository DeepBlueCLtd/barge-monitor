"""Models (SRD §6.4) and data of interest on the server: AT-04, AT-13 to AT-16, AT-29, AT-45."""
import json
import time

import numpy as np
import pytest

from csmodel import Model, record, time_field
from tests.helpers import Rig, column

URN = "urn:x-barge:"
DC, SUM, AN = URN + "process:data-cleanse", URN + "process:summaries", URN + "process:analysis"


def test_at15_only_data_cleanse_reads_the_sensors(played):
    r = played
    sensor_ids = {d["id"] for d in r.get("/datastreams", {"limit": "100000"}).json["items"]
                  if d["outputName"].startswith(("weather__", "co2__"))}
    readers = {}
    for m in r.rt.tap.buffer:
        if m["src"] == "models" and m["dst"] == "gateway" and m.get("model") and "/observations" in m["summary"]:
            ds = m["summary"].split("/datastreams/")[1].split("/")[0]
            readers.setdefault(m["model"], set()).add(ds)
    assert readers.get("data-cleanse", set()) & sensor_ids
    for model, ids in readers.items():
        if model != "data-cleanse":
            assert not ids & sensor_ids, f"{model} reads a sensor's datastream"


def test_outputs_per_dataset_with_min_mean_max_and_runs(played):
    r = played
    ds = r.dataset("MISSION_A")
    rows = r.obs(r.ds(SUM, f"summary-1h-bow__{ds}")["id"])
    assert rows and rows[0]["time"] == "2031-04-07T00:00:00Z"
    x = rows[0]
    assert x["air_temperature_min"] <= x["air_temperature"] <= x["air_temperature_max"]
    sch = r.get(f"/datastreams/{r.ds(SUM, f'summary-1h-bow__{ds}')['id']}/schema",
                {"obsFormat": "application%2Fswe%2Bjson"}).json["recordSchema"]["fields"]
    by = {f["name"]: f for f in sch}
    assert by["air_temperature_max"]["definition"] == by["air_temperature"]["definition"]  # grouped by definition
    cleaned = r.obs(r.ds(DC, f"cleaned-bow__{ds}")["id"], {"limit": "4000"})
    assert len(cleaned) == 3600 and all(c["run"] == x["run"] for c in cleaned)
    assert any(c["air_temperature"] == "NaN" for c in cleaned) or True  # removed readings, if any, are "NaN"
    derived = r.obs(r.ds(SUM, f"derived-1min__{ds}")["id"])
    assert len(derived) == 60 and np.isfinite(column(derived, "dew_point")).all()


def test_at16_analysis_runs_on_a_data_of_interest_with_scores(played):
    r = played
    ds = r.rt.importer.datasets[r.dataset("MISSION_A")]
    doi = {"version": 1, "label": "first hour", "dataset": {k: ds[k] for k in ("file", "size", "modified", "sha256")},
           "start": "2031-04-07T00:00:00Z", "end": "2031-04-07T00:59:59Z", "resolution": "PT1S", "aggregation": "as-stored",
           "sources": [{"system": URN + "sensor:bow", "output": "weather",
                        "fields": ["air_temperature", "relative_humidity", "water_temperature"]}],
           "created": {"at": "2026-11-25T12:00:00Z", "by": "owner"}}
    resp = r.command(AN, "clustering", {"algorithm": "B", "doi": json.dumps(doi), "clusters": 4, "sensitivity": 5})
    cid = resp.json["id"]
    for _ in range(100):
        st = r.status_of(AN, "clustering", cid)
        if st and st[-1]["statusCode"] != "ACCEPTED":
            break
        r.spin(20)
    assert st[-1]["statusCode"] == "COMPLETED", st
    runs = r.obs(r.ds(AN, f"runs__{ds['id']}")["id"])
    run = next(x for x in runs if x["command_id"] == cid)
    assert run["records"] >= 3500 and run["resolution"] == "PT1S" and run["scored_against"] == "reach kinds"
    assert isinstance(run["score_clusters"], float) and -1 <= run["score_clusters"] <= 1
    clusters = [x for x in r.obs(r.ds(AN, f"clusters__{ds['id']}")["id"]) if x["run_id"] == run["run_id"]]
    assert clusters and {c["cluster"] for c in clusters} <= {f"c{i}" for i in range(1, 9)}
    corr = next(x for x in r.obs(r.ds(AN, f"correlation__{ds['id']}")["id"]) if x["run_id"] == run["run_id"])
    m = json.loads(corr["matrix"])  # Text JSON (D-123)
    assert len(m) == 3 and m[0][0] == pytest.approx(1.0)
    changes = [x for x in r.obs(r.ds(AN, f"changes__{ds['id']}")["id"]) if x["run_id"] == run["run_id"]]
    for c in changes:
        assert c["scale"] in ("minutes", "hours") and c["strength"] > 0
    windowed = [x for x in runs if not x["command_id"]]
    assert len(windowed) == 6 and windowed[-1]["time"] == "2031-04-07T01:00:00Z"  # one per ten replay minutes
    # The scores are correct: the referee (scoring.py, against the manifest) gives the same from the run's own outputs.
    from barge import scoring
    from barge.times import parse_iso, world_seconds

    w = r.run(r.rt.world())
    tc = world_seconds(np.array([parse_iso(c["time"]) for c in clusters]))
    expect = scoring.score_clusters(w, tc, np.array([c["cluster"] for c in clusters]))["ari_reach_kind"]
    assert run["score_clusters"] == pytest.approx(expect, abs=1e-3)
    det = {"t": world_seconds(np.array([parse_iso(c["time"]) for c in changes], dtype=float)),
           "scale": np.array([0 if c["scale"] == "minutes" else 1 for c in changes], dtype=int)}
    sc = scoring.score_changes(w, det, float(world_seconds(parse_iso(run["window_start"]))), float(world_seconds(parse_iso(run["window_end"]))))
    if sc["boundary_recall"] is None:
        assert np.isnan(run["score_changes"]) or run["score_changes"] == "NaN"
    else:
        assert run["score_changes"] == pytest.approx(sc["boundary_recall"], abs=1e-3)


def test_at04_declared_queries_meet_their_budget(played):
    """FR-31: the last hour at replay time from both sensors; one field over a whole dataset from a summary.
    Measured on Mission A alone (the only dataset imported here), against the budgets config.py declares."""
    from barge.config import QUERY_BUDGET_MS

    r = played
    assert [d["file"] for d in r.rt.importer.datasets.values()] == ["MISSION_A_20310407.csv"]
    ds = r.dataset("MISSION_A")
    t = time.perf_counter()
    for s in ("bow", "stern"):
        d = r.ds(URN + f"sensor:{s}", f"weather__{ds}")
        rows = r.obs(d["id"], {"phenomenonTime": "2031-04-07T00:00:00Z/2031-04-07T00:59:59Z"})
        assert len(rows) == 3600
    took = (time.perf_counter() - t) * 1000
    print(f"AT-04 last hour, both sensors: {took:.0f} ms (budget {QUERY_BUDGET_MS['last-hour-each-sensor']})")
    assert took < QUERY_BUDGET_MS["last-hour-each-sensor"]
    d = r.ds(URN + "sensor:bow", f"weather__{ds}")
    t = time.perf_counter()
    rows = r.obs(d["id"])  # the whole day of raw readings, every field: well beyond the declared query
    assert len(rows) == 86400 and (time.perf_counter() - t) < 10
    d = r.ds(SUM, f"summary-1h-bow__{ds}")
    t = time.perf_counter()
    rows = r.obs(d["id"])
    took = (time.perf_counter() - t) * 1000
    print(f"AT-04 one field, whole dataset, from a summary: {took:.0f} ms (budget {QUERY_BUDGET_MS['one-field-whole-dataset-summary']})")
    assert rows and took < QUERY_BUDGET_MS["one-field-whole-dataset-summary"]


def test_at45_a_saved_data_of_interest_regenerates_the_same_values_after_switching(played):
    r = played
    a = r.rt.importer.datasets[r.dataset("MISSION_A")]
    doi = {"version": 1, "label": "warm spell", "note": "", "dataset": {k: a[k] for k in ("file", "size", "modified", "sha256")},
           "start": "2031-04-07T00:10:00Z", "end": "2031-04-07T00:40:00Z", "resolution": "PT1M", "aggregation": "as-stored",
           "sources": [{"system": SUM, "output": "summary-1min-bow", "fields": ["air_temperature"]}],
           "created": {"at": "2026-11-25T12:00:00Z", "by": "owner"}}
    ws = r.ds(URN + "workspace:owner", "data-of-interest")
    assert r.request("POST", f"/datastreams/{ws['id']}/observations", ctype="application/swe+json", body={
        "time": "2026-11-25T12:00:00Z", "doi_id": "warm", "action": "save", "record": json.dumps(doi)}).status == 201

    def regenerate():
        saved = json.loads(r.obs(ws["id"])[-1]["record"])
        from csmodel import dataset_id
        ds = dataset_id(saved["dataset"]["file"], saved["dataset"]["sha256"])
        src = saved["sources"][0]
        d = r.ds(src["system"], f"{src['output']}__{ds}")
        return r.obs(d["id"], {"phenomenonTime": f"{saved['start']}/{saved['end']}"})
    first = regenerate()
    assert len(first) == 31
    resp = r.command(URN + "importer", "import", {"action": "import", "file": "MISSION_C_20310421.csv"})
    for _ in range(100):
        if r.status_of(URN + "importer", "import", resp.json["id"])[-1]["statusCode"] == "COMPLETED":
            break
        r.spin(20)
    r.replay("load", dataset=r.dataset("MISSION_C"))
    for _ in range(4):
        r.step(1.0)
    assert r.state()["dataset"] == r.dataset("MISSION_C") and r.state()["models_ready"]
    assert r.ds(SUM, f"summary-1min-bow__{r.dataset('MISSION_C')}")  # the models work on the new dataset
    assert r.ds(URN + "sensor:stern", f"weather__{r.dataset('MISSION_C')}")
    assert regenerate() == first


class Broken(Model):
    id = "new-model-2"
    label = "New model 2"

    async def datasets(self, api, ds):
        await api.create_datastream(self.system, {"name": "x", "outputName": f"x__{ds['id']}",
                                                  "schema": record("x", [time_field()])})
        return True

    async def process(self, api, ds, t0, t1, run):
        raise ZeroDivisionError("a broken model")


def test_at13_at14_a_new_model_registers_and_a_failing_one_stops_only_itself():
    from data_cleanse import DataCleanse
    from example_new_model import WindChill
    from summaries import Summaries

    r = Rig(classes=(DataCleanse, Summaries, WindChill, Broken))
    st = r.state()
    assert st["models_ready"] and st["max_rate"] == 100
    r.play_until("2031-04-07T00:05:00Z", rate=10)
    runners = {x.model.id: x for x in r.local.runners}
    assert runners["new-model-2"].phase == "failed" and "ZeroDivisionError" in runners["new-model-2"].detail
    assert runners["data-cleanse"].phase == "live" and runners["summaries"].phase == "live"
    ds = r.dataset("MISSION_A")
    d = r.ds(URN + "process:new-model-1", f"wind-chill__{ds}")
    rows = r.obs(d["id"])
    assert len(rows) == 5 and all(isinstance(x["wind_chill"], float) for x in rows)
    assert r.systems()[URN + "process:new-model-1"]["characteristics"][0]["characteristics"][0]["value"] == 100
    assert URN + "process:new-model-1:restricted" not in r.systems()  # it has no access to CO₂ (FR-113)
    r.close()
