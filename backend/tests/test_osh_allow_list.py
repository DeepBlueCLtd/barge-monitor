"""The permissions AT-32 configures OpenSensorHub with (D-222, D-351, ADR 0010; backend/independent/osh_server.py).

A stream's title may be known, not its contents (D-351): every role is granted every description, and a role without
CO₂ the contents of the open datastreams and control streams by id, with every contents form denied for each
restricted resource and each system above one (OpenSensorHub inherits grants but not denies, S-AUTH). These tests
check the lists against the rules of interfaces §9.3, which the stand-ins apply, without running OpenSensorHub.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "independent"))

from barge import accounts as A  # noqa: E402
from osh_server import DESCRIBE, P, Resources, config, contents, readable  # noqa: E402

U = "urn:x-barge:"


def install() -> Resources:
    r = Resources()
    for sid, uid, parent in (("p", "platform:barge", None), ("b", "sensor:bow", "p"), ("c", "sensor:bow:co2", "b"),
                             ("m", "process:models", None), ("d", "process:data-cleanse", "m"),
                             ("dr", "process:data-cleanse:restricted", "d"), ("w1", "workspace:owner", None),
                             ("w2", "workspace:friend", None), ("i", "importer", None)):
        r.systems[sid] = {"uid": U + uid, "parent": parent}
    r.datastreams.update({"wx": "b", "co": "c", "cl": "d", "cr": "dr", "doi": "w1", "mine": "w2", "cat": "i"})
    r.controlstreams.update({"imp": "i", "set": "d", "rset": "dr"})
    return r


def test_the_weather_only_role_reads_open_contents_and_no_restricted_contents():
    allow, deny, refused = contents(install(), A.WEATHER, "friend")
    assert refused == []
    for did in ("wx", "cl", "cat", "mine"):  # open, and the friend's own workspace
        assert {f"{P}/list/obs[parent={did}]", f"{P}/get/obs[parent={did}]"} <= set(allow)
    for did in ("co", "cr", "doi"):
        assert not [p for p in allow if f"={did}]" in p], did
        assert f"{P}/list/obs[parent={did}]" in deny
    # Every system above a restricted resource is denied in each contents form: OpenSensorHub tries each in turn.
    for sid in ("c", "b", "p", "dr", "d", "m", "w1"):
        assert f"{P}/list/obs[parent={sid}]" in deny and f"{P}/create/commands[parent={sid}]" in deny, sid
    assert f"{P}/create/commands[parent=imp]" in allow and f"{P}/create/commands[parent=set]" in allow
    assert f"{P}/create/commands[parent=rset]" in deny
    # Never a contents grant on a whole kind.
    assert not [p for p in allow if p in (f"{P}/list/obs", f"{P}/get/obs", f"{P}/get", f"{P}/list")]


def test_an_open_resource_whose_id_is_also_denied_is_refused_and_reported():
    r = install()
    r.datastreams["b"] = "i"  # an open datastream whose id is the bow sensor's: ids of different kinds share strings
    _, deny, refused = contents(r, A.WEATHER, "friend")
    assert refused == ["b"] and f"{P}/list/obs[parent=b]" in deny


def test_readable_follows_the_stand_ins_rules():
    r = install()
    assert not readable(r, "c", A.WEATHER, "friend") and readable(r, "c", A.EMISSIONS, "analyst")
    assert not readable(r, "dr", A.SERVICE_NO_CO2, None) and readable(r, "dr", A.SERVICE, None)
    assert readable(r, "w2", A.WEATHER, "friend") and not readable(r, "w1", A.WEATHER, "friend")


def test_roles_and_users_in_the_configuration():
    r = install()
    cfg, refused = config(8181, r)
    realm = cfg[0]
    by_role = {x["id"]: x for x in realm["roles"]}
    assert set(by_role) == set(A.ROLES) and refused == {A.WEATHER: [], A.SERVICE_NO_CO2: []}
    # Every description, to the roles without CO₂ too (D-351); other users' workspaces closed (a deny closes the
    # system itself); a user's own given back on the user.
    assert set(DESCRIBE) <= set(by_role[A.WEATHER]["allow"])
    assert f"{P}/get/systems/w1" in by_role[A.WEATHER]["deny"] and f"{P}/get/systems/w2" not in by_role[A.WEATHER]["deny"]
    assert by_role[A.OWNER]["deny"][0] == f"{P}/get/systems/w2" and f"{P}/list/obs[parent=mine]" in by_role[A.OWNER]["deny"]
    friend = next(u for u in realm["users"] if u["id"] == "friend")
    assert friend["allow"] == [f"{P}/get/systems/w2"]
    # Services create by id: a model under Models; the importer under the sensors.
    assert f"{P}/create/systems[parent=m]" in by_role[A.SERVICE]["allow"]
    assert f"{P}/create/datastreams[parent=b]" in by_role[A.SERVICE]["allow"]
    assert f"{P}/create/datastreams[parent=b]" not in by_role[A.SERVICE_NO_CO2]["allow"]
    # Before anything exists, the installation's roles.
    install_cfg, _ = config(8181, None)
    assert {x["id"]: x["allow"] for x in install_cfg[0]["roles"]}[A.OWNER] == ["*"]
