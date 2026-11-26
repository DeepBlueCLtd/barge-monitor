"""The back-end worker's entry points (barge/bridge.py), exercised in CPython as the worker calls them:
the folder fetched through callbacks, ticks, controls, an ordinary answer, no answer, and a streamed
push subscription delivered as start, chunk and end (§9.2)."""
import asyncio
import gzip
import json

from barge import accounts as A
from barge.bridge import Bridge
from barge.clock import ManualClock
from tests.helpers import folder_path


def test_bridge_answers_streams_and_controls():
    loop = asyncio.new_event_loop()
    f = folder_path()

    async def index():
        return (f / "index.json").read_text()

    async def file(name):
        return gzip.decompress((f / (name + ".gz")).read_bytes())

    async def manifest():
        return gzip.decompress((f / "manifest.json.gz").read_bytes()).decode()

    clock = ManualClock()
    b = Bridge(index, file, manifest, real=clock)
    b.rt.hold_s = 0.0
    loop.run_until_complete(b.start())
    owner = [["authorization", A.basic("owner", "demo-owner")]]
    svc = [["authorization", A.basic("svc-replay", A.SERVICE_PASSWORD)]]

    async def go():
        assert b.rt.status == "starting"  # a start takes about a second, answering nothing
        assert await b.handle("GET", "/", "", None, "/api", owner) is None
        clock.advance(1.5)
        tick = json.loads(b.tick())
        assert tick["server"] == "running" and tick["replay"]["dataset"].startswith("mission-a-")
        status, headers, body = await b.handle("GET", "/systems", "", None, "/api", owner)
        assert status == 200 and json.loads(bytes(body))["items"]
        cs = next(c for c in json.loads(bytes((await b.handle("GET", "/controlstreams", "", None, "/api", owner))[2]))["items"]
                  if c["inputName"] == "replay")
        got = []
        sub = asyncio.ensure_future(b.handle("GET", f"/controlstreams/{cs['id']}/commands", "subscribe=1", None, "/api",
                                             svc, on_stream=lambda kind, *a: got.append((kind, a))))
        await asyncio.sleep(0.01)
        assert got and got[0][0] == "start" and got[0][1][0] == 200
        assert isinstance(json.loads(b.tick())["replay"]["time"], (int, float))  # Unix seconds for the shell (§13.2)
        st = b.rt.replay.state()
        params = {"action": "play", "dataset": st["dataset"], "rate": 1, "position": st["position"]}
        r = await b.handle("POST", f"/controlstreams/{cs['id']}/commands", "", json.dumps({"parameters": params}).encode(),
                           "/api", owner + [["content-type", "application/json"]])
        assert r[0] == 200
        await asyncio.sleep(0.01)
        chunk = next(a[0] for k, a in got if k == "chunk")
        assert json.loads(bytes(chunk))["parameters"] == params and json.loads(bytes(chunk))["sender"] == "owner"
        state = json.loads(b.control("down"))
        assert state["server"] == "down"
        await asyncio.sleep(0.01)
        assert got[-1][0] == "end" and await sub == "stream"  # the subscription ends with the server
        assert json.loads(b.control("state"))["backend"] == "python"
        msgs = json.loads(b.tick())["messages"]
        assert not [m for m in msgs if "demo-owner" in json.dumps(m) or "svc-demo" in json.dumps(m)]

    loop.run_until_complete(go())
    b.rt.stop()
    loop.close()
