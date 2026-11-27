"""The contract suite for the HTTP seam (PR-04, AT-02, AT-24, AT-32): server-neutral.

Written against a minimal async client, so the *same* tests run against the CPython application
under uvicorn, against the JavaScript stand-in in Node, in Pyodide behind the relay, and against a
configured OpenSensorHub. It never relies on a server's identifiers: it finds everything by uniqueId
and outputName, as the display client does, and it carries credentials (§9.3).

A client provides:

* ``async request(method, path, params=None, body=None, headers=None)`` returning ``(status, headers,
  body)``, where body is ``read_body(content)``: parsed JSON whenever the body is JSON, whatever its
  ``Content-Type`` says (OpenSensorHub labels some JSON ``auto``, D-196), and text otherwise; paths are
  relative to the API base;
* ``async open_stream(path, params=None, headers=None, internal=False)`` returning an object with
  ``status``, ``async next_line(timeout)`` (a line, or None) and ``async close()``: a push subscription
  (§9.2), on the internal endpoint (``/api-internal``) when ``internal``.

Tests are in two groups. ``NEED``: what this system needs of any server. ``STANDIN``: what the
stand-ins also do, to stay faithful to OpenSensorHub (§9.1); a stock OpenSensorHub is not expected to
be run against these. There is no replay controller and no gateway (4.7).
"""
from __future__ import annotations

import asyncio
import base64
import json
import traceback
from pathlib import Path

NEED, STANDIN = [], []
URN = "urn:x-barge:"
SWE = "application/swe+json"
SML = "application/sml+json"  # SensorML is sent as this, never as application/json (D-194)
CS2 = "http://www.opengis.net/spec/ogcapi-connectedsystems-2/1.0/conf/"
DEF = "https://deepbluecltd.github.io/barge-monitor/def/"
TIME = {"type": "Time", "name": "time", "label": "Time", "definition": "http://www.opengis.net/def/property/OGC/0/SamplingTime",
        "uom": {"href": "http://www.opengis.net/def/uom/ISO-8601/0/Gregorian"}}
DEMO = {"owner": "demo-owner", "friend": "demo-friend", "analyst": "demo-analyst", "svc-importer": "svc-demo",
        "svc-new-model-2": "svc-demo"}  # labelled demo credentials (PR-07)


def need(fn):
    NEED.append(fn)
    return fn


def standin(fn):
    STANDIN.append(fn)
    return fn


class Skip(Exception):
    pass


def read_body(content: bytes):
    """A response body as JSON whenever it is JSON, whatever the Content-Type says (D-196); else text."""
    text = content.decode("utf-8", errors="replace")
    if text.lstrip()[:1] in ("{", "["):
        try:
            return json.loads(text)
        except ValueError:
            pass
    return text


def contracts_dir() -> Path:
    here = Path(__file__).resolve().parent
    for cand in (here.parent / "contracts", here.parent.parent / "contracts"):
        if cand.is_dir():
            return cand
    raise FileNotFoundError("contracts")


def basic(user: str, password: str) -> str:
    return "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()


def location(headers: dict) -> str:
    return {k.lower(): v for k, v in headers.items()}["location"]


def last(href: str) -> str:
    return href.rstrip("/").rsplit("/", 1)[-1]


class Ctx:
    def __init__(self, client, accounts=None):
        self.c = client
        self.accounts = accounts or DEMO
        self.dir = contracts_dir()
        self._made = None
        self._co2 = None

    def auth(self, user="owner") -> dict:
        return {"Authorization": basic(user, self.accounts[user])}

    async def get(self, path, params=None, user="owner", headers=None):
        return await self.c.request("GET", path, params=params, headers={**(self.auth(user) if user else {}),
                                                                           **(headers or {})})

    async def post(self, path, body, user="owner", ctype="application/json"):
        return await self.c.request("POST", path, body=body, headers={**self.auth(user), "Content-Type": ctype})

    # --- finding things by uniqueId and outputName --------------------------------------------------
    async def systems(self, user="owner") -> dict:
        """uniqueId -> system id, from discovery: every system, subsystems included (D-193)."""
        st, _, body = await self.get("systems", {"searchMembers": "true", "f": SML, "limit": "100000"}, user=user)
        assert st == 200, (st, body)
        return {(s.get("uniqueId") or (s.get("properties") or {}).get("uid")): s["id"] for s in body["items"]}

    async def system(self, uid, user="owner"):
        return (await self.systems(user)).get(uid)

    async def datastreams(self, uid, user="owner") -> list:
        sid = await self.system(uid, user)
        assert sid, f"no system {uid}"
        st, _, body = await self.get(f"systems/{sid}/datastreams", {"limit": "100000"}, user=user)
        assert st == 200, (st, body)
        return body["items"]

    async def ds(self, uid, output, user="owner"):
        return next((d for d in await self.datastreams(uid, user) if d["outputName"] == output), None)

    async def weather(self, sensor="bow"):
        """A sensor's weather datastream of an imported dataset, ``weather__{dataset}``."""
        d = next((d for d in await self.datastreams(f"{URN}sensor:{sensor}") if d["outputName"].startswith("weather")), None)
        assert d, f"no weather datastream on the {sensor} sensor"
        return d

    async def cs(self, uid, name, user="owner"):
        sid = await self.system(uid, user)
        st, _, body = await self.get(f"systems/{sid}/controlstreams", user=user)
        assert st == 200, (st, body)
        return next((c for c in body["items"] if c["inputName"] == name), None)

    async def obs(self, ds_id, params=None, user="owner"):
        st, _, body = await self.get(f"datastreams/{ds_id}/observations", {"f": SWE, **(params or {})}, user=user)
        assert st == 200, (st, body)
        return json.loads(body) if isinstance(body, str) else body

    async def outcome(self, cs_id, cmd_id, user="owner"):
        """A command's outcome: its latest status report other than ``PENDING`` (D-199), or None."""
        st, _, body = await self.get(f"controlstreams/{cs_id}/status", {"limit": "100000"}, user=user)
        assert st == 200, (st, body)
        mine = [r for r in body["items"] if r.get("command@id") == cmd_id and r.get("statusCode") != "PENDING"]
        mine.sort(key=lambda r: r.get("reportTime") or "")  # stable: equal times keep the server's order
        return mine[-1] if mine else None

    def validate(self, instance, schema_file):
        import jsonschema

        jsonschema.Draft202012Validator(json.loads((self.dir / schema_file).read_text())).validate(instance)

    # --- resources the suite makes ------------------------------------------------------------------
    async def model_resources(self):
        """A model registers (FR-28) as svc-new-model-2: its system under Models, a datastream, a control stream."""
        if self._made:
            return self._made
        user = "svc-new-model-2"
        models = await self.system(URN + "process:models", user)
        uid = URN + "process:new-model-2"
        body = {"type": "SimpleProcess", "uniqueId": uid, "label": "New model 2", "description": "contract suite",
                "definition": "http://www.w3.org/ns/sosa/System", "assetType": "Process"}
        st, h, _ = await self.post(f"systems/{models}/subsystems", body, user, ctype=SML)
        assert st == 201, st
        loc = location(h)
        sid = last(loc)
        ds_body = {"name": "Suite", "outputName": "suite", "schema": {"obsFormat": SWE, "recordSchema": {
            "type": "DataRecord", "name": "record", "label": "Suite", "fields": [
                TIME, {"type": "Quantity", "name": "x", "label": "X", "definition": DEF + "x", "uom": {"code": "1"}}]}}}
        st, h, _ = await self.post(f"systems/{sid}/datastreams", ds_body, user)
        assert st == 201, st
        ds_loc = location(h)
        cs_body = {"name": "Suite", "inputName": "suite", "schema": {"commandFormat": "application/json", "parametersSchema": {
            "type": "DataRecord", "name": "record", "label": "Suite", "fields": [
                {"type": "Quantity", "name": "level", "label": "Level", "definition": DEF + "level",
                 "uom": {"code": "1"}, "constraint": {"type": "AllowedValues", "intervals": [[1, 10]]}}]}}}
        st, h, _ = await self.post(f"systems/{sid}/controlstreams", cs_body, user)
        assert st == 201, st
        self._made = {"user": user, "uid": uid, "system": sid, "loc": loc, "ds": last(ds_loc), "cs": last(location(h)),
                      "bodies": (body, ds_body, cs_body), "models": models}
        return self._made

    async def co2(self):
        """A CO₂ datastream under the bow's analyser, made as the importer makes them (§7), with one observation."""
        if self._co2:
            return self._co2
        an = await self.system(URN + "sensor:bow:co2")
        assert an, "no bow CO₂ analyser"
        body = {"name": "Bow CO₂ (suite)", "outputName": "co2__suite", "schema": {"obsFormat": SWE, "recordSchema": {
            "type": "DataRecord", "name": "record", "label": "CO₂", "fields": [
                TIME, {"type": "Quantity", "name": "co2", "label": "CO₂", "definition": DEF + "co2", "uom": {"code": "[ppm]"}}]}}}
        st, h, _ = await self.post(f"systems/{an}/datastreams", body, "svc-importer")
        assert st == 201, f"the importer's account could not create a CO₂ datastream: {st}"
        ds = last(location(h))
        st, _, _ = await self.post(f"datastreams/{ds}/observations", {"time": "2031-04-07T00:00:00Z", "co2": 431.0},
                                   "svc-importer", SWE)
        assert st in (200, 201), st
        self._co2 = {"system": an, "ds": ds}
        return self._co2


# --- what we need of any server -------------------------------------------------------------------------
@need
async def landing_and_conformance(x: Ctx):
    st, _, body = await x.get("")
    assert st == 200 and isinstance(body.get("links"), list), (st, body)
    st, _, body = await x.get("conformance")
    assert st == 200, (st, body)
    for cls in ("datastream", "controlstream", "swecommon-json"):
        assert CS2 + cls in body["conformsTo"], f"conformance does not claim {cls}"


@need
async def credentials_are_needed_everywhere(x: Ctx):
    """AT-49: every request without valid credentials is refused with 401, discovery and the profile included."""
    for path in ("", "systems", "datastreams", "profile.json"):
        st, _, _ = await x.get(path, user=None)
        assert st == 401, f"{path or '/'} without credentials answered {st}"
        st, _, _ = await x.c.request("GET", path, headers={"Authorization": basic("owner", "wrong")})
        assert st == 401, f"{path or '/'} with a wrong password answered {st}"
    d = await x.weather()
    st, _, _ = await x.get(f"datastreams/{d['id']}/observations", user=None)
    assert st == 401, f"observations without credentials answered {st}"


@need
async def every_system_is_found_by_unique_id(x: Ctx):
    """D-193: GET /systems?searchMembers=true lists every system, subsystems included."""
    sy = await x.systems()
    for uid in (URN + "platform:barge", URN + "sensor:bow", URN + "sensor:stern", URN + "sensor:bow:co2",
                URN + "sensor:stern:co2", URN + "process:models", URN + "workspace:owner"):
        assert uid in sy, f"{uid} not found by discovery"
    st, _, body = await x.get("systems", {"f": SML})
    top = {s["uniqueId"] for s in body["items"]}
    assert URN + "platform:barge" in top and URN + "sensor:bow" not in top, "GET /systems lists the top level only"
    st, _, body = await x.get(f"systems/{sy[URN + 'platform:barge']}/subsystems", {"f": SML})
    assert st == 200
    assert {URN + "sensor:bow", URN + "sensor:stern"} <= {s["uniqueId"] for s in body["items"]}


@need
async def the_profile_is_beside_the_server(x: Ctx):
    """FR-41: GET profile.json, with credentials; valid against its schema."""
    st, _, body = await x.get("profile.json")
    assert st == 200, st
    x.validate(json.loads(body) if isinstance(body, str) else body, "profile.schema.json")


@need
async def every_fixed_essential_is_found(x: Ctx):
    """FR-40, FR-40a: each essential the profile names, found by uniqueId and outputName, with its type and unit.
    A template essential (``{dataset}``) must be met by some dataset: the client checks each dataset when it opens
    it, and a dataset missing one is degraded, not the server (D-301)."""
    st, _, prof = await x.get("profile.json")
    prof = json.loads(prof) if isinstance(prof, str) else prof
    missing = []
    for e in prof["essentials"]:
        if e.get("kind") == "controlstream":
            if await x.cs(e["system"], e["datastream"]) is None:
                missing.append(e["id"])
            continue
        if "{dataset}" in e["datastream"]:
            prefix = e["datastream"].replace("{dataset}", "")
            found = [y for y in await x.datastreams(e["system"]) if y["outputName"].startswith(prefix)]
        else:
            d = await x.ds(e["system"], e["datastream"])
            found = [d] if d else []
        ok = False
        for d in found:
            st, _, sch = await x.get(f"datastreams/{d['id']}/schema", {"obsFormat": SWE})
            assert st == 200, (st, sch)
            f = next((f for f in sch["recordSchema"]["fields"] if f["name"] == e["field"]), None)
            if f is not None and f["type"] == e["type"] and (not e.get("uom") or (f.get("uom") or {}).get("code") == e["uom"]):
                ok = True
                break
        if not ok:
            missing.append(e["id"])
    assert not missing, f"essentials not found: {missing}"


@need
async def the_importer_offers_its_catalogue_and_import(x: Ctx):
    """§7: the importer's system, its ``catalogue`` datastream and ``import`` control stream, as the masters
    declare them; every catalogue row names a file, and ``records`` is 0 until the file is imported (D-197)."""
    uid = URN + "importer"
    assert await x.system(uid), "no importer system"
    d = await x.ds(uid, "catalogue")
    assert d, "no catalogue datastream"
    st, _, sch = await x.get(f"datastreams/{d['id']}/schema", {"obsFormat": SWE})
    assert st == 200, st
    master = json.loads((x.dir / "swe" / "catalogue-record.json").read_text())
    assert [(f["name"], f["type"]) for f in sch["recordSchema"]["fields"]] == [(f["name"], f["type"]) for f in master["fields"]]
    for r in await x.obs(d["id"], {"limit": "100000"}):
        assert r["file"] and r["status"] in ("not-imported", "importing", "imported", "changed", "superseded"), r
        if r["status"] in ("not-imported", "importing"):
            assert r["records"] == 0 and r["dataset"] == "", r
    c = await x.cs(uid, "import")
    assert c, "no import control stream"
    st, _, cs = await x.get(f"controlstreams/{c['id']}/schema")
    assert st == 200, st
    fields = {f["name"]: f for f in cs["parametersSchema"]["fields"]}
    assert list(fields) == ["action", "file"] and fields["action"]["constraint"]["values"] == ["import", "rescan"]


@need
async def a_sensor_record_has_quality_flags(x: Ctx):
    d = await x.weather()
    st, _, sch = await x.get(f"datastreams/{d['id']}/schema", {"obsFormat": SWE})
    assert st == 200
    fields = sch["recordSchema"]["fields"]
    assert fields[0]["type"] == "Time" and fields[0]["name"] == "time"
    at = next(f for f in fields if f["name"] == "air_temperature")
    assert at["uom"]["code"] == "Cel" and any(q.get("href") == "#air_temperature_qc" for q in at.get("quality", []))
    assert next(f for f in fields if f["name"] == "air_temperature_qc")["type"] == "Category"
    assert all("co2" not in f["name"] for f in fields), "CO₂ is never in the weather record (FR-21c)"


@need
async def observations_by_time_latest_and_offset(x: Ctx):
    """FR-26: phenomenonTime, an open interval, resultTime=latest, f=application/swe+json, paging by offset."""
    d = await x.weather()
    start = d["phenomenonTime"][0]
    a = await x.obs(d["id"], {"phenomenonTime": f"{start}/..", "limit": "20"})
    assert len(a) == 20 and a[0]["time"] == start, a[:1]
    b = await x.obs(d["id"], {"phenomenonTime": f"{start}/..", "limit": "10", "offset": "10"})
    assert b == a[10:], "paging by offset gives the next records"
    c = await x.obs(d["id"], {"phenomenonTime": f"{a[3]['time']}/{a[5]['time']}"})
    assert [r["time"] for r in c] == [r["time"] for r in a[3:6]]
    latest = await x.obs(d["id"], {"resultTime": "latest"})
    assert len(latest) >= 1 and latest[-1]["time"] >= a[-1]["time"]


@need
async def creating_again_answers_the_same_location(x: Ctx):
    """FR-28, AT-29: 201 with the existing Location is success."""
    r = await x.model_resources()
    body, ds_body, _ = r["bodies"]
    st, h, _ = await x.post(f"systems/{r['models']}/subsystems", body, r["user"], ctype=SML)
    assert st == 201 and location(h) == r["loc"], (st, h)
    st, h, _ = await x.post(f"systems/{r['system']}/datastreams", ds_body, r["user"])
    assert st == 201 and last(location(h)) == r["ds"], (st, h)


@need
async def one_observation_with_a_missing_value(x: Ctx):
    """§9.1: one observation per POST; a missing value is "NaN", returned as "NaN"."""
    r = await x.model_resources()
    for i, v in enumerate([1.5, "NaN"]):
        st, _, _ = await x.post(f"datastreams/{r['ds']}/observations", {"time": f"2031-04-07T00:00:0{i}Z", "x": v},
                                r["user"], ctype=SWE)
        assert st in (200, 201), st
    rows = await x.obs(r["ds"], {"phenomenonTime": "2031-04-07T00:00:00Z/2031-04-07T00:00:01Z"}, user=r["user"])
    assert [row["x"] for row in rows][-2:] == [1.5, "NaN"], rows


@need
async def commands_are_pushed_to_a_subscriber(x: Ctx):
    """FR-27, §9.2: a receiver's subscription on the internal endpoint gets each command at once, with every
    parameter and its sender; its outcome is the latest status report other than ``PENDING`` (D-199)."""
    r = await x.model_resources()
    s = await x.c.open_stream(f"controlstreams/{r['cs']}/commands", {"subscribe": "1"}, x.auth(r["user"]), internal=True)
    try:
        assert s.status == 200, s.status
        send = asyncio.ensure_future(x.post(f"controlstreams/{r['cs']}/commands", {"parameters": {"level": 3}}))
        line = await s.next_line(timeout=20)
        assert line, "no command was pushed"
        cmd = json.loads(line)
        assert cmd["parameters"] == {"level": 3} and cmd.get("id"), cmd
        assert cmd.get("sender") == "owner", f"a pushed command names its sender (D-152): {cmd}"
        st, _, _ = await x.post(f"controlstreams/{r['cs']}/status", {"command@id": cmd["id"], "statusCode": "COMPLETED"},
                                r["user"])
        assert st in (200, 201), st
        st, _, _ = await send
        assert st in (200, 201), st
        out = await x.outcome(r["cs"], cmd["id"])  # read after the sender's answer, as a client reads it (D-199)
        assert out and out["statusCode"] == "COMPLETED", out
    finally:
        await s.close()


@need
async def restricted_resources_are_listed_and_refused(x: Ctx):
    """FR-93 (4.7), AT-55, D-351: a weather-only role finds CO₂ systems listed and described, a stream's title and
    schema included (a stream's title may be known), and is refused (403) its contents, the observations; a role with
    emissions reads them."""
    c = await x.co2()
    friend = await x.systems("friend")
    assert URN + "sensor:bow:co2" in friend, "a restricted system is listed, as OpenSensorHub lists it"
    st, _, body = await x.get("datastreams", {"limit": "100000"}, user="friend")
    assert st == 200 and c["ds"] in {d["id"] for d in body["items"]}, "a restricted datastream is listed"
    for path, params in ((f"systems/{c['system']}", None), (f"datastreams/{c['ds']}", None),
                         (f"datastreams/{c['ds']}/schema", {"obsFormat": SWE})):
        st, _, _ = await x.get(path, params, user="friend")
        assert st == 200, f"{path} answered {st} for the friend: a stream's title and schema may be known (D-351)"
    for path, params in ((f"datastreams/{c['ds']}/observations", {"f": SWE}),
                         (f"datastreams/{c['ds']}/observations", {"f": SWE, "resultTime": "latest"})):
        st, _, _ = await x.get(path, params, user="friend")
        assert st == 403, f"{path} answered {st} for the friend"
        for user in ("owner", "analyst"):
            st, _, _ = await x.get(path, params, user=user)
            assert st == 200, f"{path} answered {st} for {user}"
    rows = await x.obs(c["ds"], user="owner")
    assert rows and rows[0]["co2"] == 431.0


@need
async def workspaces_are_private(x: Ctx):
    """FR-93, AT-52: another user's workspace is listed, but no account reads it."""
    owner = await x.systems("owner")
    ws = owner[URN + "workspace:owner"]
    assert URN + "workspace:friend" in owner
    st, _, _ = await x.get(f"systems/{ws}", user="owner")
    assert st == 200
    st, _, _ = await x.get(f"systems/{ws}", user="friend")
    assert st == 403, f"the friend read the owner's workspace: {st}"


@need
async def creating_only_under_ones_own_systems(x: Ctx):
    """§9.3, AT-52: a user creates only under its own workspace; a service account only under its own systems."""
    sy = await x.systems()
    r = await x.model_resources()
    _, ds_body, _ = r["bodies"]
    body = json.loads(json.dumps(ds_body))
    tries = ((sy[URN + "sensor:bow"], "friend"), (sy[URN + "workspace:owner"], "friend"),
             (sy[URN + "workspace:friend"], "owner"), (sy[URN + "process:data-cleanse"], r["user"]),
             (r["system"], "owner"))
    for sid, user in tries:
        st, _, _ = await x.post(f"systems/{sid}/datastreams", body, user)
        assert st == 403, f"{user} created a datastream under {sid}: {st}"
    st, _, _ = await x.post(f"datastreams/{r['ds']}/observations", {"time": "2031-04-07T00:00:09Z", "x": 1}, "owner", SWE)
    assert st == 403, f"the owner appended to a model's datastream: {st}"
    st, _, _ = await x.post(f"systems/{sy[URN + 'workspace:friend']}/datastreams", dict(body, outputName="mine"), "friend")
    assert st == 201, f"the friend could not create under its own workspace: {st}"


# --- what the stand-ins also do, to behave as OpenSensorHub (§9.1) -----------------------------------------
@standin
async def refusals_are_html_and_401_challenges(x: Ctx):
    """§9.1, §9.3: a refusal is an HTML page; 401 carries WWW-Authenticate: basic, as OpenSensorHub sends it
    (the relay drops it, D-226)."""
    st, h, _ = await x.get("", user=None)
    hl = {k.lower(): v for k, v in h.items()}
    assert st == 401 and hl.get("content-type", "").startswith("text/html"), (st, hl)
    assert hl.get("www-authenticate", "").lower() == "basic", hl
    st, h, _ = await x.get("systems/zzzz")
    assert st == 404 and {k.lower(): v for k, v in h.items()}.get("content-type", "").startswith("text/html")


@standin
async def put_patch_and_delete_are_not_allowed(x: Ctx):
    """§9.1, D-224: PUT, PATCH and DELETE are refused with 405 for every account, and nothing is removed."""
    sy = await x.systems()
    r = await x.model_resources()
    tries = (("PUT", f"systems/{sy[URN + 'sensor:bow']}", "owner"), ("DELETE", f"systems/{sy[URN + 'sensor:bow']}", "owner"),
             ("PATCH", f"systems/{r['system']}", r["user"]), ("DELETE", f"datastreams/{r['ds']}", r["user"]),
             ("DELETE", f"systems/{r['system']}", r["user"]), ("PUT", f"datastreams/{r['ds']}/observations", r["user"]))
    for method, path, user in tries:
        st, _, _ = await x.c.request(method, path, body=None if method == "DELETE" else {}, headers=x.auth(user))
        assert st == 405, f"{method} {path}: {st}"
    for path in (f"systems/{sy[URN + 'sensor:bow']}", f"datastreams/{r['ds']}", f"systems/{r['system']}"):
        st, _, _ = await x.get(path)
        assert st == 200, f"{path} is gone ({st})"


@standin
async def sensorml_as_json_and_codes_not_ucum_are_refused(x: Ctx):
    """D-194, D-195: SensorML sent as application/json is read as GeoJSON and refused; a unit code that is
    not UCUM (``ppm``; UCUM's is ``[ppm]``) is refused. OpenSensorHub does both."""
    r = await x.model_resources()
    body = {**r["bodies"][0], "uniqueId": r["uid"] + ":as-json"}
    st, _, _ = await x.post(f"systems/{r['system']}/subsystems", body, r["user"], ctype="application/json")
    assert st == 400, f"SensorML as application/json answered {st}"
    ds_body = json.loads(json.dumps(r["bodies"][1]))
    ds_body["outputName"] = "suite-ppm"
    ds_body["schema"]["recordSchema"]["fields"][1]["uom"] = {"code": "ppm"}
    st, _, _ = await x.post(f"systems/{r['system']}/datastreams", ds_body, r["user"])
    assert st == 400, f"a datastream in ppm answered {st}"
    ds_body["schema"]["recordSchema"]["fields"][1]["uom"] = {"code": "[ppm]"}
    st, _, _ = await x.post(f"systems/{r['system']}/datastreams", ds_body, r["user"])
    assert st == 201, f"a datastream in [ppm] answered {st}"


@standin
async def one_observation_per_post_and_nan_not_null(x: Ctx):
    r = await x.model_resources()
    st, _, _ = await x.post(f"datastreams/{r['ds']}/observations", [{"time": "2031-04-07T00:00:05Z", "x": 1}], r["user"], SWE)
    assert st == 400, f"an array answered {st}"
    st, _, _ = await x.post(f"datastreams/{r['ds']}/observations", {"time": "2031-04-07T00:00:05Z", "x": None}, r["user"], SWE)
    assert st == 400, f"null in a Quantity answered {st}"


@standin
async def accept_is_ignored_and_f_chooses(x: Ctx):
    d = await x.weather()
    st, h, body = await x.get(f"datastreams/{d['id']}/observations", {"limit": "2"}, headers={"Accept": SWE})
    assert st == 200 and isinstance(body, dict) and "items" in body, "the default is application/json resources"
    st, h, body = await x.get(f"datastreams/{d['id']}/observations", {"limit": "2", "f": SWE})
    assert isinstance(body, list) and {k.lower(): v for k, v in h.items()}.get("link") is None, "no next link in SWE JSON"
    rows = await x.obs(d["id"], {"limit": "200001"})  # a limit over the maximum is served, not refused
    assert isinstance(rows, list)


@standin
async def no_instance_identifier_and_all_systems_items_refused(x: Ctx):
    st, h, _ = await x.get("")
    hl = {k.lower() for k in h}
    assert "x-server-instance" not in hl and "etag" not in hl
    st, _, _ = await x.get("collections/all_systems/items")
    assert st == 400, f"collections/all_systems/items answered {st}, as OpenSensorHub answers 400 (D-193)"


@standin
async def a_command_without_a_subscriber_is_dropped(x: Ctx):
    r = await x.model_resources()
    st, _, _ = await x.post(f"controlstreams/{r['cs']}/commands", {"parameters": {"level": 2}})
    assert st == 202, st
    st, _, body = await x.get(f"controlstreams/{r['cs']}/commands")
    assert st == 200 and not [c for c in body["items"] if c["parameters"] == {"level": 2}], "a dropped command is listed"


@standin
async def only_services_subscribe_on_the_internal_endpoint(x: Ctx):
    """D-223: receivers subscribe on /api-internal, for service accounts only."""
    r = await x.model_resources()
    path, q = f"controlstreams/{r['cs']}/commands", {"subscribe": "1"}
    for headers, internal, want in ((x.auth("owner"), True, 403), (x.auth(r["user"]), False, 403), ({}, True, 401)):
        s = await x.c.open_stream(path, q, headers, internal=internal)
        try:
            assert s.status == want, (headers.keys(), internal, s.status)
        finally:
            await s.close()


async def run(client, groups=("need", "standin"), accounts=None) -> list[dict]:
    """Run the suite; one result per test: {name, group, outcome, detail}. Never raises."""
    x = Ctx(client, accounts)
    out = []
    for group, tests in (("need", NEED), ("standin", STANDIN)):
        if group not in groups:
            continue
        for t in tests:
            try:
                await t(x)
                out.append({"name": t.__name__, "group": group, "outcome": "passed", "detail": ""})
            except Skip as e:
                out.append({"name": t.__name__, "group": group, "outcome": "skipped", "detail": str(e)})
            except Exception as e:  # noqa: BLE001 - reported, the suite goes on
                out.append({"name": t.__name__, "group": group, "outcome": "failed",
                            "detail": f"{type(e).__name__}: {e}\n{traceback.format_exc(limit=3)}"})
    return out
