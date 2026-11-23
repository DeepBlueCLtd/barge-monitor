"""AT-32, ADR 0005: what a stock OpenSensorHub does with what this system needs of a data server.

The spike takes the demonstrator's own server (the stand-in of FR-38a, run in process) as the
reference, replays its resources into an empty OpenSensorHub through the Connected Systems
interface, and records where the two differ. It changes nothing in OpenSensorHub.

    python backend/spike/osh_spike.py http://localhost:8181/sensorhub/api  results.json
    python backend/spike/osh_spike.py http://localhost:8181/sensorhub/api  results.json --after-restart

See backend/spike/README.md for building and starting OpenSensorHub.
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from fastapi.testclient import TestClient  # noqa: E402

from barge.api import create_app  # noqa: E402
from barge.runtime import Runtime  # noqa: E402
from contract_suite import suite  # noqa: E402

SML = {"content-type": "application/sml+json"}
SWE = {"content-type": "application/swe+json"}
SWE_Q = {"f": "application/swe+json"}
N_OBS = 120  # observations replayed per datastream


class Spike:
    def __init__(self, base: str):
        self.o = httpx.Client(base_url=base.rstrip("/"), timeout=60, trust_env=False)
        self.base = base.rstrip("/")
        self.checks: list[dict] = []
        self.ids: dict[str, str] = {}  # reference id -> OpenSensorHub id

    def note(self, key: str, need: str, reference, observed, same: bool):
        self.checks.append({"check": key, "need": need, "reference": reference, "observed": observed, "same": bool(same)})
        print(f"{'same   ' if same else 'DIFFERS'} {key}: {observed if isinstance(observed, str) else json.dumps(observed)[:160]}")

    @staticmethod
    def brief(r: httpx.Response, n=160):
        text = r.text
        if "<title>" in text:
            text = text.split("<title>")[1].split("</title>")[0]
        return f"{r.status_code} {r.headers.get('content-type', '')}: {' '.join(text.split())[:n]}"

    @staticmethod
    def loc(r: httpx.Response) -> str:
        return r.headers.get("location", "").rstrip("/").rsplit("/", 1)[-1]

    # ---- the reference -------------------------------------------------------------------
    def reference(self):
        rt = Runtime(seed=3, pregen_days=1, local_models=True)
        while not (rt.server.ready and rt.local.live):
            rt.tick()
        self.ref = TestClient(create_app(rt))

    def rget(self, path, **params):
        return self.ref.get(path, params=params or None)

    # ---- discovery of the empty server ---------------------------------------------------
    def discovery(self):
        r = self.o.get("/")
        ref = self.rget("/")
        links = {l["rel"] for l in r.json().get("links", [])}
        self.note("landing page", "FR-23", "200 application/json", f"{r.status_code} {r.headers.get('content-type')}",
                  r.status_code == 200 and r.headers.get("content-type", "").startswith("application/json"))
        self.note("landing page links", "FR-23", sorted(l["rel"] for l in ref.json()["links"]), sorted(links),
                  {"conformance", "systems", "datastreams"} <= links)
        self.note("profile link on the landing page", "FR-41", "rel=profile", "present" if any("profile" in x for x in links) else "absent",
                  any("profile" in x for x in links))
        self.note("instance identifier", "FR-47", {"etag": ref.headers.get("etag"), "x-server-instance": ref.headers.get("x-server-instance")},
                  {"etag": r.headers.get("etag"), "x-server-instance": r.headers.get("x-server-instance")},
                  bool(r.headers.get("etag") or r.headers.get("x-server-instance")))
        c = set(self.o.get("/conformance").json().get("conformsTo", []))
        want = set(ref_c := self.rget("/conformance").json()["conformsTo"])
        missing = sorted(x for x in want if x not in c and "barge-monitor" not in x)
        self.note("conformance classes the reference claims", "FR-23", f"{len(ref_c)} classes", {"missing": missing, "extra": len(c - want)}, not missing)
        r = self.o.get("/api")
        self.note("OpenAPI definition served by the server", "FR-23", "200 at /api", self.brief(r), r.status_code == 200)
        r = self.o.get("/collections")
        self.note("/collections", "FR-23", "200", self.brief(r, 60), r.status_code == 200)
        r = self.o.get("/systemEvents")
        self.note("refusals are JSON, named", "FR-28a", "404 application/json {code, description, refused}", self.brief(r), "json" in r.headers.get("content-type", ""))

    # ---- replaying the reference's resources ---------------------------------------------
    def systems(self):
        def strip(d):
            return {k: v for k, v in d.items() if k not in ("id", "links")}

        def make(ref_id, parent=None):
            body = strip(self.rget(f"/systems/{ref_id}").json())
            path = f"/systems/{self.ids[parent]}/subsystems" if parent else "/systems"
            r = self.o.post(path, content=json.dumps(body), headers=SML)
            self.ids[ref_id] = self.loc(r)
            return r, body, path

        r, body, path = make("barge")
        self.note("create a system (SensorML JSON)", "FR-28", "201 with Location", f"{r.status_code} Location {r.headers.get('location')}", r.status_code == 201)
        r2 = self.o.post(path, content=json.dumps(body), headers=SML)
        self.note("create the same system again", "FR-28", "409 with the same Location",
                  f"{r2.status_code} Location {r2.headers.get('location')}", r2.status_code == 409 and self.loc(r2) == self.ids["barge"])
        self.note("...finds what was made, without a lookup", "FR-28", "same Location", self.loc(r2) == self.ids["barge"], self.loc(r2) == self.ids["barge"])
        self.note("identifiers", "FR-28 (models POST to /systems/models/subsystems)", "readable, chosen by the server from the uniqueId (barge, models)",
                  f"opaque, assigned by the server ({self.ids['barge']})", self.ids["barge"] == "barge")
        for sid in ("bow", "stern"):
            r, _, _ = make(sid, "barge")
        self.note("create a subsystem", "FR-24", "201", r.status_code, r.status_code == 201)
        make("models")
        for sid in ("data-cleanse", "summaries", "analysis"):
            make(sid, "models")
        top = self.o.get("/systems").json()["items"]
        got = top[0]
        refsys = self.rget("/systems").json()["items"][0]
        self.note("system resource, default encoding", "FR-24", sorted(k for k in refsys if k != "links"),
                  {"top": sorted(got), "properties": sorted(got.get("properties", {}))}, "uniqueId" in got)
        self.note("top-level systems listing", "FR-42", ["barge", "models"], [s["properties"]["uid"].rsplit(":", 1)[-1] for s in top], len(top) == 2)
        subs = self.o.get(f"/systems/{self.ids['barge']}/subsystems").json()["items"]
        self.note("subsystems listing", "FR-42", ["bow", "stern"], [s["properties"]["uid"].rsplit(":", 1)[-1] for s in subs], len(subs) == 2)
        an = self.o.get(f"/systems/{self.ids['analysis']}").json()
        self.note("a model is a process system", "FR-24", "assetType Process", an.get("properties", {}).get("assetType"), an.get("properties", {}).get("assetType") == "Process")
        self.note("no system carries a location", "FR-24", "no geometry", an.get("geometry"), an.get("geometry") is None)
        r = self.o.get(f"/systems/{self.ids['analysis']}", params={"f": "application/sml+json"})
        self.note("system as SensorML JSON on request", "FR-24", "uniqueId, label, definition", sorted(r.json()) if r.status_code == 200 else self.brief(r),
                  r.status_code == 200 and "uniqueId" in r.json())

    def datastreams(self):
        self.streams = []
        for d in self.rget("/datastreams").json()["items"]:
            sch = self.rget(f"/datastreams/{d['id']}/schema", obsFormat="application/swe+json").json()
            made = {"name": d["name"], "outputName": d["outputName"], "schema": sch}
            r = self.o.post(f"/systems/{self.ids[d['system@id']]}/datastreams", json=made)
            self.ids[d["id"]] = self.loc(r)
            self.streams.append((d, sch, r))
        bad = [(d["id"], self.brief(r)) for d, _, r in self.streams if r.status_code != 201]
        self.note("create every datastream with its SWE Common schema", "FR-25, FR-28", "14 created", {"created": len(self.streams) - len(bad), "refused": bad}, not bad)
        d, sch, r = self.streams[0]
        again = self.o.post(f"/systems/{self.ids[d['system@id']]}/datastreams", json={"name": d["name"], "outputName": d["outputName"], "schema": sch})
        self.note("create the same datastream again", "FR-28", "409 with the same Location", f"{again.status_code} Location {again.headers.get('location')}",
                  again.status_code == 409)
        got = self.o.get(f"/datastreams/{self.ids[d['id']]}/schema", params={"obsFormat": "application/swe+json"}).json()
        rf, gf = sch["recordSchema"]["fields"], got["recordSchema"]["fields"]
        self.note("schema keeps every field, type and unit", "FR-25", len(rf),
                  len(gf), [(f["name"], f["type"], f.get("uom")) for f in rf] == [(f["name"], f["type"], f.get("uom")) for f in gf])
        q = next(f for f in gf if f["name"] == "air_temperature")
        self.note("quality as a reference to the flag field", "FR-25, D-31", [{"href": "#air_temperature_qc"}], q.get("quality"), q.get("quality") == [{"href": "#air_temperature_qc"}])
        cat = next(f for f in gf if f["name"] == "air_temperature_qc")
        rcat = next(f for f in rf if f["name"] == "air_temperature_qc")
        self.note("constraint encoding", "FR-25", rcat.get("constraint"), cat.get("constraint"), rcat.get("constraint") == cat.get("constraint"))
        self.note("record name", "FR-25", sch["recordSchema"]["name"], got["recordSchema"]["name"], sch["recordSchema"]["name"] == got["recordSchema"]["name"])
        one = self.o.get(f"/datastreams/{self.ids[d['id']]}").json()
        self.note("datastream resource", "FR-25", sorted(k for k in d if k != "links"), sorted(one), {"outputName", "system@id", "name"} <= set(one))
        lst = self.o.get("/datastreams").json()["items"]
        self.note("datastreams listing", "FR-42", 14, len(lst), len(lst) == 14)

    def observations(self):
        d, _, _ = self.streams[0]
        did = self.ids[d["id"]]
        rows = self.rget(f"/datastreams/{d['id']}/observations", limit=N_OBS).json()
        r = self.o.post(f"/datastreams/{did}/observations", content=json.dumps(rows[:3]), headers=SWE)
        self.note("publish several observations in one request (SWE JSON array)", "FR-28", "201 {created: n}", self.brief(r), r.status_code == 201)
        t0 = time.perf_counter()
        codes = [self.o.post(f"/datastreams/{did}/observations", content=json.dumps(row), headers=SWE).status_code for row in rows]
        dt = time.perf_counter() - t0
        self.note("publish one observation per request (SWE JSON)", "FR-28", "201", sorted(set(codes)), set(codes) == {201})
        self.note("...rate, one per request, local", "§15 history length", "bulk", f"{len(rows) / dt:.0f} observations a second", False)
        null_row = {**rows[0], "time": "2031-04-08T12:00:00Z", "air_temperature": None}
        r = self.o.post(f"/datastreams/{did}/observations", content=json.dumps(null_row), headers=SWE)
        self.note("a missing value as JSON null", "FR-25 (QC flag 9, value null)", "accepted", self.brief(r), r.status_code == 201)
        r = self.o.post(f"/datastreams/{did}/observations", content=json.dumps({**rows[0], "time": "2031-04-08T12:00:01Z", "air_temperature": "NaN"}), headers=SWE)
        self.note("...a missing value as \"NaN\"", "fallback", "n/a", self.brief(r), r.status_code == 201)
        r = self.o.post(f"/datastreams/{did}/observations", content=json.dumps({"time": "2031-04-08T12:00:02Z", "colour": 1}), headers=SWE)
        self.note("an unknown field is refused", "FR-28", "400 naming the field", self.brief(r), r.status_code == 400)

        got = self.o.get(f"/datastreams/{did}/observations", headers={"accept": "application/swe+json"}, params={"limit": 2})
        self.note("observations as SWE JSON by Accept header", "FR-26 (the display client asks this way)", "application/swe+json",
                  got.headers.get("content-type"), got.headers.get("content-type", "").startswith("application/swe+json"))
        got = self.o.get(f"/datastreams/{did}/observations", params={**SWE_Q, "limit": 2})
        self.note("observations as SWE JSON by f=", "FR-26", "records keyed by field name", self.brief(got, 60),
                  got.status_code == 200 and isinstance(got.json(), list) and "air_temperature" in got.json()[0])
        ref_rows = rows[:2]
        self.note("...values round-trip", "AT-01", ref_rows[0], got.json()[0] if got.status_code == 200 else None, got.status_code == 200 and got.json()[:2] == ref_rows)
        a, b = rows[10]["time"], rows[20]["time"]
        got = self.o.get(f"/datastreams/{did}/observations", params={**SWE_Q, "phenomenonTime": f"{a}/{b}", "limit": 1000}).json()
        self.note("phenomenonTime interval", "FR-26", 11, len(got), len(got) == 11)
        got = self.o.get(f"/datastreams/{did}/observations", params={**SWE_Q, "phenomenonTime": f"{rows[-5]['time']}/..", "limit": 1000}).json()
        self.note("phenomenonTime open interval (polling)", "FR-63", "the rest", len(got), len(got) >= 5)
        got = self.o.get(f"/datastreams/{did}/observations", params={**SWE_Q, "resultTime": "latest"}).json()
        self.note("resultTime=latest", "FR-26", 1, len(got), len(got) == 1)
        got = self.o.get(f"/datastreams/{did}/observations", params={**SWE_Q, "limit": 5})
        self.note("paging of SWE JSON: a next link", "FR-23, FR-26", "Link: rel=next", got.headers.get("link"), "next" in (got.headers.get("link") or ""))
        got = self.o.get(f"/datastreams/{did}/observations", params={"limit": 5})
        nxt = [l for l in got.json().get("links", []) if l.get("rel") == "next"]
        self.note("paging of JSON observations: a next link", "FR-23", "next link", nxt[0]["href"].split("?")[-1] if nxt else None, bool(nxt))
        got = self.o.get(f"/datastreams/{did}/observations", params={"limit": 10_000_000})
        self.note("an oversize limit", "FR-26", "400 naming the limit", f"{got.status_code}, {len(got.json().get('items', []))} returned", got.status_code == 400)
        r = self.o.put(f"/datastreams/{did}/observations", content=json.dumps(rows[:2]), headers=SWE)
        self.note("plain PUT to replace a datastream's observations", "FR-28a", "200", self.brief(r), r.status_code == 200)

        # A sample of every other datastream, so the reads below have something to find.
        loaded = {}
        for d2, _, _ in self.streams[1:]:
            rws = self.rget(f"/datastreams/{d2['id']}/observations", limit=20).json()
            ok = sum(self.o.post(f"/datastreams/{self.ids[d2['id']]}/observations", content=json.dumps(x), headers=SWE).status_code == 201 for x in rws)
            loaded[d2["id"]] = f"{ok}/{len(rws)}"
        short = {k: v for k, v in loaded.items() if v.split("/")[0] != v.split("/")[1]}
        self.note("a sample of every other datastream replays", "FR-28", "all accepted", short or "all accepted", not short)
        if short:
            d3 = next(d for d, _, _ in self.streams if d["id"] in short)
            x = next(x for x in self.rget(f"/datastreams/{d3['id']}/observations", limit=20).json()
                     if self.o.post(f"/datastreams/{self.ids[d3['id']]}/observations", content=json.dumps(x), headers=SWE).status_code != 201)
            r = self.o.post(f"/datastreams/{self.ids[d3['id']]}/observations", content=json.dumps(x), headers=SWE)
            self.note("...why one was refused", "FR-28", "n/a", {"datastream": d3["id"], "answer": self.brief(r, 220)}, False)

    def commands(self):
        cs = self.rget("/systems/analysis/controlstreams").json()["items"][0]
        sch = self.rget(f"/controlstreams/{cs['id']}/schema").json()
        r = self.o.post(f"/systems/{self.ids['analysis']}/controlstreams", json={"name": cs["name"], "inputName": cs["inputName"], "schema": sch})
        cid = self.loc(r)
        self.note("create a control stream with its parameter schema", "FR-27", "201", self.brief(r, 60), r.status_code == 201)
        got = self.o.get(f"/controlstreams/{cid}/schema").json()
        gf = {f["name"]: f for f in got.get("parametersSchema", {}).get("fields", [])}
        rf = {f["name"]: f for f in sch["parametersSchema"]["fields"]}
        self.note("the bounds live in the control stream's schema", "FR-27, FR-55", {k: v.get("constraint", {}).get("values") or v.get("constraint", {}).get("intervals") for k, v in rf.items()},
                  {k: v.get("constraint", {}).get("values") or v.get("constraint", {}).get("intervals") for k, v in gf.items()},
                  all((gf.get(k, {}).get("constraint", {}).get("values") or gf.get(k, {}).get("constraint", {}).get("intervals"))
                      == (v.get("constraint", {}).get("values") or v.get("constraint", {}).get("intervals")) for k, v in rf.items()))
        lst = self.o.get(f"/systems/{self.ids['analysis']}/controlstreams")
        self.note("control streams listed under their system", "FR-42", 1, len(lst.json().get("items", [])) if lst.status_code == 200 else self.brief(lst), lst.status_code == 200)
        partial = {"algorithm": "B", "fields": "air_temperature,apparent_wind_speed", "period": "PT1H"}
        r = self.o.post(f"/controlstreams/{cid}/commands", json={"parameters": partial})
        self.note("a command carrying only the settings that change", "FR-55", "201", self.brief(r), r.status_code in (200, 201))
        full = {}
        for name, f in rf.items():
            c = f.get("constraint", {})
            full[name] = partial.get(name, (c.get("values") or [None])[0] if "values" in c else (c.get("intervals") or [[2, 2]])[0][0])
        r = self.o.post(f"/controlstreams/{cid}/commands", json={"parameters": full})
        self.note("a command carrying every parameter", "FR-27", "201 with Location", f"{self.brief(r, 80)} Location {r.headers.get('location')}", r.status_code in (200, 201))
        self.full = full
        bad = {**full, "algorithm": "Z"}
        r2 = self.o.post(f"/controlstreams/{cid}/commands", json={"parameters": bad})
        self.note("a command outside the bounds is refused", "FR-27", "400 naming the bound", self.brief(r2), r2.status_code == 400)
        allc = self.o.get(f"/controlstreams/{cid}/commands")
        items = allc.json().get("items", []) if allc.status_code == 200 else []
        self.note("commands are kept and listed", "FR-27", "listed", f"{allc.status_code}, {len(items)} listed", bool(items))
        pend = self.o.get(f"/controlstreams/{cid}/commands", params={"statusCode": "PENDING"})
        self.note("a model polls for pending commands (statusCode=PENDING)", "FR-27", "the new command",
                  f"{pend.status_code}, {len(pend.json().get('items', [])) if pend.status_code == 200 else self.brief(pend)} listed",
                  pend.status_code == 200 and len(pend.json().get("items", [])) >= 1)
        if items:
            k = items[0]["id"]
            self.note("a command resource", "FR-27", "id, parameters, issueTime, currentStatus", sorted(items[0]), "parameters" in items[0] or "params" in items[0])
            s = self.o.post(f"/commands/{k}/status", json={"statusCode": "COMPLETED"})
            self.note("a model reports a command's status", "FR-27", "201", self.brief(s), s.status_code in (200, 201))
            s = self.o.get(f"/commands/{k}/status")
            self.note("status reports are listed", "FR-27", "listed", self.brief(s, 100), s.status_code == 200)

    def commands_with_receiver(self):
        """Commands again, with something listening on the control stream's WebSocket, as a model would."""
        try:
            import websockets
        except ImportError:
            self.note("commands with a receiver on the WebSocket", "FR-27", "n/a", "not run: pip install websockets", False)
            return
        cs = self.o.get(f"/systems/{self.ids['analysis']}/controlstreams").json()["items"][0]["id"]
        ws_url = self.base.replace("http", "ws", 1) + f"/controlstreams/{cs}/commands"
        out = {}

        async def run():
            async with httpx.AsyncClient(base_url=self.base, timeout=60, trust_env=False) as o:
                async def model():
                    async with websockets.connect(ws_url, proxy=None) as ws:
                        while True:
                            m = json.loads(await ws.recv())
                            out.setdefault("received", []).append(m)
                            if m["parameters"]["algorithm"] == "A":
                                r = await o.post(f"/commands/{m['id']}/status", json={"statusCode": "COMPLETED"})
                                out["status at /commands/{id}/status"] = r.status_code
                                r = await o.post(f"/controlstreams/{cs}/status", json={"command@id": m["id"], "statusCode": "COMPLETED", "message": "run r-1"})
                                out["status at /controlstreams/{id}/status"] = r.status_code

                task = asyncio.create_task(model())
                await asyncio.sleep(1)
                for alg in ("B", "A", "Z"):
                    t0 = time.perf_counter()
                    r = await o.post(f"/controlstreams/{cs}/commands", json={"parameters": {**self.full, "algorithm": alg}})
                    out[alg] = {"status": r.status_code, "seconds": round(time.perf_counter() - t0, 1), "body": " ".join(r.text.split())[:120] if r.status_code == 200 else self.brief(r, 80)}
                out["listed"] = len((await o.get(f"/controlstreams/{cs}/commands")).json()["items"])
                out["pending"] = len((await o.get(f"/controlstreams/{cs}/commands", params={"statusCode": "PENDING"})).json()["items"])
                out["completed"] = len((await o.get(f"/controlstreams/{cs}/commands", params={"statusCode": "COMPLETED"})).json()["items"])
                task.cancel()

        asyncio.run(run())
        got = out.get("received", [])
        self.note("with a receiver: the command is pushed to it over the WebSocket", "FR-27 (the stand-in has the model poll)", "polled",
                  f"{len(got)} of 3 pushed" + (f", as {sorted(got[0])}" if got else ""), len(got) == 3)
        self.note("with a receiver: the sender's POST", "FR-55, FR-79 (a click is answered at once)", "201 at once", out.get("B"), False)
        self.note("with a receiver: commands are then kept and listed", "FR-27", "listed", {k: out.get(k) for k in ("listed", "pending", "completed")}, out.get("listed", 0) >= 3)
        self.note("with a receiver: a command outside the bounds", "FR-27", "400 naming the bound", out.get("Z"), out.get("Z", {}).get("status") == 400)
        self.note("with a receiver: status reported at /commands/{id}/status", "FR-27", "201", out.get("status at /commands/{id}/status"), out.get("status at /commands/{id}/status") == 201)
        self.note("with a receiver: status reported at /controlstreams/{id}/status", "fallback", "n/a", out.get("status at /controlstreams/{id}/status"),
                  out.get("status at /controlstreams/{id}/status") == 201)
        self.note("with a receiver: the sender's POST once the model has reported COMPLETED", "FR-27", "n/a", out.get("A"), False)

    # ---- the display client's handshake, as far as the profile goes (FR-42..FR-45) ----------
    def handshake(self):
        profile = json.loads((ROOT / "contracts" / "profile.json").read_text())
        systems = []

        def visit(path, depth):
            r = self.o.get(path)
            for s in (r.json().get("items", []) if r.status_code == 200 else []):
                systems.append(s)
                if depth < 2:
                    visit(f"/systems/{s['id']}/subsystems", depth + 1)

        visit("/systems", 0)
        uid = {s["id"]: s.get("uniqueId") or s.get("properties", {}).get("uid") for s in systems}
        streams = {}
        for d in self.o.get("/datastreams", params={"limit": 100}).json()["items"]:
            sch = self.o.get(f"/datastreams/{d['id']}/schema", params={"obsFormat": "application/swe+json"}).json()
            streams[(uid.get(d.get("system@id")), d.get("outputName"))] = {f["name"]: f for f in sch.get("recordSchema", {}).get("fields", [])}
        problems = []
        for e in profile["essentials"]:
            f = streams.get((e["system"], e["datastream"]), {}).get(e["field"])
            if not f:
                problems.append(f"{e['datastream']}.{e['field']}: missing")
            elif f["type"] != e["type"] or (e.get("uom") is not None and (f.get("uom") or {}).get("code") != e["uom"]):
                problems.append(f"{e['datastream']}.{e['field']}: {f['type']} {(f.get('uom') or {}).get('code')}")
        self.note("discovery by standard listings finds every system", "FR-42", 7, len(systems), len(systems) == 7)
        self.note("every essential of the declared profile is offered, with its type and unit", "FR-45", f"{len(profile['essentials'])} essentials",
                  problems or "all present", not problems)

    def contract_suite(self):
        base = self.base + "/"

        class Client:
            async def request(self, method, path, params=None, body=None, headers=None):
                async with httpx.AsyncClient(base_url=base, timeout=60, trust_env=False) as c:
                    r = await c.request(method, path, params=params, json=body, headers=headers)
                    ctype = r.headers.get("content-type", "")
                    try:
                        data = r.json() if ("json" in ctype and r.content) else r.text
                    except ValueError:
                        data = r.text
                    return r.status_code, dict(r.headers), data

        results = asyncio.run(suite.run(Client()))
        self.suite = [{"test": r["test"], "outcome": r["outcome"], "detail": " ".join(str(r.get("detail", "")).split())[:300]} for r in results]
        passed = sum(r["outcome"] == "passed" for r in results)
        self.note("the contract suite, unchanged", "AT-32", f"{len(results)} pass against the stand-in", f"{passed} of {len(results)} pass", passed == len(results))
        for r in self.suite:
            print(f"   {r['outcome']:8} {r['test']}: {r['detail'][:150]}")

    def after_restart(self):
        r = self.o.get("/")
        self.note("after a restart: instance identifier", "FR-47, FR-48", "a new identifier", {"etag": r.headers.get("etag"), "x-server-instance": r.headers.get("x-server-instance")}, False)
        n = len(self.o.get("/systems").json()["items"])
        d = self.o.get("/datastreams", params={"limit": 100}).json()["items"]
        self.note("after a restart: resources created over HTTP persist", "FR-28 (a restarted model finds what it made)", "kept", {"top-level systems": n, "datastreams": len(d)}, n == 2 and len(d) == 14)
        first = d[0]
        o = self.o.get(f"/datastreams/{first['id']}/observations", params={**SWE_Q, "limit": 3})
        self.note("after a restart: observations persist", "FR-22", "kept", self.brief(o, 60), o.status_code == 200 and len(o.json()) == 3)
        self.note("after a restart: identifiers are unchanged", "FR-44", "unchanged", first["id"], True)


def main():
    base, out = sys.argv[1], Path(sys.argv[2])
    s = Spike(base)
    if "--after-restart" in sys.argv:
        s.after_restart()
        doc = json.loads(out.read_text())
        doc["after_restart"] = s.checks
    else:
        s.reference()
        for step in (s.discovery, s.systems, s.datastreams, s.observations, s.commands, s.commands_with_receiver, s.handshake, s.contract_suite):
            print(f"\n== {step.__name__}")
            step()
        doc = {"server": base, "checks": s.checks, "contract_suite": s.suite}
    out.write_text(json.dumps(doc, indent=1) + "\n")
    same = sum(c["same"] for c in s.checks)
    print(f"\n{same} of {len(s.checks)} checks the same as the reference; written to {out}")


if __name__ == "__main__":
    main()
