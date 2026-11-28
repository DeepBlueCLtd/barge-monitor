"""The 4.7 masters in contracts/ (plan Phase 1): each is valid, uses UCUM codes, and agrees with the others."""
import json
from pathlib import Path

import jsonschema
import pytest

from barge.ucum import bad_codes

C = Path(__file__).resolve().parents[2] / "contracts"
SWE = sorted((C / "swe").rglob("*.json"))
URN = "urn:x-barge:"


def load(p):
    return json.loads(Path(p).read_text())


def fields(rec):
    return {f["name"]: f for f in rec["fields"]}


@pytest.mark.parametrize("path", SWE, ids=lambda p: str(p.relative_to(C)))
def test_every_swe_master_is_a_record_the_server_takes(path):
    rec = load(path)
    jsonschema.Draft202012Validator(load(C / "schemas" / "swe-record.json")).validate(rec)
    assert not bad_codes(rec), f"not UCUM: {bad_codes(rec)} (D-195)"
    if "controlstreams" not in path.parts:
        assert rec["fields"][0]["type"] == "Time" and rec["fields"][0]["name"] == "time"


def test_the_masters_named_in_the_interfaces_are_there():
    names = {str(p.relative_to(C / "swe")) for p in SWE}
    assert {"weather-record.json", "co2-record.json", "catalogue-record.json", "runs-data-cleanse.json",
            "runs-summaries.json", "runs-analysis.json", "controlstreams/import.json",
            "controlstreams/data-cleanse-settings.json", "controlstreams/summaries-settings.json",
            "controlstreams/analysis-clustering.json"} <= names
    assert fields(load(C / "swe" / "co2-record.json"))["co2"]["uom"]["code"] == "[ppm]"
    runs = fields(load(C / "swe" / "runs-analysis.json"))
    for n in ("run_id", "status", "done_until", "pct", "start", "end", "algorithm", "resolution", "records", "clusters",
              "score_changes", "score_clusters"):
        assert n in runs, n
    cl = fields(load(C / "swe" / "controlstreams" / "analysis-clustering.json"))
    assert list(cl) == ["algorithm", "doi", "clusters", "sensitivity"]
    assert cl["clusters"]["constraint"]["intervals"] == [[2, 8]] and cl["sensitivity"]["constraint"]["intervals"] == [[1, 10]]


def test_the_profile_is_valid():
    """The interim 4.1 profile (D-252) is retired with the 4.1 display client (D-301)."""
    jsonschema.Draft202012Validator(load(C / "profile.schema.json")).validate(load(C / "profile.json"))
    assert not (C / "interim").exists()


def test_the_profile_is_a_template_without_replay_and_never_co2():
    """FR-40, FR-40a (4.7): per-dataset templates, the catalogue and the import control stream; nothing of replay."""
    p = load(C / "profile.json")
    es = p["essentials"]
    assert not [e for e in es if "replay" in e["system"] or "replay" in e["id"]]
    assert not [e for e in es if "co2" in e["system"] or "co2" in e["field"]]
    tmpl = [e for e in es if e.get("scope") == "dataset"]
    assert tmpl and all(e["datastream"].endswith("__{dataset}") for e in tmpl)
    by = {e["id"]: e for e in es}
    assert by["catalogue"]["system"] == URN + "importer" and by["catalogue"].get("scope") == "fixed"
    assert by["import-control"]["kind"] == "controlstream" and by["import-control"]["datastream"] == "import"


def test_essentials_agree_with_the_swe_masters():
    p = load(C / "profile.json")
    masters = {"weather__{dataset}": "weather-record.json", "catalogue": "catalogue-record.json",
               "runs__{dataset}": "runs-analysis.json", "import": "controlstreams/import.json"}
    checked = 0
    for e in p["essentials"]:
        m = masters.get(e["datastream"])
        if not m:
            continue
        f = fields(load(C / "swe" / m)).get(e["field"])
        assert f, (e["id"], m)
        assert f["type"] == e["type"], e["id"]
        assert (f.get("uom") or {}).get("code") == e.get("uom"), e["id"]
        checked += 1
    assert checked >= 6


def test_the_importers_weather_record_is_the_master():
    """A file with every column gets the master's weather record (``importer.weather_schema``). The 4.1 logger's
    records, checked here before, are retired (D-320)."""
    from barge.fields import QUANTITIES
    from barge.importer import weather_schema

    served = weather_schema(list(QUANTITIES), "bow")
    master = load(C / "swe" / "weather-record.json")
    assert [(f["name"], f["type"], (f.get("uom") or {}).get("code")) for f in served["fields"]] == \
        [(f["name"], f["type"], (f.get("uom") or {}).get("code")) for f in master["fields"]]


def test_a_data_of_interest_record_validates():
    rec = {"version": 1, "label": "Lock at Hollin", "note": "", "tags": ["lock", "Hollin"],
           "dataset": {"file": "MISSION_A_20310407.csv", "size": 1, "modified": "2031-04-08T02:00:00Z", "sha256": "0" * 64},
           "start": "2031-04-07T06:00:00Z", "end": "2031-04-07T07:00:00Z", "resolution": "PT1M", "aggregation": "as-stored",
           "sources": [{"system": URN + "sensor:bow", "output": "weather", "fields": ["air_temperature"]}],
           "run": "analysis-mission-a-20310407-00000000-1", "created": {"at": "2031-04-07T08:00:00Z", "by": "owner"}}
    v = jsonschema.Draft202012Validator(load(C / "schemas" / "data-of-interest.json"))
    v.validate(rec)
    with pytest.raises(jsonschema.ValidationError):
        v.validate({**rec, "sources": []})
    v.validate({k: x for k, x in rec.items() if k != "tags"})  # older records have none (FR-105a)
    with pytest.raises(jsonschema.ValidationError):
        v.validate({**rec, "tags": [""]})
