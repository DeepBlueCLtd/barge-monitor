#!/usr/bin/env python3
"""D-200: what a stock OpenSensorHub does with ``DELETE`` (and ``PUT``) on a system and a datastream that exist.

The AT-32 set-up (``osh_server.py``, the installation of ``at32_osh.py``), then one fresh system with one
datastream per attempt, created by the owner, so that no attempt depends on another. Each is tried through the
access gateway (``osh_gateway.py``) and directly, on ``/api`` (access control on) and ``/api-internal`` (off);
after each, the owner asks for the resource directly on ``/api``. A further run with ``--gateway-allows`` puts back
the gateway's old behaviour (forwarding ``PUT`` and ``DELETE``) to show what got through before D-200.

Usage::

    python backend/independent/at32_delete_probe.py --osh <osh-core>/build/install/osh-core [--json out.json]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent / "models"))
sys.path.insert(0, str(HERE))

import httpx  # noqa: E402
import uvicorn  # noqa: E402

import at32_osh as T  # noqa: E402
from barge import gateway as G  # noqa: E402
from osh_gateway import OshGateway, OshUpstream  # noqa: E402
from osh_server import Osh, find_home, free_port  # noqa: E402


async def probe(home: Path, gateway_allows: bool) -> list[dict]:
    osh = Osh(home, Path(tempfile.mkdtemp()) / "run")
    await asyncio.to_thread(osh.start)
    out: list[dict] = []
    saved = G.NO_REPLACE_OR_DELETE
    if gateway_allows:
        G.NO_REPLACE_OR_DELETE = ()
    try:
        gport = free_port()
        srv = uvicorn.Server(uvicorn.Config(OshGateway(OshUpstream(osh.root)), host="127.0.0.1", port=gport,
                                            log_level="warning", lifespan="off"))
        task = asyncio.ensure_future(srv.serve())
        while not srv.started:
            await asyncio.sleep(0.05)
        await T.install(osh)
        own = T.Direct(osh, "owner")
        await own.find_systems()

        async def fresh(n: int, user: str = "owner") -> tuple[str, str]:
            d = T.Direct(osh, user)
            parent = f"urn:x-barge:workspace:{user}" if user != "owner" else None
            if parent:
                await d.find_systems()
            sid = await d.system(f"urn:x-barge:test:delete-{n}", f"Delete {n}", "D-200 probe", T.SOSA + "System",
                                 "Other", parent)
            ds = await d.datastream(sid, f"probe-{n}", f"Probe {n}",
                                    T.swe.record([T.swe.time_field("time", "Time")], "Probe"))
            return sid, ds

        tries = [("gateway", "owner", "owner"), ("gateway", "analyst", "analyst"), ("gateway", "friend", "owner"),
                 ("direct", "owner", "owner"), ("direct", "analyst", "analyst"), ("direct", "svc-importer", "owner"),
                 ("internal", "friend", "owner")]
        made = [await fresh(i, creator) for i, (_, _, creator) in enumerate(tries)]
        bow = own.systems["urn:x-barge:sensor:bow"]

        def client(via: str, user: str) -> httpx.AsyncClient:
            base = f"http://127.0.0.1:{gport}" if via == "gateway" else osh.root + (
                "/api-internal" if via == "internal" else "/api")
            return httpx.AsyncClient(base_url=base, headers={"Authorization": T.basic(user)}, timeout=60,
                                     trust_env=False)

        async def attempt(via: str, user: str, method: str, path: str, what: str) -> None:
            async with client(via, user) as c:
                r = await c.request(method, path, content=b"{}" if method == "PUT" else None,
                                    headers={"content-type": T.SML} if method == "PUT" else {})
            after = (await own.c.get(path)).status_code
            row = {"via": via, "user": user, "request": f"{method} {what}", "status": r.status_code, "after_get": after,
                   "removed": after == 404}
            out.append(row)
            print(json.dumps(row), flush=True)

        for (via, user, creator), (sid, ds) in zip(tries, made):
            what = "its own workspace's" if creator == user and user != "owner" else "the owner's"
            await attempt(via, user, "DELETE", f"/datastreams/{ds}", f"datastream ({what})")
            await attempt(via, user, "DELETE", f"/systems/{sid}", f"system ({what}, no children left)")
        await attempt("direct", "owner", "DELETE", f"/systems/{bow}", "system with children (bow sensor)")
        await attempt("gateway", "owner", "PUT", f"/systems/{bow}", "system, empty SensorML body")
        task.cancel()
    finally:
        G.NO_REPLACE_OR_DELETE = saved
        await asyncio.to_thread(osh.stop)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--osh", help="osh-core's installed distribution (or the checkout); else $OSH_HOME")
    ap.add_argument("--json", help="write the results to this file")
    args = ap.parse_args()
    home = find_home(args.osh)
    res = {"server": "OpenSensorHub osh-core 2.0.4 (75bb094), unmodified, AT-32 configuration",
           "gateway_refuses": asyncio.run(probe(home, False)),
           "gateway_forwards_as_before_d200": asyncio.run(probe(home, True))}
    if args.json:
        Path(args.json).write_text(json.dumps(res, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
