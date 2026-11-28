"""A stock OpenSensorHub for AT-32, configured as interfaces §14 allows: its configuration and its process.

OpenSensorHub ``osh-core`` 2.0.4 (commit ``75bb094``), built from source as ``backend/independent/README.md`` says,
unmodified. Nothing stands between the clients and it (4.7: no gateway, ADR 0010). The configuration is the
distribution's own modules with:

* a ``BasicSecurityRealm`` holding the delivered accounts (``barge/accounts.py``; demo credentials, PR-07), one
  OpenSensorHub role per role there, with the permissions of ``roles`` (D-351);
* HTTP Basic authentication on the HTTP server;
* two Connected Systems endpoints on one database: ``/api`` (access control on) and ``/api-internal`` (access
  control off, authentication on), where command receivers subscribe, since OpenSensorHub closes their WebSocket
  on ``/api`` (S-AUTH, D-223);
* the profile (FR-41) as a static document at ``/sensorhub/profile.json``, beside ``/sensorhub/api/``: the only
  file a stock server can serve, and it serves static documents without authentication (D-345);
* **secure identifiers**, OpenSensorHub's own ``useSecureIds`` start option: each kind of resource has its ids
  encrypted with a key of its own (``IdEncodersDES``, kept in ``db/idKeys.txt``), so a system's id is no longer also
  a datastream's or a control stream's. Without it the ids of the three kinds are counted alike and share strings,
  and the permissions below collide (D-348, D-351).

**What a role without CO₂ may read (D-351, the owner: "a stream's title may be known, not its contents").** Every
description is granted whole: systems, datastreams (their schemas included) and control streams, listed and read.
Contents (observations, commands and their status) are granted by an allow-list of the open datastreams and control
streams, by OpenSensorHub id, and **denied** for every restricted datastream and control stream and every system
above one. OpenSensorHub tries a contents permission in the form ``…[parent=<id>]`` for the resource and then for
each system above it, and a deny is not inherited (S-AUTH): denying that form for every id on a restricted chain
closes each step of the walk. Should an open resource's id also be a denied system's, it is refused too (the
configuration errs towards refusing) and reported (``contents``); with secure identifiers none is. The first
configuration, D-348's, granted descriptions by the same allow-list without secure identifiers, and its collisions
opened restricted contents.

The list names resources, so it is written once they exist and again whenever an import or a model creates more;
the permissions are re-read only when the security module restarts (here, the whole server, over the same store).
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from barge import accounts as A  # noqa: E402
from barge.api import CO2, RESTRICTED, WORKSPACE  # noqa: E402  the stand-ins' own matching of restricted ids (§9.3)

DB_ID = "0309491d-d5cb-4f2f-9b95-166179c66746"
API_ID = "9d23a6a7-7455-41d1-9f1d-494be4e2463c"
INTERNAL_ID = "c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f"
REALM_ID = "5f1c7e2a-1d3b-4a8e-9c2f-0b6a4d8e7f10"
P = "csapi[*]"  # every Connected Systems endpoint: access control is on only on /api
READ_ALL = [f"{P}/get", f"{P}/list", f"{P}/stream"]
# Descriptions, granted whole to every role (D-351): systems, datastreams with their schemas, control streams.
DESCRIBE = [f"{P}/{op}/{kind}" for op in ("get", "list") for kind in ("systems", "datastreams", "controls")]
# Contents, in the form OpenSensorHub checks them, by the datastream's or control stream's id and each system above.
OBS = [("list", "obs"), ("get", "obs")]
# The one user each user role has here: a workspace is its user's, so a role's list names that user's (§9.3).
ROLE_USER = {A.OWNER: "owner", A.EMISSIONS: "analyst", A.WEATHER: "friend"}
COMMANDS = [("create", "commands"), ("list", "commands"), ("get", "commands"), ("list", "status"), ("get", "status")]


@dataclass
class Resources:
    """What the server holds, by OpenSensorHub id: from ``GET /systems?searchMembers=true``, each system's
    ``/subsystems`` (for parents), ``/datastreams`` and ``/controlstreams``."""
    systems: dict = field(default_factory=dict)  # id -> {"uid", "parent"}
    datastreams: dict = field(default_factory=dict)  # id -> system id
    controlstreams: dict = field(default_factory=dict)  # id -> system id

    def chain(self, sid: str) -> list[str]:
        out = []
        while sid is not None and sid not in out:
            out.append(sid)
            sid = self.systems.get(sid, {}).get("parent")
        return out

    def uid(self, sid: str) -> str:
        return self.systems.get(sid, {}).get("uid", "")


def readable(res: Resources, sid: str, role: str, user: str | None) -> bool:
    """Whether a role (and user) may read the contents under a system, by the rules of interfaces §9.3: what the
    stand-ins check (``barge.api.restricted_for``)."""
    for s in res.chain(sid):
        u = res.uid(s)
        if (CO2.match(u) or RESTRICTED.match(u)) and not A.may_read_co2(role):
            return False
        m = WORKSPACE.match(u)
        if m and m.group(1) != user:
            return False
    return True


def _forms(ids, forms) -> list[str]:
    return [f"{P}/{op}/{kind}[parent={i}]" for i in ids for op, kind in forms]


def contents(res: Resources, role: str, user: str | None = None) -> tuple[list[str], list[str], list[str]]:
    """``(allow, deny, refused)`` for the contents a role may read: observations of the open datastreams and the
    commands and status of the open control streams, allowed by id; every form denied for each restricted
    datastream and control stream and each system above one. ``refused``: open resources whose id is also denied
    (ids of different kinds share strings), so refused although open."""
    allow, open_ids, closed = [], set(), set()
    for kinds, forms in ((res.datastreams, OBS), (res.controlstreams, COMMANDS)):
        for rid, sid in kinds.items():
            if readable(res, sid, role, user):
                allow += _forms([rid], forms)
                open_ids.add(rid)
            else:
                closed |= {rid, *res.chain(sid)}
    deny = _forms(sorted(closed), OBS + COMMANDS)
    return allow, deny, sorted(open_ids & closed)


def roles(res: Resources | None) -> tuple[list[dict], dict]:
    """Every role's configuration, and the open resources each refuses by collision. ``res`` None: the installation's
    roles, before any resource exists to be named (every account may read and create; creating makes the creator
    its owner)."""
    out, refused = [], {}
    cls = "org.sensorhub.impl.security.BasicSecurityRealmConfig$RoleConfig"
    for r, label in A.ROLES.items():
        deny = []
        if res is None:
            allow = ["*"] if r == A.OWNER else READ_ALL + [f"{P}/create", f"{P}/update"]
        elif r == A.SERVICE:  # the core services read everything, CO₂ included (§9.3)
            allow = READ_ALL + [f"{P}/create/commands", f"{P}/create/status"] + _creates(res)
        elif r in (A.OWNER, A.EMISSIONS):
            # Everything, CO₂ included, but other users' workspaces: their systems, and the contents under them, are
            # denied by id. What another user creates later is not in the list (the maintenance of D-222).
            user = ROLE_USER[r]
            allow = READ_ALL + [f"{P}/create/commands"]
            others = {s for s, v in res.systems.items() if (m := WORKSPACE.match(v["uid"])) and m.group(1) != user}
            under = [x for kinds in (res.datastreams, res.controlstreams) for x, s in kinds.items()
                     if set(res.chain(s)) & others]
            deny = [f"{P}/get/systems/{s}" for s in sorted(others)] + _forms(sorted(others) + under, OBS + COMMANDS)
        else:
            # Weather only, and services without CO₂: every description; contents by allow-list, with denies.
            user = ROLE_USER.get(r)
            allow, deny, refused[r] = contents(res, r, user)
            allow = DESCRIBE + allow
            deny += [f"{P}/get/systems/{s}" for s, v in res.systems.items()
                     if (m := WORKSPACE.match(v["uid"])) and m.group(1) != user]
            if r == A.SERVICE_NO_CO2:
                allow += [f"{P}/create/status"] + _creates(res, importer=False)
        out.append({"objClass": cls, "id": r, "name": label, "allow": allow, "deny": deny})
    return out, refused


def _creates(res: Resources, importer: bool = True) -> list[str]:
    """What services create, by id: a model its own system under Models; the importer each dataset's datastreams
    under the sensors and their analysers, and their observations. Everything under a system they made is theirs
    already: OpenSensorHub makes the creator the owner."""
    by_uid = {v["uid"]: k for k, v in res.systems.items()}
    out = []
    if "urn:x-barge:process:models" in by_uid:
        out.append(f"{P}/create/systems[parent={by_uid['urn:x-barge:process:models']}]")
    if importer:
        for s in ("bow", "stern"):
            if f"urn:x-barge:sensor:{s}" in by_uid:
                sid = by_uid[f"urn:x-barge:sensor:{s}"]
                out += [f"{P}/create/datastreams[parent={sid}]", f"{P}/create/obs[parent={sid}]"]
    return out


def users(res: Resources | None) -> list[dict]:
    """Every account, with its role. A user is given its own workspace back by id: the role closes every workspace
    system, and OpenSensorHub checks a user's own list after its roles'. What is under it is the user's already:
    OpenSensorHub made the user its owner when the user created it."""
    cls = "org.sensorhub.impl.security.BasicSecurityRealmConfig$UserConfig"
    by_uid = {v["uid"]: k for k, v in (res.systems if res else {}).items()}
    out = []
    for a in A.Accounts().by_user.values():
        own = by_uid.get(f"urn:x-barge:workspace:{a.user}")
        allow = [f"{P}/get/systems/{own}"] if own and a.kind == "user" else []
        out.append({"objClass": cls, "id": a.user, "name": a.user, "password": a.password, "roles": [a.role],
                    "allow": allow, "deny": []})
    return out


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def config(port: int, res: Resources | None) -> tuple[list, dict]:
    role_cfg, refused = roles(res)
    user_cfg = users(res)

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
        {"objClass": "org.sensorhub.impl.security.BasicSecurityRealmConfig", "id": REALM_ID,
         "moduleClass": "org.sensorhub.impl.security.BasicSecurityRealm", "name": "Users and roles (demo credentials)",
         "autoStart": True, "users": user_cfg, "roles": role_cfg},
        {"objClass": "org.sensorhub.impl.service.HttpServerConfig", "id": "6ca9c8a8-9768-4b60-9554-a8d277bf6b3f",
         "name": "HTTP Server", "moduleClass": "org.sensorhub.impl.service.HttpServer", "httpPort": port,
         "servletsRootUrl": "/sensorhub", "staticDocsRootUrl": "/", "staticDocsRootDir": "web", "authMethod": "BASIC",
         "autoStart": True},
        {"objClass": "org.sensorhub.impl.datastore.h2.MVObsSystemDatabaseConfig", "indexObsLocation": False,
         "storagePath": "at32_h2.dat", "memoryCacheSize": 1024, "autoCommitBufferSize": 1024, "useCompression": False,
         "readOnly": False, "databaseNum": 1, "id": DB_ID, "moduleClass": "org.sensorhub.impl.datastore.h2.MVObsSystemDatabase",
         "name": "Obs Database", "autoStart": True},
        consys(API_ID, "Connected Systems API Service", "/api", True),
        consys(INTERNAL_ID, "Connected Systems API Service (internal: command receivers)", "/api-internal", False),
    ], refused


def find_home(given: str | None) -> Path:
    for cand in filter(None, (given, os.environ.get("OSH_HOME"))):
        p = Path(cand)
        if (p / "lib").is_dir():
            return p
        if (p / "build" / "install" / "osh-core" / "lib").is_dir():
            return p / "build" / "install" / "osh-core"
    raise SystemExit("OpenSensorHub not found: build osh-core 2.0.4 (backend/independent/README.md) and pass --osh "
                     "<osh-core>/build/install/osh-core, or set OSH_HOME")


class Osh:
    """One OpenSensorHub process over a store in ``rundir``, kept across restarts."""

    def __init__(self, home: Path, rundir: Path, profile: Path, port: int | None = None):
        self.home, self.rundir, self.profile = home, rundir, profile
        self.port = port or free_port()
        self.proc = None
        self.refused: dict = {}  # role -> open resources refused because their id is also a denied one

    @property
    def root(self) -> str:
        return f"http://127.0.0.1:{self.port}/sensorhub"

    def start(self, res: Resources | None = None, fresh: bool = True, timeout: float = 120.0) -> float:
        """Start over an empty store (``fresh``), or again over the same one, with the roles for ``res``."""
        if fresh:
            if self.rundir.exists():
                shutil.rmtree(self.rundir)
            self.rundir.mkdir(parents=True)
            # The profile beside the API, at /sensorhub/profile.json: a static document is the only file a stock
            # server serves, and one under /sensorhub/api/ would need that directory, which then answers the API's
            # landing page with its listing (tried: 200, text/html, without credentials). D-345.
            web = self.rundir / "web" / "sensorhub"
            web.mkdir(parents=True)
            shutil.copy(self.profile, web / "profile.json")
        cfg, self.refused = config(self.port, res)
        (self.rundir / "config.json").write_text(json.dumps(cfg, indent=1))
        t0 = time.monotonic()
        self.log = open(self.rundir / "osh.log", "a")
        self.proc = subprocess.Popen(["java", "-Xmx768m", "-cp", str(self.home / "lib") + "/*",
                                      "org.sensorhub.impl.SensorHub", "config.json", "db", "useSecureIds"],
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

    def restart(self, res: Resources) -> float:
        """The allow-list written again for what now exists, and the server restarted to read it (D-222)."""
        self.stop()
        return self.start(res, fresh=False)

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(15)
            except subprocess.TimeoutExpired:
                self.proc.kill()
