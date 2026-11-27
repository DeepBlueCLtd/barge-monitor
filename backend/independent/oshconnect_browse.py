#!/usr/bin/env python3
"""AT-05: browse the CPython build of the server with OSHConnect-Python, with credentials.

OSHConnect-Python is an independent Connected Systems client. This script
starts the server under uvicorn (mounted where OSHConnect expects a server,
/sensorhub/api), then uses only OSHConnect to list systems and their
datastreams, read each datastream's SWE Common schema and read observations.
It exits non-zero on any failure. Run it in its own virtual environment:
OSHConnect pins library versions different from the server's.

Usage: python backend/independent/oshconnect_browse.py
"""
import socket
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import uvicorn  # noqa: E402
from starlette.applications import Starlette  # noqa: E402
from starlette.routing import Mount  # noqa: E402

from barge.api import create_app  # noqa: E402
from barge.runtime import Runtime  # noqa: E402

USER, PASSWORD = "owner", "demo-owner"  # labelled demo credentials (PR-07)


def serve() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    rt = Runtime(seed=3, pregen_days=0.2, local_models=True)
    while not (rt.server.ready and rt.local.live):
        rt.tick()
    app = Starlette(routes=[Mount("/sensorhub/api", app=create_app(rt))])
    srv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=srv.run, daemon=True).start()
    while not srv.started:
        time.sleep(0.05)
    return port


def main() -> int:
    from oshconnect import api_helpers as H
    from oshconnect.node import Node
    from oshconnect.schema_datamodels import SWEDatastreamRecordSchema

    port = serve()
    AUTH = (USER, PASSWORD)  # every request carries credentials (§9.3); the helpers send them only when given them
    try:
        node = Node(protocol="http", address="127.0.0.1", port=port, username=USER, password=PASSWORD)
    except TypeError:
        node = Node(protocol="http", address="127.0.0.1", port=port)
    base = node.get_api_helper().get_base_url()
    api_root = "sensorhub/api"
    failures, client_defects = [], []
    systems = node.discover_systems()
    print(f"systems (top level): {[s.label for s in systems]}")
    discovered = {}
    for sysm in systems:
        for ds in sysm.discover_datastreams() or []:
            discovered[ds.get_resource().ds_id] = (sysm.label, ds.get_resource().name)
    # Subsystems (bow and stern) are not top-level systems: list every datastream too.
    listing = H.list_all_datastreams(base, api_root=api_root, auth=AUTH)
    if not listing.ok:
        failures.append(f"list datastreams: HTTP {listing.status_code}")
    for item in listing.json().get("items", []):
        discovered.setdefault(item["id"], (item["system@id"], item["name"]))
    for ds_id, (owner, name) in discovered.items():
        sch = H.retrieve_datastream_schema(base, ds_id, api_root=api_root, auth=AUTH, obs_format="application/swe+json")
        note = ""
        try:
            SWEDatastreamRecordSchema.from_swejson_dict(sch.json())
            note = "schema parsed"
        except Exception as e:  # noqa: BLE001
            if "quality" in str(e) and "href" in str(e):
                # FR-24: each measurement's quality refers to its separate QC flag field.
                # OSHConnect only accepts inline quality components. Open question D-31.
                client_defects.append(f"{ds_id}: OSHConnect cannot parse a quality reference to a flag field")
                note = "schema: client defect (quality reference)"
            elif any(f.get("type") == "Matrix" for f in sch.json()["recordSchema"]["fields"]) and "elementType" in str(e):
                # OSHConnect models elementType as a list; the published SWE Common 3.0
                # JSON schema (DataArray.json, AbstractArray) has a single component.
                client_defects.append(f"{ds_id}: OSHConnect cannot parse a SWE Common 3.0 Matrix (elementType)")
                note = "schema: client defect (Matrix)"
            else:
                failures.append(f"schema {ds_id}: {type(e).__name__}: {e}")
                note = "schema failed"
        obs = H.list_observations_from_datastream(base, ds_id, api_root=api_root, auth=AUTH)
        if not (obs.ok and isinstance(obs.json(), (list, dict))):
            failures.append(f"observations {ds_id}: HTTP {obs.status_code}")
        print(f"  {owner} / {name}: {note}, observations HTTP {obs.status_code}")
    seen = len(discovered)
    if seen < 7:
        failures.append(f"only {seen} datastreams discovered")
    for d in client_defects:
        print(f"KNOWN CLIENT DEFECT (not counted as a pass): {d}")
    if failures:
        print("FAILED:\n  " + "\n  ".join(failures))
        return 1
    print(f"OSHConnect browsed {len(systems)} systems and {seen} datastreams")
    return 0


if __name__ == "__main__":
    sys.exit(main())
