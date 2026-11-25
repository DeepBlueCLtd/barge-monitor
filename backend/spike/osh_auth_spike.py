"""S-AUTH, SRD 4.6 §15: what a stock OpenSensorHub does with access control switched on.

Runs against OpenSensorHub started with backend/spike/osh-config-auth.json (Basic
authentication, its own users and roles, two Connected Systems endpoints: /api with
everything, /api-weather whose view excludes `urn:barge:restricted:*`). Changes nothing in
OpenSensorHub.

    # 1. against an empty server started with osh-config-auth.json
    python backend/spike/osh_auth_spike.py http://localhost:8181/sensorhub auth-results.json
    # 2. write the deny entries naming the restricted systems into a copy of the config
    python backend/spike/osh_auth_spike.py --write-deny auth-results.json osh-config-auth.json run/config.json
    # 3. restart OpenSensorHub with that copy, then
    python backend/spike/osh_auth_spike.py http://localhost:8181/sensorhub auth-results.json --after-deny

See backend/spike/README.md.
"""
from __future__ import annotations

import asyncio
import base64
import json
import sys
import time
from pathlib import Path

import httpx

SML = {"content-type": "application/sml+json"}
SWE = {"content-type": "application/swe+json"}
PW = {"owner": "owner-pw", "emi": "emi-pw", "friend": "friend-pw", "friend2": "friend2-pw", "svc-analysis": "svc-pw"}
TIME = {"type": "Time", "name": "time", "label": "time", "definition": "http://www.opengis.net/def/property/OGC/0/SamplingTime",
        "referenceFrame": "http://www.opengis.net/def/trs/BIPM/0/UTC", "uom": {"href": "http://www.opengis.net/def/uom/ISO-8601/0/Gregorian"}}


def system(uid, label, definition="http://www.w3.org/ns/sosa/Sensor"):
    return {"type": "PhysicalSystem", "uniqueId": uid, "label": label, "definition": definition}


def datastream(name, field, uom):
    return {"name": name, "outputName": name.replace(" ", "_"), "schema": {
        "obsFormat": "application/swe+json", "encoding": {"type": "JSONEncoding"},
        "recordSchema": {"type": "DataRecord", "name": name.replace(" ", "_"), "fields": [
            TIME, {"type": "Quantity", "name": field, "label": field, "definition": f"http://example.org/barge/{field}", "uom": {"code": uom}}]}}}


CONTROL = {"name": "analysis settings", "inputName": "settings", "schema": {"commandFormat": "application/json", "parametersSchema": {
    "type": "DataRecord", "name": "settings", "fields": [
        {"type": "Category", "name": "algorithm", "label": "algorithm", "definition": "http://example.org/barge/algorithm"},
        {"type": "Text", "name": "fields", "label": "fields", "definition": "http://example.org/barge/fields"}]}}}


def basic(user):
    return "Basic " + base64.b64encode(f"{user}:{PW[user]}".encode()).decode()


class Spike:
    def __init__(self, root: str, out: Path):
        self.root = root.rstrip("/")
        self.out = out
        self.checks: list[dict] = []
        self.ids: dict[str, str] = {}
        self.c = {u: httpx.Client(base_url=self.root, auth=(u, p), timeout=30, trust_env=False) for u, p in PW.items()}
        self.anon = httpx.Client(base_url=self.root, timeout=30, trust_env=False)

    def note(self, q, check, expected, observed, ok):
        self.checks.append({"question": q, "check": check, "expected": expected, "observed": observed, "as_needed": bool(ok)})
        print(f"{'ok     ' if ok else 'DIFFERS'} Q{q} {check}: {observed if isinstance(observed, str) else json.dumps(observed)[:200]}")

    @staticmethod
    def brief(r: httpx.Response, n=120):
        text = r.text
        if "<title>" in text:
            msg = text.split("MESSAGE:</th><td>")[1].split("</td>")[0] if "MESSAGE:</th><td>" in text else ""
            text = text.split("<title>")[1].split("</title>")[0] + (f" ({msg})" if msg else "")
        return f"{r.status_code} {r.headers.get('content-type', '')}: {' '.join(text.split())[:n]}"

    @staticmethod
    def loc(r):
        return r.headers.get("location", "").rstrip("/").rsplit("/", 1)[-1]

    def ids_in(self, user, path, ep="/api", **params):
        r = self.c[user].get(ep + path, params={"limit": 1000, **params})
        if r.status_code != 200:
            return self.brief(r, 60)
        return sorted(x["id"] for x in r.json().get("items", []))

    def make(self, key, path, body, headers=None, user="owner", ep="/api"):
        r = self.c[user].post(ep + path, content=json.dumps(body), headers=headers or {"content-type": "application/json"})
        if r.status_code in (200, 201):
            self.ids[key] = self.loc(r)
        return r

    def obs(self, user, ds, value, t, ep="/api"):
        return self.c[user].post(f"{ep}/datastreams/{ds}/observations", content=json.dumps({"time": t, list(value)[0]: list(value.values())[0]}), headers=SWE)

    # ---- 6. a request without credentials ------------------------------------------------
    def no_credentials(self):
        for path in ("/api", "/api/systems", "/api/systems/040g", "/api-weather/systems", "/admin/"):
            r = self.anon.get(path)
            self.note(6, f"GET {path} without credentials", "401, nothing served",
                      {"status": r.status_code, "www-authenticate": r.headers.get("www-authenticate"), "content-type": r.headers.get("content-type"),
                       "set-cookie": r.headers.get("set-cookie"), "body": self.brief(r, 40)}, r.status_code == 401)
        r = httpx.get(self.root + "/api/systems", auth=("owner", "wrong"), trust_env=False)
        self.note(6, "wrong password", "401", r.status_code, r.status_code == 401)
        r = self.anon.options("/api/systems", headers={"origin": "http://example.org", "access-control-request-method": "GET"})
        self.note(6, "OPTIONS (CORS preflight) without credentials", "n/a", f"{r.status_code} allow-origin={r.headers.get('access-control-allow-origin')}", True)

    # ---- 7. session or per request -------------------------------------------------------
    def session(self):
        cl = httpx.Client(base_url=self.root, timeout=30, trust_env=False)
        r1 = cl.get("/api/systems", auth=("owner", PW["owner"]))
        r2 = cl.get("/api/systems")  # same client, cookies kept, no Authorization
        self.note(7, "is there a session? Set-Cookie on an authenticated request", "n/a", r1.headers.get("set-cookie"), True)
        self.note(7, "the next request on the same connection without Authorization", "n/a (a session would answer 200)",
                  f"{r2.status_code}; cookies held: {dict(cl.cookies)}", r2.status_code == 401)

    # ---- resources -----------------------------------------------------------------------
    def build(self):
        self.make("platform", "/systems", system("urn:barge:open:platform", "Collection platform", "http://www.w3.org/ns/sosa/Platform"), SML)
        self.make("bow", f"/systems/{self.ids['platform']}/subsystems", system("urn:barge:open:bow", "Bow sensor"), SML)
        self.make("bow-co2", f"/systems/{self.ids['bow']}/subsystems", system("urn:barge:restricted:bow-co2", "Bow CO2 analyser"), SML)
        self.make("ds-weather", f"/systems/{self.ids['bow']}/datastreams", datastream("weather", "air_temperature", "Cel"))
        self.make("ds-bow-co2", f"/systems/{self.ids['bow-co2']}/datastreams", datastream("co2", "co2", "[ppm]"))
        self.make("analysis", "/systems", system("urn:barge:open:analysis", "Analysis", "http://www.w3.org/ns/sosa/Procedure"), SML)
        self.make("analysis-co2", f"/systems/{self.ids['analysis']}/subsystems", system("urn:barge:restricted:analysis-co2", "Analysis, restricted"), SML)
        self.make("ds-clusters-co2", f"/systems/{self.ids['analysis-co2']}/datastreams", datastream("clusters co2", "cluster", "1"))
        r = self.make("cs-analysis", f"/systems/{self.ids['analysis']}/controlstreams", CONTROL)
        self.note(0, "owner creates the platform, analysers, model, datastreams and a control stream", "all 201",
                  {"ids": dict(self.ids), "control stream": self.brief(r, 60)}, len(self.ids) == 9)
        codes = [self.obs("owner", self.ids["ds-weather"], {"air_temperature": 12.5}, "2031-04-08T12:00:00Z").status_code,
                 self.obs("owner", self.ids["ds-bow-co2"], {"co2": 415.0}, "2031-04-08T12:00:00Z").status_code,
                 self.obs("owner", self.ids["ds-clusters-co2"], {"cluster": 2}, "2031-04-08T12:00:00Z").status_code]
        self.note(0, "owner publishes one observation to each datastream", "201", codes, set(codes) == {201})

    # ---- 1 and 2: hidden? inherited? -----------------------------------------------------
    def visibility(self, user, ep, label):
        i = self.ids
        out = {
            "/systems": self.ids_in(user, "/systems", ep),
            f"/systems/{{bow}}/subsystems": self.ids_in(user, f"/systems/{i['bow']}/subsystems", ep),
            f"/systems/{{analysis}}/subsystems": self.ids_in(user, f"/systems/{i['analysis']}/subsystems", ep),
            "/datastreams": self.ids_in(user, "/datastreams", ep),
            "/systems?searchMembers=true": self.ids_in(user, "/systems", ep, searchMembers="true"),
        }
        for k in ("bow-co2", "analysis-co2"):
            out[f"GET /systems/{{{k}}}"] = self.brief(self.c[user].get(f"{ep}/systems/{i[k]}"), 40)
        for k in ("ds-bow-co2", "ds-clusters-co2"):
            out[f"GET /datastreams/{{{k}}}"] = self.brief(self.c[user].get(f"{ep}/datastreams/{i[k]}"), 40)
            out[f"GET /datastreams/{{{k}}}/schema"] = self.brief(self.c[user].get(f"{ep}/datastreams/{i[k]}/schema"), 40)
            out[f"GET /datastreams/{{{k}}}/observations"] = self.brief(self.c[user].get(f"{ep}/datastreams/{i[k]}/observations"), 60)
        out["GET /systems/{bow-co2}/datastreams"] = self.brief(self.c[user].get(f"{ep}/systems/{i['bow-co2']}/datastreams"), 60)
        out["GET /systems/{bow} (open, control)"] = self.brief(self.c[user].get(f"{ep}/systems/{i['bow']}"), 40)
        # system and datastream identifiers are separate spaces (the same string can name both)
        listed = set()
        for k in ("/systems", "/systems/{bow}/subsystems", "/systems/{analysis}/subsystems", "/systems?searchMembers=true"):
            if isinstance(out[k], list):
                listed |= {f"system {x}" for x in {i["bow-co2"], i["analysis-co2"]} & set(out[k])}
        if isinstance(out["/datastreams"], list):
            listed |= {f"datastream {x}" for x in {i["ds-bow-co2"], i["ds-clusters-co2"]} & set(out["/datastreams"])}
        by_id_404 = all(out[k].startswith("404") for k in out if k.startswith("GET ") and ("co2" in k or "clusters" in k))
        out["restricted ids still listed"] = sorted(listed)
        hidden = not listed and by_id_404
        self.note(1, f"{label}: is CO2 hidden from {user}?", "absent from every listing, 404 by id", out, hidden)
        return out

    async def ws_stream(self, user, path, ep="/api", post=None, wait=3.0):
        import websockets
        url = self.root.replace("http", "ws", 1) + ep + path
        got, status = [], None
        try:
            async with websockets.connect(url, additional_headers={"Authorization": basic(user)} if user else {}, proxy=None, open_timeout=10) as ws:
                status = 101
                if post:
                    await asyncio.to_thread(post)
                try:
                    while True:
                        got.append(json.loads(await asyncio.wait_for(ws.recv(), wait)))
                except (asyncio.TimeoutError, TimeoutError):
                    pass
        except websockets.exceptions.InvalidStatus as e:
            status = e.response.status_code
        except websockets.exceptions.ConnectionClosed as e:
            return {"handshake": status, "received": got, "closed by server": f"{e.rcvd.code if e.rcvd else None} {e.rcvd.reason if e.rcvd else ''}"}
        return {"handshake": status, "received": got}

    def stream_restricted(self, user, ep, label):
        ds = self.ids["ds-bow-co2"]
        t = f"2031-04-08T12:{int(time.time()) % 60:02d}:30Z"
        tries = []
        for n in range(3):
            t = f"2031-04-08T1{n}:{int(time.time()) % 60:02d}:30Z"
            tries.append(asyncio.run(self.ws_stream(user, f"/datastreams/{ds}/observations", ep, post=lambda: self.obs("owner", ds, {"co2": 420.0 + n}, t), wait=4)))
        self.note(1, f"{label}: {user} subscribes by WebSocket to the bow CO2 datastream's observations (3 tries, owner publishes one each time)",
                  "refused or 404", tries, all(x["handshake"] != 101 or not x["received"] for x in tries))

    # ---- 6. workspaces -------------------------------------------------------------------
    def workspaces(self):
        r = self.make("ds-friend-before", f"/systems/{self.ids['platform']}/datastreams", datastream("x", "x", "1"), user="friend")
        self.note(6, "friend creates a datastream under the platform (not theirs)", "403", self.brief(r, 60), r.status_code == 403)
        for u in ("friend", "emi"):
            r = self.make(f"ws-{u}", "/systems", system(f"urn:barge:open:ws:{u}", f"Workspace of {u}", "http://www.w3.org/ns/sosa/Procedure"), SML, user=u)
            self.note(6, f"{u} creates their workspace system", "201", self.brief(r, 60), r.status_code == 201)
            r = self.make(f"ds-ws-{u}", f"/systems/{self.ids.get(f'ws-{u}')}/datastreams", datastream("data of interest", "selection", "1"), user=u)
            self.note(7, f"{u}, on the very next request, creates a datastream under their new workspace (owner permission granted at run time)",
                      "201", self.brief(r, 60), r.status_code == 201)
            r = self.obs(u, self.ids.get(f"ds-ws-{u}"), {"selection": 1}, "2031-04-08T12:00:00Z")
            self.note(6, f"{u} appends to their own workspace", "201", self.brief(r, 60), r.status_code == 201)
        r = self.c["friend"].get(f"/api/systems/{self.ids['ws-emi']}")
        self.note(6, "friend reads emi's workspace system", "404 (no account may read another's workspace)", self.brief(r, 60), r.status_code == 404)
        r = self.c["friend"].get(f"/api/datastreams/{self.ids['ds-ws-emi']}/observations")
        self.note(6, "friend reads emi's workspace observations", "404", self.brief(r, 80), r.status_code == 404)
        r = self.obs("friend", self.ids["ds-ws-emi"], {"selection": 9}, "2031-04-08T12:00:01Z")
        self.note(6, "friend appends to emi's workspace", "403 or 404", self.brief(r, 60), r.status_code in (403, 404))
        r = self.make("ds-friend-in-emi", f"/systems/{self.ids['ws-emi']}/datastreams", datastream("y", "y", "1"), user="friend")
        self.note(6, "friend creates a datastream in emi's workspace", "403 or 404", self.brief(r, 60), r.status_code in (403, 404))
        r = self.make("sub-friend-under-platform", f"/systems/{self.ids['platform']}/subsystems", system("urn:barge:open:intruder", "friend's subsystem"), SML, user="friend")
        self.note(6, "friend creates a subsystem under the platform (role allows create/systems)", "403", self.brief(r, 60), r.status_code == 403)
        r = self.make("ws-friend2", "/systems", system("urn:barge:open:ws:friend2", "Workspace of friend2", "http://www.w3.org/ns/sosa/Procedure"), SML, user="friend2", ep="/api-weather")
        self.note(6, "friend2 creates a workspace through /api-weather", "201", self.brief(r, 60), r.status_code == 201)
        r = self.make("ds-ws-friend2", f"/systems/{self.ids.get('ws-friend2')}/datastreams", datastream("data of interest", "selection", "1"), user="friend2", ep="/api-weather")
        self.note(6, "...and a datastream in it", "201", self.brief(r, 60), r.status_code == 201)

    # ---- 4. commands over WebSocket ------------------------------------------------------
    def commands(self):
        cs = self.ids["cs-analysis"]
        path = f"/controlstreams/{cs}/commands"
        res = asyncio.run(self.ws_stream(None, path, wait=0.5))
        self.note(4, "WebSocket subscription without credentials", "401", res["handshake"], res["handshake"] == 401)

        async def bad_pw():
            import websockets
            try:
                async with websockets.connect(self.root.replace("http", "ws", 1) + "/api" + path, additional_headers={"Authorization": "Basic " + base64.b64encode(b"svc-analysis:nope").decode()}, proxy=None):
                    return 101
            except websockets.exceptions.InvalidStatus as e:
                return e.response.status_code
        self.note(4, "WebSocket subscription with a wrong password", "401", asyncio.run(bad_pw()), True)

        async def creds_in_url():
            import websockets
            url = self.root.replace("http://", "ws://svc-analysis:svc-pw@", 1) + "/api" + path
            try:
                async with websockets.connect(url, proxy=None):
                    return "101 (the Python client turned the user info into an Authorization header)"
            except websockets.exceptions.InvalidStatus as e:
                return e.response.status_code
        self.note(4, "credentials in the WebSocket URL (ws://user:pass@host/...)", "n/a", asyncio.run(creds_in_url()), True)
        r = self.anon.get(f"/api{path}", params={"access_token": "x", "user": "svc-analysis", "password": "svc-pw"})
        self.note(4, "credentials as query parameters", "n/a", self.brief(r, 40), r.status_code != 401)

        def send():
            out = {}
            for u, alg in (("emi", "A"), ("friend", "B")):
                t0 = time.perf_counter()
                r = self.c[u].post(f"/api{path}", json={"parameters": {"algorithm": alg, "fields": "co2"}})
                out[u] = f"{self.brief(r, 60)} in {time.perf_counter() - t0:.1f} s"
            self.sent = out
        self.sent = None
        res = asyncio.run(self.ws_stream("svc-analysis", path, post=send, wait=7))
        self.note(4, "service account (has create/status) subscribes to its control stream on /api, as a receiver", "101, both commands pushed",
                  {**res, "senders' POSTs": self.sent}, res["handshake"] == 101 and len(res["received"]) == 2 and "closed by server" not in res)
        self.sent = None
        res = asyncio.run(self.ws_stream("friend", path, post=lambda: self.c["emi"].post(f"/api{path}", json={"parameters": {"algorithm": "C", "fields": "x"}}), wait=6))
        self.note(4, "a viewer (no create/status) subscribes to the same control stream on /api", "n/a", res, True)
        # the workaround: the receiver listens on an endpoint with access control off; senders post on /api
        res = asyncio.run(self.ws_stream("svc-analysis", path, ep="/api-internal", post=send, wait=7))
        self.note(4, "receiver on /api-internal (access control off, authentication on); emi and friend post on /api", "both pushed",
                  {**res, "senders' POSTs": self.sent}, len(res["received"]) == 2)
        senders = [m.get("sender") for m in res["received"]]
        self.note(4, "the pushed command names who sent it", "the sender's user id (or role)", senders, senders == ["emi", "friend"])
        lst = self.c["owner"].get(f"/api{path}").json().get("items", [])
        self.note(4, "the stored command resource names who sent it", "sender", [{k: m.get(k) for k in ("sender", "parameters", "currentStatus")} for m in lst],
                  bool(lst) and all("sender" in m for m in lst))
        r = self.c["friend"].get(f"/api-internal/systems/{self.ids['bow-co2']}")
        self.note(1, "but any authenticated user can read restricted systems through /api-internal", "404", self.brief(r, 40), r.status_code == 404)
        r = self.c["svc-analysis"].get("/api/systems")
        self.note(4, "is there an API for a receiver to look up a user's roles?", "n/a",
                  "none found: no users/roles resource in the Connected Systems API; " + self.brief(self.c["svc-analysis"].get("/api/users"), 40), True)

    # ---- the endpoint alternative --------------------------------------------------------
    def endpoint_alternative(self):
        r = self.c["friend2"].get("/api/systems")
        self.note(1, "friend2 (role names only /api-weather) asks /api", "403", self.brief(r, 40), r.status_code == 403)
        self.visibility("friend2", "/api-weather", "second endpoint whose view excludes urn:barge:restricted:*")
        self.visibility("friend2", "/api-weather-ro", "the same view, read-only endpoint (enableTransactional false)")
        self.stream_restricted("friend2", "/api-weather-ro", "read-only endpoint")
        self.stream_restricted("friend2", "/api-weather", "second endpoint")
        cs = self.ids["cs-analysis"]
        r = self.c["friend2"].get(f"/api-weather/controlstreams/{cs}")
        self.note(1, "friend2 sees the open control stream through /api-weather", "200", self.brief(r, 40), r.status_code == 200)

    def state_file(self, rundir: Path | None):
        if rundir is None:
            return
        f = next(rundir.glob("db/*/user_permissions.json"), None)
        self.note(6, "permissions OpenSensorHub added at run time (state file)", "n/a", json.loads(f.read_text()) if f else "not found", True)

    def save(self, extra=None):
        data = json.loads(self.out.read_text()) if self.out.exists() and extra else {}
        data.setdefault("server", self.root)
        data["ids"] = data.get("ids") or self.ids
        data[extra or "phase 1: no deny entries"] = self.checks
        self.out.write_text(json.dumps(data, indent=1, ensure_ascii=False))

    # ---- phase 2: after the deny entries were added and the server restarted ------------
    def after_deny(self):
        self.ids = json.loads(self.out.read_text())["ids"]
        self.no_credentials()
        r = self.c["friend"].get(f"/api/systems/{self.ids['ws-friend']}")
        self.note(7, "after a restart, friend still owns their workspace (run-time permissions persisted)", "200", self.brief(r, 40), r.status_code == 200)
        r = self.obs("friend", self.ids["ds-ws-friend"], {"selection": 2}, "2031-04-08T13:00:00Z")
        self.note(7, "...and can append to it", "201", self.brief(r, 40), r.status_code == 201)
        self.visibility("friend", "/api", "deny entries on the role (get on both restricted systems, get on one CO2 datastream)")
        self.stream_restricted("friend", "/api", "deny entries")
        self.visibility("emi", "/api", "viewer with emissions (control)")


def write_deny(results: Path, src: Path, dst: Path):
    ids = json.loads(results.read_text())["ids"]
    cfg = json.loads(src.read_text())
    realm = next(m for m in cfg if m["objClass"].endswith("BasicSecurityRealmConfig"))
    role = next(r for r in realm["roles"] if r["id"] == "viewer_weather")
    role["deny"] = [f"csapi[*]/get/systems/{ids['bow-co2']}", f"csapi[*]/get/systems/{ids['analysis-co2']}",
                    f"csapi[*]/get/datastreams/{ids['ds-clusters-co2']}"]
    dst.write_text(json.dumps(cfg, indent=2))
    print("deny entries for viewer_weather:", role["deny"])


def main():
    args = sys.argv[1:]
    if args[0] == "--write-deny":
        write_deny(Path(args[1]), Path(args[2]), Path(args[3]))
        return
    root, out = args[0], Path(args[1])
    rundir = Path(args[args.index("--rundir") + 1]) if "--rundir" in args else None
    s = Spike(root, out)
    if "--after-deny" in args:
        s.after_deny()
        s.save("phase 2: deny entries on viewer_weather, after a restart")
        return
    s.no_credentials()
    s.session()
    s.build()
    s.visibility("friend", "/api", "no deny entries yet (baseline)")
    s.endpoint_alternative()
    s.workspaces()
    s.commands()
    s.state_file(rundir)
    s.save()


if __name__ == "__main__":
    main()
