"""The contract suite for the HTTP seam (PR-04, AT-02, AT-32): server-neutral.

Written against a minimal async client, so the *same* tests run against the CPython application
under uvicorn, against the JavaScript stand-in in Node, in Pyodide behind the relay, and against a
stock OpenSensorHub behind the access gateway. It never relies on a server's identifiers: it finds
everything by uniqueId and outputName, as the display client does, and carries credentials.

A client provides:

* ``async request(method, path, params=None, body=None, headers=None)`` returning ``(status, headers,
  body)``, where body is ``read_body(content)``: parsed JSON whenever the body is JSON, whatever its
  ``Content-Type`` says (OpenSensorHub labels some JSON ``auto``, D-196), and text otherwise; paths are
  relative to the API base;
* ``async open_stream(path, params=None, headers=None)`` returning an object with ``status``,
  ``async next_line(timeout)`` (a line, or None) and ``async close()``: a push subscription (§9.2).

Tests are in two groups. ``NEED``: what this system needs of any server (and of the gateway in
front of it). ``STANDIN``: what the stand-ins also do, to stay faithful to OpenSensorHub (§9.1);
a stock OpenSensorHub is not expected to be run against these.
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
DEMO = {"owner": "demo-owner", "friend": "demo-friend", "analyst": "demo-analyst",
        "svc-new-model-2": "svc-demo"}  # demo credentials (PR-07)


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


class Ctx:
    def __init__(self, client, accounts=None):
        self.c = client
        self.accounts = accounts or DEMO
        self.dir = contracts_dir()
        self._systems = {}

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
        out = {}
        for s in body["items"]:
            uid = s.get("uniqueId") or (s.get("properties") or {}).get("uid")
            out[uid] = s["id"]
        return out

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

    async def cs(self, uid, name, user="owner"):
        sid = await self.system(uid, user)
        st, _, body = await self.get(f"systems/{sid}/controlstreams", user=user)
        assert st == 200, (st, body)
        return next((c for c in body["items"] if c["inputName"] == name), None)

    async def obs(self, ds_id, params=None, user="owner"):
        st, _, body = await self.get(f"datastreams/{ds_id}/observations", {"f": SWE, **(params or {})}, user=user)
        assert st == 200, (st, body)
        if isinstance(body, str):
            body = json.loads(body)
        return body

    async def replay_state(self):
        d = await self.ds(URN + "replay", "state")
        assert d, "no replay state datastream"
        rows = await self.obs(d["id"], {"resultTime": "latest"})
        assert rows, "the replay state has no observation"
        return rows[-1]

    async def outcome(self, cs_id, cmd_id, user="owner"):
        """A command's outcome: its latest status report other than ``PENDING`` (D-199), or None.

        OpenSensorHub stores the sender's ``PENDING`` when the ``POST`` answers (after the hold), which can be
        after the receiver's ``COMPLETED``; the latest report alone would then read ``PENDING``."""
        st, _, body = await self.get(f"controlstreams/{cs_id}/status", {"limit": "100000"}, user=user)
        assert st == 200, (st, body)
        mine = [r for r in body["items"] if r.get("command@id") == cmd_id and r.get("statusCode") != "PENDING"]
        mine.sort(key=lambda r: r.get("reportTime") or "")  # stable: equal times keep the server's order
        return mine[-1] if mine else None

    def validate(self, instance, schema_file):
        import jsonschema

        jsonschema.Draft202012Validator(json.loads((self.dir / schema_file).read_text())).validate(instance)


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
    for path in ("", "systems", "systems?searchMembers=true", "datastreams", "profile.json"):
        st, _, _ = await x.get(path, user=None)
        assert st == 401, f"{path or '/'} without credentials answered {st}"
        st, _, _ = await x.c.request("GET", path, headers={"Authorization": basic("owner", "wrong")})
        assert st == 401, f"{path or '/'} with a wrong password answered {st}"
    cat = await x.ds(URN + "importer", "catalogue")
    st, _, _ = await x.get(f"datastreams/{cat['id']}/observations", user=None)
    assert st == 401, f"the catalogue without credentials answered {st}"


@need
async def the_platform_is_found_by_unique_id(x: Ctx):
    sy = await x.systems()
    for uid in (URN + "platform:barge", URN + "sensor:bow", URN + "sensor:stern", URN + "process:models",
                URN + "importer", URN + "replay"):
        assert uid in sy, f"{uid} not found by discovery"
    st, _, body = await x.get(f"systems/{sy[URN + 'platform:barge']}/subsystems")
    assert st == 200
    uids = {s.get("uniqueId") or s.get("properties", {}).get("uid") for s in body["items"]}
    assert {URN + "sensor:bow", URN + "sensor:stern"} <= uids, uids


@need
async def the_profile_is_beside_the_server(x: Ctx):
    """FR-41: GET profile.json, with credentials; valid against its schema."""
    st, _, body = await x.get("profile.json")
    assert st == 200, st
    if isinstance(body, str):
        body = json.loads(body)
    x.validate(body, "profile.schema.json")


@need
async def every_essential_of_the_loaded_dataset_is_found(x: Ctx):
    """FR-40, FR-40a: fixed essentials, and the templates filled with the current dataset."""
    st, _, prof = await x.get("profile.json")
    prof = json.loads(prof) if isinstance(prof, str) else prof
    state = await x.replay_state()
    for _ in range(60):  # a client checks a dataset only once the models are ready for it (§8)
        if state.get("models_ready"):
            break
        await asyncio.sleep(0.5)
        state = await x.replay_state()
    dataset = state["dataset"]
    missing = []
    for e in prof["essentials"]:
        out = e["datastream"].replace("{dataset}", dataset)
        if e.get("kind") == "controlstream":
            if await x.cs(e["system"], out) is None:
                missing.append(e["id"])
            continue
        d = await x.ds(e["system"], out)
        if d is None:
            missing.append(e["id"])
            continue
        st, _, sch = await x.get(f"datastreams/{d['id']}/schema", {"obsFormat": SWE})
        assert st == 200, (st, sch)
        f = next((f for f in sch["recordSchema"]["fields"] if f["name"] == e["field"]), None)
        if f is None or f["type"] != e["type"] or (e.get("uom") and (f.get("uom") or {}).get("code") != e["uom"]):
            missing.append(e["id"])
    assert not missing, f"essentials not found for {dataset}: {missing}"


@need
async def a_sensor_record_has_quality_flags(x: Ctx):
    state = await x.replay_state()
    d = await x.ds(URN + "sensor:bow", f"weather__{state['dataset']}")
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
    state = await x.replay_state()
    d = await x.ds(URN + "sensor:bow", f"weather__{state['dataset']}")
    a = await x.obs(d["id"], {"phenomenonTime": f"{state['start']}/..", "limit": "20"})
    assert len(a) == 20 and a[0]["time"] == state["start"], a[:1]
    b = await x.obs(d["id"], {"phenomenonTime": f"{state['start']}/..", "limit": "10", "offset": "10"})
    assert b == a[10:], "paging by offset gives the next records"
    c = await x.obs(d["id"], {"phenomenonTime": f"{a[3]['time']}/{a[5]['time']}"})
    assert [r["time"] for r in c] == [r["time"] for r in a[3:6]]
    latest = await x.obs(d["id"], {"resultTime": "latest"})
    assert len(latest) >= 1 and latest[-1]["time"] >= a[-1]["time"]


async def _model_resources(x: Ctx):
    """A model registers (FR-28) as svc-new-model-2: its system under Models, a datastream, a control stream."""
    user = "svc-new-model-2"
    models = await x.system(URN + "process:models", user)
    uid = URN + "process:new-model-2"
    body = {"type": "SimpleProcess", "uniqueId": uid, "label": "New model 2", "description": "contract suite",
            "definition": "http://www.w3.org/ns/sosa/System", "assetType": "Process"}
    st, h, _ = await x.post(f"systems/{models}/subsystems", body, user, ctype=SML)
    assert st == 201, st
    loc = {k.lower(): v for k, v in h.items()}["location"]
    sid = loc.rstrip("/").rsplit("/", 1)[-1]
    ds_body = {"name": "Suite", "outputName": "suite", "schema": {"obsFormat": SWE, "recordSchema": {
        "type": "DataRecord", "name": "record", "label": "Suite", "fields": [
            {"type": "Time", "name": "time", "label": "Time", "definition": "http://www.opengis.net/def/property/OGC/0/SamplingTime",
             "uom": {"href": "http://www.opengis.net/def/uom/ISO-8601/0/Gregorian"}},
            {"type": "Quantity", "name": "x", "label": "X", "definition": "https://deepbluecltd.github.io/barge-monitor/def/x",
             "uom": {"code": "1"}}]}}}
    st, h, _ = await x.post(f"systems/{sid}/datastreams", ds_body, user)
    assert st == 201, st
    ds_loc = {k.lower(): v for k, v in h.items()}["location"]
    cs_body = {"name": "Suite", "inputName": "suite", "schema": {"commandFormat": "application/json", "parametersSchema": {
        "type": "DataRecord", "name": "record", "label": "Suite", "fields": [
            {"type": "Quantity", "name": "level", "label": "Level", "definition": "https://deepbluecltd.github.io/barge-monitor/def/level",
             "uom": {"code": "1"}, "constraint": {"type": "AllowedValues", "intervals": [[1, 10]]}}]}}}
    st, h, _ = await x.post(f"systems/{sid}/controlstreams", cs_body, user)
    assert st == 201, st
    cs_loc = {k.lower(): v for k, v in h.items()}["location"]
    return {"user": user, "uid": uid, "system": sid, "loc": loc, "ds": ds_loc.rstrip("/").rsplit("/", 1)[-1],
            "cs": cs_loc.rstrip("/").rsplit("/", 1)[-1], "bodies": (body, ds_body, cs_body), "models": models}


@need
async def creating_again_answers_the_same_location(x: Ctx):
    """FR-28, AT-29: 201 with the existing Location is success."""
    r = await _model_resources(x)
    body, ds_body, _ = r["bodies"]
    st, h, _ = await x.post(f"systems/{r['models']}/subsystems", body, r["user"], ctype=SML)
    assert st == 201 and {k.lower(): v for k, v in h.items()}["location"] == r["loc"]
    st, h, _ = await x.post(f"systems/{r['system']}/datastreams", ds_body, r["user"])
    assert st == 201 and {k.lower(): v for k, v in h.items()}["location"].endswith("/" + r["ds"])


@need
async def one_observation_with_a_missing_value(x: Ctx):
    """§9.1: one observation per POST; a missing value is "NaN", returned as "NaN"."""
    r = await _model_resources(x)
    for i, v in enumerate([1.5, "NaN"]):
        st, _, _ = await x.post(f"datastreams/{r['ds']}/observations", {"time": f"2031-04-07T00:00:0{i}Z", "x": v},
                                r["user"], ctype=SWE)
        assert st in (200, 201), st
    rows = await x.obs(r["ds"], {"phenomenonTime": "2031-04-07T00:00:00Z/2031-04-07T00:00:01Z"}, user=r["user"])
    assert [row["x"] for row in rows][-2:] == [1.5, "NaN"], rows


@need
async def commands_are_pushed_to_a_subscriber(x: Ctx):
    """FR-27, §9.2: a receiver's subscription gets each command at once, with every parameter and its sender;
    its outcome is the latest status report other than ``PENDING`` (D-199)."""
    r = await _model_resources(x)
    s = await x.c.open_stream(f"controlstreams/{r['cs']}/commands", {"subscribe": "1"}, x.auth(r["user"]))
    try:
        assert s.status == 200, s.status
        send = asyncio.ensure_future(x.post(f"controlstreams/{r['cs']}/commands", {"parameters": {"level": 3}}))
        line = await s.next_line(timeout=20)
        assert line, "no command was pushed"
        cmd = json.loads(line)
        assert cmd["parameters"] == {"level": 3} and cmd.get("id"), cmd
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
async def the_friend_finds_no_co2(x: Ctx):
    """FR-93, AT-55: a restricted system is absent for a weather-only role: not listed, and 404 by id."""
    owner = await x.systems("owner")
    friend = await x.systems("friend")
    hidden = [u for u in owner if u.endswith(":co2") or u.endswith(":restricted")]
    assert hidden, "no restricted system to hide"
    assert not [u for u in friend if u in hidden], "restricted systems are listed for the friend"
    for path in ("datastreams", "controlstreams"):
        st, _, body = await x.get(path, {"limit": "100000"}, user="friend")
        assert st == 200
        assert not [d for d in body["items"] if "co2" in json.dumps(d).lower()], f"CO₂ in {path} for the friend"
    for uid in hidden:
        st, _, _ = await x.get(f"systems/{owner[uid]}", user="friend")
        assert st == 404, f"{uid} by id answered {st}"
    state = await x.replay_state()
    d = await x.ds(URN + "sensor:bow:co2", f"co2__{state['dataset']}")
    if d:
        for path in (f"datastreams/{d['id']}", f"datastreams/{d['id']}/observations", f"datastreams/{d['id']}/schema"):
            st, _, _ = await x.get(path, user="friend")
            assert st == 404, f"{path} answered {st} for the friend"


@need
async def workspaces_are_private(x: Ctx):
    """FR-93, AT-52: no account reads another user's workspace."""
    owner = await x.systems("owner")
    friend = await x.systems("friend")
    assert URN + "workspace:owner" in owner and URN + "workspace:friend" not in owner
    assert URN + "workspace:friend" in friend and URN + "workspace:owner" not in friend
    st, _, _ = await x.get(f"systems/{owner[URN + 'workspace:owner']}", user="friend")
    assert st == 404, st


# --- what the stand-ins also do, to behave as OpenSensorHub (§9.1) -----------------------------------------
@standin
async def refusals_are_html_without_a_login_dialog(x: Ctx):
    st, h, body = await x.get("", user=None)
    hl = {k.lower(): v for k, v in h.items()}
    assert st == 401 and hl.get("content-type", "").startswith("text/html"), (st, hl)
    assert "www-authenticate" not in hl, "the browser must never show its own login dialog (D-153)"
    st, h, _ = await x.get("systems/zzzz")
    assert st == 404 and {k.lower(): v for k, v in h.items()}.get("content-type", "").startswith("text/html")


@standin
async def put_and_delete_are_not_allowed(x: Ctx):
    """§9.1, D-200: ``PUT`` and ``DELETE`` are refused with a 4xx, and nothing is replaced or deleted. In front of
    OpenSensorHub (which deletes on ``DELETE``) the gateway refuses them with 405 for every account."""
    sy = await x.systems()
    r = await _model_resources(x)
    tries = (("PUT", f"systems/{sy[URN + 'sensor:bow']}", "owner"), ("DELETE", f"systems/{sy[URN + 'sensor:bow']}", "owner"),
             ("DELETE", f"datastreams/{r['ds']}", r["user"]), ("DELETE", f"systems/{r['system']}", r["user"]))
    for method, path, user in tries:
        st, _, _ = await x.c.request(method, path, body={} if method == "PUT" else None, headers=x.auth(user))
        assert 400 <= st < 500, f"{method} {path}: {st}"
    for path in (f"systems/{sy[URN + 'sensor:bow']}", f"datastreams/{r['ds']}", f"systems/{r['system']}"):
        st, _, _ = await x.get(path)
        assert st == 200, f"{path} is gone ({st})"


@standin
async def sensorml_as_json_and_codes_not_ucum_are_refused(x: Ctx):
    """D-194, D-195: SensorML sent as application/json is read as GeoJSON and refused; a unit code that is
    not UCUM (``ppm``; UCUM's is ``[ppm]``) is refused. OpenSensorHub does both."""
    r = await _model_resources(x)
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
    r = await _model_resources(x)
    st, _, _ = await x.post(f"datastreams/{r['ds']}/observations", [{"time": "2031-04-07T00:00:05Z", "x": 1}], r["user"], SWE)
    assert st == 400, f"an array answered {st}"
    st, _, _ = await x.post(f"datastreams/{r['ds']}/observations", {"time": "2031-04-07T00:00:05Z", "x": None}, r["user"], SWE)
    assert st == 400, f"null in a Quantity answered {st}"


@standin
async def accept_is_ignored_and_f_chooses(x: Ctx):
    state = await x.replay_state()
    d = await x.ds(URN + "sensor:bow", f"weather__{state['dataset']}")
    st, h, body = await x.get(f"datastreams/{d['id']}/observations", {"limit": "2"}, headers={"Accept": SWE})
    assert st == 200 and isinstance(body, dict) and "items" in body, "the default is application/json resources"
    assert {k.lower(): v for k, v in h.items()}.get("link") is None
    rows = await x.obs(d["id"], {"limit": "200001"})  # a limit over the maximum is served, not refused
    assert isinstance(rows, list)


@standin
async def no_instance_identifier(x: Ctx):
    st, h, _ = await x.get("")
    hl = {k.lower() for k in h}
    assert "x-server-instance" not in hl and "etag" not in hl


@standin
async def a_command_without_a_subscriber_is_dropped(x: Ctx):
    r = await _model_resources(x)
    st, _, _ = await x.post(f"controlstreams/{r['cs']}/commands", {"parameters": {"level": 2}})
    assert st == 202, st
    st, _, body = await x.get(f"controlstreams/{r['cs']}/commands")
    assert st == 200 and not [c for c in body["items"] if c["parameters"] == {"level": 2}], "a dropped command is listed"


@standin
async def only_services_subscribe(x: Ctx):
    r = await _model_resources(x)
    s = await x.c.open_stream(f"controlstreams/{r['cs']}/commands", {"subscribe": "1"}, x.auth("owner"))
    try:
        assert s.status in (401, 403), s.status
    finally:
        await s.close()
    s = await x.c.open_stream(f"controlstreams/{r['cs']}/commands", {"subscribe": "1"}, {})
    try:
        assert s.status == 401, s.status
    finally:
        await s.close()


async def run(client, groups=("need", "standin"), accounts=None) -> list[dict]:
    """Run the suite; one result per test: {name, group, outcome, detail}."""
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
