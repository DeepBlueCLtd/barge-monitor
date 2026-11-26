"""A stock OpenSensorHub for AT-32: its configuration, written from the delivered accounts, and its process.

OpenSensorHub ``osh-core`` 2.0.4 (commit ``75bb094``), built from source as ``backend/spike/README.md``
says, unmodified. The configuration is the distribution's own modules with:

* a ``BasicSecurityRealm`` holding the delivered accounts (``barge/accounts.py``; demo credentials,
  PR-07), one OpenSensorHub role per role there. Every role may read, list, stream and create:
  permissions per system are the access gateway's (§9.5, D-150), so OpenSensorHub is used for
  authentication and for ``sender`` on commands only;
* HTTP Basic authentication on the HTTP server;
* two Connected Systems endpoints on one database: ``/api`` (access control on: what the gateway
  forwards to) and ``/api-internal`` (access control off, authentication on: where command
  receivers subscribe, since OpenSensorHub closes their WebSocket on ``/api``; S-AUTH finding).

Nothing here is a change to OpenSensorHub: only its JSON configuration.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from barge import accounts as A  # noqa: E402

DB_ID = "0309491d-d5cb-4f2f-9b95-166179c66746"
API_ID = "9d23a6a7-7455-41d1-9f1d-494be4e2463c"
INTERNAL_ID = "c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f"
EVERY_ROLE = ["csapi[*]/get", "csapi[*]/list", "csapi[*]/stream", "csapi[*]/create"]


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def config(port: int) -> list:
    accts = A.Accounts().by_user.values()
    users = [{"objClass": "org.sensorhub.impl.security.BasicSecurityRealmConfig$UserConfig", "id": a.user,
              "name": a.user, "password": a.password, "roles": [a.role], "allow": [], "deny": []} for a in accts]
    roles = [{"objClass": "org.sensorhub.impl.security.BasicSecurityRealmConfig$RoleConfig", "id": r, "name": label,
              "allow": ["*"] if r == A.OWNER else EVERY_ROLE + (["csapi[*]/update"] if r.startswith("service") else []),
              "deny": []} for r, label in A.ROLES.items()]

    def consys(mid, name, endpoint, access_control):
        return {"objClass": "org.sensorhub.impl.service.consys.ConSysApiServiceConfig", "databaseID": DB_ID,
                "exposedResources": {"objClass": "org.sensorhub.impl.datastore.view.ObsSystemDatabaseViewConfig",
                                     "includeFilter": {"objClass": "org.sensorhub.api.datastore.system.SystemFilter",
                                                       "uniqueIDs": ["*"]}},
                "security": {"objClass": "org.sensorhub.api.security.SecurityConfig",
                             "enableAccessControl": access_control, "requireAuth": True},
                "enableTransactional": True, "endPoint": endpoint, "id": mid,
                "moduleClass": "org.sensorhub.impl.service.consys.ConSysApiService", "name": name, "autoStart": True}

    return [
        {"objClass": "org.sensorhub.impl.security.BasicSecurityRealmConfig", "id": "5f1c7e2a-1d3b-4a8e-9c2f-0b6a4d8e7f10",
         "moduleClass": "org.sensorhub.impl.security.BasicSecurityRealm", "name": "Users and roles (demo credentials)",
         "autoStart": True, "users": users, "roles": roles},
        {"objClass": "org.sensorhub.impl.service.HttpServerConfig", "id": "6ca9c8a8-9768-4b60-9554-a8d277bf6b3f",
         "name": "HTTP Server", "moduleClass": "org.sensorhub.impl.service.HttpServer", "httpPort": port,
         "servletsRootUrl": "/sensorhub", "staticDocsRootDir": "web", "authMethod": "BASIC", "autoStart": True},
        {"objClass": "org.sensorhub.impl.datastore.h2.MVObsSystemDatabaseConfig", "indexObsLocation": False,
         "storagePath": "at32_h2.dat", "memoryCacheSize": 1024, "autoCommitBufferSize": 1024, "useCompression": False,
         "readOnly": False, "databaseNum": 1, "id": DB_ID, "moduleClass": "org.sensorhub.impl.datastore.h2.MVObsSystemDatabase",
         "name": "Obs Database", "autoStart": True},
        consys(API_ID, "Connected Systems API Service", "/api", True),
        consys(INTERNAL_ID, "Connected Systems API Service (internal: command receivers)", "/api-internal", False),
    ]


def find_home(given: str | None) -> Path:
    for cand in filter(None, (given, os.environ.get("OSH_HOME"))):
        p = Path(cand)
        if (p / "lib").is_dir():
            return p
        if (p / "build" / "install" / "osh-core" / "lib").is_dir():
            return p / "build" / "install" / "osh-core"
    raise SystemExit("OpenSensorHub not found: build osh-core 2.0.4 (backend/spike/README.md) and pass --osh "
                     "<osh-core>/build/install/osh-core, or set OSH_HOME")


class Osh:
    """One OpenSensorHub process over an empty store in ``rundir``."""

    def __init__(self, home: Path, rundir: Path, port: int | None = None):
        self.home, self.rundir = home, rundir
        self.port = port or free_port()
        self.proc = None

    @property
    def root(self) -> str:
        return f"http://127.0.0.1:{self.port}/sensorhub"

    def start(self, timeout: float = 120.0) -> float:
        if self.rundir.exists():
            shutil.rmtree(self.rundir)
        self.rundir.mkdir(parents=True)
        (self.rundir / "config.json").write_text(json.dumps(config(self.port), indent=1))
        t0 = time.monotonic()
        self.log = open(self.rundir / "osh.log", "w")
        self.proc = subprocess.Popen(["java", "-Xmx512m", "-cp", str(self.home / "lib") + "/*",
                                      "org.sensorhub.impl.SensorHub", "config.json", "db"],
                                     cwd=self.rundir, stdout=self.log, stderr=subprocess.STDOUT)
        import httpx

        while time.monotonic() - t0 < timeout:
            if self.proc.poll() is not None:
                raise SystemExit(f"OpenSensorHub exited ({self.proc.returncode}); see {self.rundir / 'osh.log'}")
            try:
                r = httpx.get(self.root + "/api/", auth=("owner", "demo-owner"), timeout=2, trust_env=False)
                if r.status_code == 200:
                    return time.monotonic() - t0
            except httpx.HTTPError:
                pass
            time.sleep(0.25)
        raise SystemExit(f"OpenSensorHub did not answer within {timeout:g} s; see {self.rundir / 'osh.log'}")

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(15)
            except subprocess.TimeoutExpired:
                self.proc.kill()
