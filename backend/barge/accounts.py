"""Accounts and roles: the data server's configuration (docs/v4-interfaces.md §9.3; FR-93, FR-102, FR-113, FR-114).

DEMO CREDENTIALS (PR-07). These accounts and passwords exist only in the demonstrator. They are
labelled as such wherever they appear, and a developed system never ships or pre-populates
credentials (FR-102). The same table is in ``web/src/standin/accounts.ts``.

Roles are fixed at installation (FR-114). The owner assigns them through the admin stub (§13.5);
the server reads the assignment on every request, so a change takes effect on the next request
(FR-116, D-151).
"""
from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass

OWNER, EMISSIONS, WEATHER = "owner", "viewer-emissions", "viewer"
SERVICE, SERVICE_NO_CO2 = "service", "service-no-co2"
ROLES = {
    OWNER: "Owner",
    EMISSIONS: "Viewer with emissions",
    WEATHER: "Viewer (weather only)",
    SERVICE: "Service (reads CO₂)",
    SERVICE_NO_CO2: "Service (no CO₂)",
}
# What the control action set-role may be given: a role's name or its label.
ROLE_ALIASES = {**{k: k for k in ROLES}, **{v.lower(): k for k, v in ROLES.items()},
                "emissions": EMISSIONS, "weather": WEATHER, "weather-only": WEATHER, "viewer-weather": WEATHER}
CO2_ROLES = {OWNER, EMISSIONS, SERVICE}

SERVICE_PASSWORD = "svc-demo"


@dataclass
class Account:
    user: str
    password: str
    role: str
    kind: str  # user | service
    component: str  # who it is in the architecture view: client, importer, models

    @property
    def co2(self) -> bool:
        return self.role in CO2_ROLES


def _accounts() -> dict[str, Account]:
    a = [
        Account("owner", "demo-owner", OWNER, "user", "client"),
        Account("friend", "demo-friend", WEATHER, "user", "client"),
        Account("analyst", "demo-analyst", EMISSIONS, "user", "client"),
        Account("svc-importer", SERVICE_PASSWORD, SERVICE, "service", "importer"),
        Account("svc-data-cleanse", SERVICE_PASSWORD, SERVICE, "service", "models"),
        Account("svc-summaries", SERVICE_PASSWORD, SERVICE, "service", "models"),
        Account("svc-analysis", SERVICE_PASSWORD, SERVICE, "service", "models"),
        Account("svc-new-model-1", SERVICE_PASSWORD, SERVICE_NO_CO2, "service", "models"),
        Account("svc-new-model-2", SERVICE_PASSWORD, SERVICE_NO_CO2, "service", "models"),
    ]
    return {x.user: x for x in a}


USERS = ("owner", "friend", "analyst")
MODEL_SERVICES = ("svc-data-cleanse", "svc-summaries", "svc-analysis", "svc-new-model-1", "svc-new-model-2")
DEMO_PASSWORDS = sorted({a.password for a in _accounts().values()})


def parse_basic(header: str | None) -> tuple[str, str] | None:
    """(user, password) from an ``Authorization: Basic`` header, or None."""
    if not header or header[:6].lower() != "basic ":
        return None
    try:
        user, sep, pw = base64.b64decode(header[6:].strip(), validate=True).decode("utf-8").partition(":")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None
    return (user, pw) if sep else None


class Accounts:
    """The server's account table and user-to-role assignment. Kept across restarts."""

    def __init__(self):
        self.by_user = _accounts()

    def authenticate(self, header: str | None) -> Account | None:
        """The account named by an ``Authorization: Basic`` header, or None (401)."""
        up = parse_basic(header)
        if up is None:
            return None
        a = self.by_user.get(up[0])
        return a if a is not None and a.password == up[1] else None

    def set_role(self, user: str, role: str) -> Account:
        if user not in self.by_user:
            raise ValueError(f"unknown account {user!r}")
        a = self.by_user[user]
        r = ROLE_ALIASES.get(str(role).strip().lower()) or ROLE_ALIASES.get(str(role).strip())
        if r is None:
            raise ValueError(f"unknown role {role!r}; roles are {', '.join(ROLES)}")
        if (a.kind == "user") == (r in (SERVICE, SERVICE_NO_CO2)):
            raise ValueError(f"{user} is a {a.kind} account; role {r} is not for it")
        a.role = r  # read on every request: it takes effect on the next one (FR-116, D-151)
        return a

    def role_of(self, user: str) -> str | None:
        a = self.by_user.get(user)
        return a.role if a else None

    def state(self) -> list[dict]:
        return [{"user": a.user, "role": a.role, "kind": a.kind, "label": ROLES[a.role]} for a in self.by_user.values()]


def role_of(user: str) -> str | None:
    """The delivered user-to-role assignment, as a receiving model looks a ``sender`` up (FR-112a, D-152)."""
    a = _accounts().get(user)
    return a.role if a else None


def may_read_co2(role: str | None) -> bool:
    return role in CO2_ROLES


def basic(user: str, password: str) -> str:
    """The Authorization header value for an account."""
    return "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()


def service_header(user: str) -> str:
    return basic(user, SERVICE_PASSWORD)


def password_of(user: str) -> str:
    return _accounts()[user].password
