"""The allow-list AT-32 configures OpenSensorHub with (D-222, ADR 0010; backend/independent/osh_server.py).

OpenSensorHub inherits grants down the system tree but not denies (S-AUTH), so a role that may not read CO₂ is
granted read on every other resource by id. These tests check the list against the rules of interfaces §9.3,
which the stand-ins apply (``barge.api.restricted_for``), without running OpenSensorHub.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "independent"))

from barge import accounts as A  # noqa: E402
from osh_server import P, Resources, allow_list, config, readable, roles  # noqa: E402

U = "urn:x-barge:"


def install() -> Resources:
    r = Resources()
    for sid, uid, parent in (("p", "platform:barge", None), ("b", "sensor:bow", "p"), ("c", "sensor:bow:co2", "b"),
                             ("m", "process:models", None), ("d", "process:data-cleanse", "m"),
                             ("dr", "process:data-cleanse:restricted", "d"), ("w1", "workspace:owner", None),
                             ("w2", "workspace:friend", None), ("i", "importer", None)):
        r.systems[sid] = {"uid": U + uid, "parent": parent}
    r.datastreams.update({"wx": "b", "co": "c", "cl": "d", "cr": "dr", "doi": "w1", "cat": "i"})
    r.controlstreams.update({"imp": "i", "set": "d"})
    return r


def test_the_weather_only_role_reads_by_id_everything_open_and_nothing_restricted():
    perms, collisions = allow_list(install(), A.WEATHER)
    assert collisions == []
    for sid in ("p", "b", "m", "d", "i"):
        assert f"{P}/get/systems/{sid}" in perms
    for sid in ("c", "dr", "w1", "w2"):  # CO₂, a restricted output, workspaces (a user's own is theirs by ownership)
        assert f"{P}/get/systems/{sid}" not in perms
    for did in ("wx", "cl", "cat"):
        assert {f"{P}/get/datastreams/{did}", f"{P}/get/datastreams[parent={did}]", f"{P}/list/obs[parent={did}]"} <= set(perms)
    for did in ("co", "cr", "doi"):
        assert not [p for p in perms if p.endswith(f"/{did}") or f"={did}]" in p], did
    assert f"{P}/create/commands[parent=imp]" in perms and f"{P}/create/commands[parent=set]" in perms
    # Never a grant on a whole kind, which would reach restricted resources; listings are whole (4.7, FR-93).
    assert not [p for p in perms if p in (f"{P}/get", f"{P}/get/datastreams", f"{P}/list/obs", f"{P}/get/obs")]
    assert f"{P}/list/systems" in perms and f"{P}/list/datastreams" in perms


def test_a_grant_whose_id_is_also_a_closed_system_is_reported():
    r = install()
    r.datastreams["c"] = "b"  # a weather datastream whose id is the bow CO₂ analyser's: ids are separate spaces
    _, collisions = allow_list(r, A.WEATHER)
    assert collisions == ["c"]


def test_readable_follows_the_stand_ins_rules():
    r = install()
    assert not readable(r, "c", A.WEATHER, "friend") and readable(r, "c", A.EMISSIONS, "analyst")
    assert not readable(r, "dr", A.SERVICE_NO_CO2, None) and readable(r, "dr", A.SERVICE, None)
    assert readable(r, "w2", A.WEATHER, "friend") and not readable(r, "w1", A.WEATHER, "friend")


def test_roles_and_users_in_the_configuration():
    r = install()
    cfg, collisions = config(8181, r)
    realm = cfg[0]
    by_role = {x["id"]: x for x in realm["roles"]}
    assert set(by_role) == set(A.ROLES) and collisions == {A.WEATHER: [], A.SERVICE_NO_CO2: []}
    # The owner and the analyst read everything but other users' workspaces (a deny closes the system only).
    assert by_role[A.OWNER]["deny"] == [f"{P}/get/systems/w1", f"{P}/get/systems/w2"]
    owner = next(u for u in realm["users"] if u["id"] == "owner")
    assert owner["allow"] == [f"{P}/get/systems/w1"]
    # Services create by id: a model under Models; the importer under the sensors.
    assert f"{P}/create/systems[parent=m]" in by_role[A.SERVICE]["allow"]
    assert f"{P}/create/datastreams[parent=b]" in by_role[A.SERVICE]["allow"]
    assert f"{P}/create/datastreams[parent=b]" not in by_role[A.SERVICE_NO_CO2]["allow"]
    # Before anything exists, the installation's roles.
    install_cfg, _ = config(8181, None)
    assert {x["id"]: x["allow"] for x in install_cfg[0]["roles"]}[A.OWNER] == ["*"]
