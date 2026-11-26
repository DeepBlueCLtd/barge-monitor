"""The contract suite for the HTTP seam (AT-02, AT-06, AT-24).

Written against a minimal async client, so the *same* tests run against the
application under uvicorn in CPython, in Pyodide behind the relay, and
against the JavaScript stand-in (PR-04).

A client provides ``async request(method, path, params=None, body=None,
headers=None)`` returning ``(status, headers, body)``, where body is parsed
JSON when the response is JSON and text otherwise. Paths are relative to the
API base.
"""
from __future__ import annotations

import json
import traceback
from pathlib import Path

TESTS = []
SOSA = "http://www.w3.org/ns/sosa/"
CS1 = "http://www.opengis.net/spec/ogcapi-connectedsystems-1/1.0/conf/"
CS2 = "http://www.opengis.net/spec/ogcapi-connectedsystems-2/1.0/conf/"


def test(fn):
    TESTS.append(fn)
    return fn


class Skip(Exception):
    pass


def contracts_dir() -> Path:
    here = Path(__file__).resolve().parent
    for cand in (here.parent / "contracts", here.parent.parent / "contracts"):
        if cand.is_dir():
            return cand
    raise FileNotFoundError("contracts")


class Ctx:
    def __init__(self, client):
        self.c = client
        self.dir = contracts_dir()
        import jsonschema
        from referencing import Registry, Resource

        self._js = jsonschema
        resources = []
        for p in sorted((self.dir / "schemas").glob("*.json")):
            doc = json.loads(p.read_text())
            resources.append((doc["$id"], Resource.from_contents(doc)))
        prof = json.loads((self.dir / "profile.schema.json").read_text())
        resources.append((prof["$id"], Resource.from_contents(prof)))
        self.registry = Registry().with_resources(resources)
        self.base = "https://deepbluecltd.github.io/barge-monitor/contracts/"

    def validate(self, instance, name):
        uri = self.base + ("profile.schema.json" if name == "profile" else f"schemas/{name}.json")
        v = self._js.Draft202012Validator({"$ref": uri}, registry=self.registry)
        v.validate(instance)

    async def get(self, path, params=None, headers=None):
        return await self.c.request("GET", path, params=params, headers=headers)

    async def ds(self, system_id, output):
        st, _, body = await self.get(f"systems/{system_id}/datastreams")
        assert st == 200, body
        for d in body["items"]:
            if d["outputName"] == output:
                return d
        raise AssertionError(f"no {output} datastream on {system_id}")


def refused(st, body, status, name):
    assert st == status, f"expected {status}, got {st}: {body}"
    assert isinstance(body, dict) and body.get("refused") == name, f"refusal should name {name!r}: {body}"


@test
async def landing_links_profile_and_carries_instance(ctx):
    st, h, body = await ctx.get("")
    assert st == 200
    ctx.validate(body, "landing")
    rels = {lk["rel"] for lk in body["links"]}
    assert {"self", "service-desc", "conformance", "data", "systems", "datastreams", "profile"} <= rels
    inst = h.get("x-server-instance")
    assert inst and h.get("etag", "").strip('"') == inst


@test
async def conformance_declares_the_subset(ctx):
    st, _, body = await ctx.get("conformance")
    assert st == 200
    ctx.validate(body, "conformance")
    c = set(body["conformsTo"])
    for need in ("system", "subsystem", "property", "sensorml"):
        assert CS1 + need in c, need
    for need in ("datastream", "controlstream", "json", "swecommon-json"):
        assert CS2 + need in c, need
    for absent in ("deployment", "procedure", "sf", "advanced-filtering", "update", "system-event", "swecommon-text", "swecommon-binary"):
        assert CS1 + absent not in c and CS2 + absent not in c, absent


@test
async def profile_is_served_valid_and_claimed(ctx):
    st, _, prof = await ctx.get("profile")
    assert st == 200
    ctx.validate(prof, "profile")
    _, _, conf = await ctx.get("conformance")
    assert prof["id"] in conf["conformsTo"]


@test
async def systems_have_the_standard_types_and_no_location(ctx):
    st, _, body = await ctx.get("systems")
    assert st == 200
    ctx.validate(body, "page")
    by = {s["id"]: s for s in body["items"]}
    for s in by.values():
        ctx.validate(s, "system")
    assert by["barge"]["systemType"] == SOSA + "Platform"
    assert by["models"]["systemType"] == SOSA + "System" and by["models"]["assetType"] == "Process"
    _, _, subs = await ctx.get("systems/barge/subsystems")
    types = {s["id"]: s["systemType"] for s in subs["items"]}
    assert types == {"bow": SOSA + "Sensor", "stern": SOSA + "Sensor"}
    _, _, models = await ctx.get("systems/models/subsystems")
    found = {s["id"]: s for s in models["items"]}
    for m in ("data-cleanse", "summaries", "analysis"):  # each model registered itself (FR-28)
        assert found[m]["systemType"] == SOSA + "System" and found[m]["assetType"] == "Process", m


@test
async def sensor_schema_has_qc_category_per_quantity(ctx):
    d = await ctx.ds("bow", "weather")
    ctx.validate(d, "datastream")
    st, _, body = await ctx.get(f"datastreams/{d['id']}/schema")
    refused(st, body, 400, "obsFormat")
    st, _, body = await ctx.get(f"datastreams/{d['id']}/schema", {"obsFormat": "application/swe+json"})
    assert st == 200 and body["obsFormat"] == "application/swe+json"
    rec = body["recordSchema"]
    ctx.validate(rec, "swe-record")
    names = {f["name"]: f for f in rec["fields"]}
    for f in rec["fields"]:
        if f["type"] == "Quantity":
            q = names[f["name"] + "_qc"]
            assert q["type"] == "Category" and f["quality"] == [{"href": f"#{f['name']}_qc"}]
    st, _, body = await ctx.get(f"datastreams/{d['id']}/schema", {"obsFormat": "application/json"})
    assert st == 200 and "resultSchema" in body


@test
async def observations_are_swe_json_and_poll_by_phenomenon_time(ctx):
    d = await ctx.ds("stern", "weather")
    st, h, latest = await ctx.get(f"datastreams/{d['id']}/observations", {"resultTime": "latest"})
    assert st == 200 and h.get("content-type", "").startswith("application/swe+json"), h
    assert isinstance(latest, list) and len(latest) == 1
    last = latest[0]["time"]
    st, _, body = await ctx.get(f"datastreams/{d['id']}/observations", {"phenomenonTime": f"{last}/..", "limit": "5"})
    assert st == 200 and body and body[0]["time"] >= last
    st, _, body = await ctx.get(f"datastreams/{d['id']}/observations", {"resultTime": "latest", "f": "application/json"})
    assert st == 200
    ctx.validate(body, "page")
    ctx.validate(body["items"][0], "observation")


@test
async def observations_page_and_refuse_oversize(ctx):
    d = await ctx.ds("bow", "weather")
    st, h, body = await ctx.get(f"datastreams/{d['id']}/observations", {"limit": "3"})
    assert st == 200 and len(body) == 3 and 'rel="next"' in h.get("link", "")
    st, _, body = await ctx.get(f"datastreams/{d['id']}/observations", {"limit": "100000000"})
    refused(st, body, 400, "limit")
    assert "maximum" in body["description"]


@test
async def refuses_what_is_not_implemented_by_name(ctx):
    st, _, body = await ctx.get("deployments")
    refused(st, body, 404, "deployments")
    st, _, body = await ctx.get("systems", {"q": "barge"})
    refused(st, body, 400, "q")
    st, _, body = await ctx.get("systems", {"colour": "red"})
    refused(st, body, 400, "colour")
    d = await ctx.ds("bow", "weather")
    st, _, body = await ctx.get(f"datastreams/{d['id']}/observations", {"f": "application/swe+text"})
    refused(st, body, 400, "f:application/swe+text")
    st, _, body = await ctx.c.request("PATCH", "systems/barge", body={})
    refused(st, body, 405, "PATCH")
    ctx.validate(body, "exception")


@test
async def every_model_publishes_its_datastreams(ctx):
    expect = {"data-cleanse": {"cleaned-bow", "cleaned-stern"},
              "summaries": {"summary-1min-bow", "summary-1min-stern", "summary-1h-bow", "summary-1h-stern",
                          "derived-1min", "derived-1h"},
              "analysis": {"changes", "clusters", "correlation", "runs"}}
    for sysid, outs in expect.items():
        st, _, body = await ctx.get(f"systems/{sysid}/datastreams")
        assert st == 200 and outs <= {d["outputName"] for d in body["items"]}, (sysid, body)
    d = await ctx.ds("summaries", "summary-1min-bow")
    st, _, body = await ctx.get(f"datastreams/{d['id']}/schema", {"obsFormat": "application/swe+json"})
    defs = {f["name"]: f.get("definition") for f in body["recordSchema"]["fields"]}
    assert defs["air_temperature"].endswith("/def/air_temperature")  # a mean keeps its property (FR-29)
    st, _, obs = await ctx.get(f"datastreams/{d['id']}/observations", {"resultTime": "latest"})
    assert st == 200 and len(obs) == 1 and obs[0]["time"].endswith(":00Z")


@test
async def control_stream_bounds_live_in_its_schema(ctx):
    st, _, body = await ctx.get("systems/analysis/controlstreams")
    cs = body["items"][0]
    st, _, sch = await ctx.get(f"controlstreams/{cs['id']}/schema")
    fields = {f["name"]: f for f in sch["parametersSchema"]["fields"]}
    lo, hi = fields["clusters"]["constraint"]["intervals"][0]
    st, _, body = await ctx.c.request("POST", f"controlstreams/{cs['id']}/commands", body={"parameters": {"clusters": hi + 1}})
    refused(st, body, 400, "clusters")
    assert str(hi) in body["description"]
    st, _, body = await ctx.c.request("POST", f"controlstreams/{cs['id']}/commands", body={"parameters": {"algorithm": "Z"}})
    refused(st, body, 400, "algorithm")
    st, _, body = await ctx.c.request("POST", f"controlstreams/{cs['id']}/commands", body={"parameters": {"fields": "colour"}})
    refused(st, body, 400, "fields")
    st, h, body = await ctx.c.request("POST", f"controlstreams/{cs['id']}/commands", body={"parameters": {"clusters": lo}})
    assert st == 201, body
    ctx.validate(body, "command")
    assert body["currentStatus"] == "PENDING"  # the model takes it up on its own time
    st, _, status = await ctx.get(f"commands/{body['id']}/status")
    assert [s["statusCode"] for s in status["items"]][0] == "PENDING"


@test
async def model_results_carry_settings_range_and_scores(ctx):
    d = await ctx.ds("analysis", "runs")
    st, _, body = await ctx.get(f"datastreams/{d['id']}/observations", {"resultTime": "latest"})
    assert st == 200 and body
    r = body[0]
    for k in ("run_id", "algorithm", "fields", "period", "window_start", "window_end", "records", "clusters",
              "score_changes", "score_clusters", "scored_against", "illustrative"):
        assert k in r, k
    for out in ("changes", "clusters", "correlation"):
        dd = await ctx.ds("analysis", out)
        st, _, obs = await ctx.get(f"datastreams/{dd['id']}/observations", {"limit": "1"})
        assert st == 200
        if obs:
            assert obs[0]["run_id"].startswith("run-")


SWE = {"content-type": "application/swe+json"}
DEF = "https://deepbluecltd.github.io/barge-monitor/def/"


@test
async def a_model_registers_by_ordinary_resource_creation(ctx):
    """FR-28, AT-13: what every model does, done here by hand: a system, a datastream, observations."""
    post = lambda path, body, headers=None: ctx.c.request("POST", path, body=body, headers=headers)
    sysm = {"uniqueId": "urn:x-barge:process:contract-probe", "label": "Contract probe", "description": "Made by the contract suite."}
    st, h, body = await post("systems/models/subsystems", sysm)
    assert st in (201, 409), body  # 409 when the suite has run against this server before
    sid = h["location"].rstrip("/").rsplit("/", 1)[-1]
    st, h2, body = await post("systems/models/subsystems", sysm)
    refused(st, body, 409, "uniqueId")  # the same system again: its Location, not a second system
    assert h2["location"] == h["location"]
    st, _, got = await ctx.get(f"systems/{sid}")
    assert st == 200 and got["uniqueId"] == sysm["uniqueId"] and got["assetType"] == "Process"
    ctx.validate(got, "system")
    st, _, subs = await ctx.get("systems/models/subsystems")
    assert sid in {x["id"] for x in subs["items"]}

    rec = {"type": "DataRecord", "name": "record", "label": "Probe", "fields": [
        {"type": "Time", "name": "time", "label": "Time", "definition": "http://www.opengis.net/def/property/OGC/0/SamplingTime",
         "uom": {"href": "http://www.opengis.net/def/uom/ISO-8601/0/Gregorian"}},
        {"type": "Quantity", "name": "probe_value", "label": "Probe value", "definition": DEF + "probe_value", "uom": {"code": "1"}},
        {"type": "Count", "name": "probe_count", "label": "Probe count", "definition": DEF + "probe_count"},
        {"type": "Category", "name": "probe_kind", "label": "Probe kind", "definition": DEF + "probe_kind",
         "codeSpace": DEF + "probe_kind", "constraint": {"type": "AllowedTokens", "values": ["a", "b"]}}]}
    made = {"name": "Probe", "outputName": "probe", "schema": {"obsFormat": "application/swe+json", "recordSchema": rec}}
    st, h, body = await post(f"systems/{sid}/datastreams", made)
    assert st in (201, 409), body
    ds = h["location"].rstrip("/").rsplit("/", 1)[-1]
    st, _, d = await ctx.get(f"datastreams/{ds}")
    assert st == 200 and d["outputName"] == "probe" and d["system@id"] == sid
    ctx.validate(d, "datastream")
    st, _, sch = await ctx.get(f"datastreams/{ds}/schema", {"obsFormat": "application/swe+json"})
    assert [f["name"] for f in sch["recordSchema"]["fields"]] == ["time", "probe_value", "probe_count", "probe_kind"]

    rows = [{"time": "2031-04-07T00:00:10Z", "probe_value": 1.5, "probe_count": 2, "probe_kind": "a"},
            {"time": "2031-04-07T00:00:20Z", "probe_value": None, "probe_count": 3, "probe_kind": "b"}]
    st, _, body = await ctx.c.request("PUT", f"datastreams/{ds}/observations", body=rows, headers=SWE)
    assert st == 200 and body["created"] == 2, body  # PUT: these, in place of whatever was there
    st, _, body = await post(f"datastreams/{ds}/observations", [{"time": "2031-04-07T00:00:30Z", "probe_value": 2.25}], SWE)
    assert st == 201 and body["created"] == 1, body
    st, _, obs = await ctx.get(f"datastreams/{ds}/observations")
    assert st == 200 and obs == rows + [{"time": "2031-04-07T00:00:30Z", "probe_value": 2.25, "probe_count": None, "probe_kind": None}], obs

    st, _, body = await post(f"datastreams/{ds}/observations", [{"time": "2031-04-07T00:00:40Z", "colour": 1}], SWE)
    refused(st, body, 400, "colour")
    st, _, body = await post(f"datastreams/{ds}/observations", [{"probe_value": 1}], SWE)
    refused(st, body, 400, "time")
    st, _, body = await post(f"datastreams/{ds}/observations", rows)
    refused(st, body, 415, "content-type:application/json")


@test
async def creation_outside_a_models_own_system_is_refused_by_name(ctx):
    st, _, body = await ctx.c.request("POST", "systems", body={"uniqueId": "urn:x", "label": "x"})
    refused(st, body, 405, "POST")  # a model's system goes under Models, not at the top
    st, _, body = await ctx.c.request("POST", "systems/barge/subsystems", body={"uniqueId": "urn:x", "label": "x"})
    refused(st, body, 405, "POST")
    st, _, body = await ctx.c.request("POST", "systems/bow/datastreams", body={})
    refused(st, body, 405, "POST")
    d = await ctx.ds("bow", "weather")
    st, _, body = await ctx.c.request("POST", f"datastreams/{d['id']}/observations", body=[], headers=SWE)
    refused(st, body, 405, "POST")  # a sensor's observations come from the store
    st, _, body = await ctx.c.request("DELETE", f"datastreams/{d['id']}")
    refused(st, body, 405, "DELETE")
    st, _, body = await ctx.c.request("PUT", "systems/summaries", body={})
    refused(st, body, 405, "PUT")


@test
async def a_model_reads_its_commands_and_reports_their_status(ctx):
    st, _, body = await ctx.get("systems/data-cleanse/controlstreams")
    cs = body["items"][0]["id"]
    st, _, cmd = await ctx.c.request("POST", f"controlstreams/{cs}/commands", body={"parameters": {"spike_threshold": 6}})
    assert st == 201, cmd
    st, _, waiting = await ctx.get(f"controlstreams/{cs}/commands", {"statusCode": "PENDING"})
    assert st == 200 and all(c["currentStatus"] == "PENDING" for c in waiting["items"]), waiting
    st, _, body = await ctx.get(f"controlstreams/{cs}/commands", {"statusCode": "SOMETIMES"})
    refused(st, body, 400, "statusCode")
    st, _, body = await ctx.c.request("POST", f"commands/{cmd['id']}/status", body={"statusCode": "DONE"})
    refused(st, body, 400, "statusCode")
    st, _, body = await ctx.c.request("POST", f"commands/{cmd['id']}/status", body={"statusCode": "ACCEPTED", "message": "by the suite"})
    assert st == 201 and body["statusCode"] == "ACCEPTED", body
    st, _, status = await ctx.get(f"commands/{cmd['id']}/status")
    assert [s["statusCode"] for s in status["items"]][:2] == ["PENDING", "ACCEPTED"]
    st, _, waiting = await ctx.get(f"controlstreams/{cs}/commands", {"statusCode": "PENDING"})
    assert cmd["id"] not in {c["id"] for c in waiting["items"]}


@test
async def openapi_is_served(ctx):
    st, _, body = await ctx.get("api")
    assert st == 200 and body["openapi"].startswith("3.1")
    master = json.loads((ctx.dir / "openapi.json").read_text())
    body.pop("servers", None)  # FastAPI adds the mount point, which differs between hosts
    master.pop("servers", None)
    assert body == master, "the served OpenAPI differs from contracts/openapi.json"


async def run(client, only=None) -> list[dict]:
    """Run every test; never raises. One result per test."""
    ctx = Ctx(client)
    results = []
    for fn in TESTS:
        if only and fn.__name__ not in only:
            continue
        try:
            await fn(ctx)
            results.append({"test": fn.__name__, "outcome": "passed"})
        except Skip as s:
            results.append({"test": fn.__name__, "outcome": "skipped", "detail": str(s)})
        except Exception as e:  # noqa: BLE001
            results.append({"test": fn.__name__, "outcome": "failed", "detail": f"{type(e).__name__}: {e}",
                            "trace": traceback.format_exc(limit=3)})
    return results
