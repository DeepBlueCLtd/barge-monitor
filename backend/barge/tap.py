"""Message capture (FR-66, FR-67): one tap at every component boundary.

Each boundary of SRD §3.1 calls ``tap.emit`` with a copy of what crosses it and the letter
of the standard it meets (SRD §5). The tap never alters a message's effect and never
changes either side's behaviour: it only records. ``quiet`` work (models registering at
startup, the silent import of Mission A) is counted, not recorded (docs/v4-interfaces.md §2).

**Credentials are never shown (FR-16a, §9.4).** Every captured ``content`` passes through
``redact`` here, once, centrally: the value of an ``Authorization`` header becomes ``****``,
and so does any JSON member named ``password``.

``t`` is real time (Unix seconds, §3); ``replay_t`` is the replay time then, when a dataset
is loaded. Messages that belong to one HTTP request share a ``chain`` and are numbered by
``hop``.
"""
from __future__ import annotations

import contextvars
import itertools
import json
import re

LETTERS = {
    "Q": "OGC API – Connected Systems request",
    "D": "Discovery resource: landing page, conformance, SensorML system and datastream descriptions, SWE Common schema",
    "O": "Observations, read or published: SWE Common JSON",
    "K": "Command on a Connected Systems control stream, sent or pushed",
    "P": "Declared profile, validated by JSON Schema",
    "H": "HTTP status of 400 or above (RFC 9110), including 401",
    "S": "File request: list the data folder, or read a file (internal, no public standard)",
    "L": "Legacy CSV: the folder listing or the file's rows (the files' own format)",
    "I": "Internal object, no public standard; also the referee (scaffolding)",
}
MAX_CONTENT = 4000
# The components of SRD §3 (docs/v4-interfaces.md §1). Nothing is captured with the
# adoption opening's eight subsystem ids.
COMPONENTS = ("folder", "importer", "replay", "gateway", "server", "models", "scilibs", "client")

_AUTH = re.compile(r"(authorization[\"']?\s*[:=]\s*[\"']?)(?:(?:basic|bearer)\s+)?[^\s\"',}\]]+", re.I)
_PASSWORD = re.compile(r"(\"password\"\s*:\s*)\"(?:[^\"\\]|\\.)*\"", re.I)
_PASSWORD_ARG = re.compile(r"(password=)[^&\s\"']+", re.I)


def redact(text: str) -> str:
    """Credentials out of a captured message (FR-16a)."""
    text = _AUTH.sub(lambda m: m.group(1) + "****", text)
    text = _PASSWORD.sub(lambda m: m.group(1) + '"****"', text)
    return _PASSWORD_ARG.sub(lambda m: m.group(1) + "****", text)


_chain: contextvars.ContextVar = contextvars.ContextVar("tap_chain", default=None)
_ids = itertools.count(1)


def _clip(content) -> str:
    if content is None:
        return ""
    if not isinstance(content, str):
        try:
            content = json.dumps(content, default=str)
        except (TypeError, ValueError):
            content = repr(content)
    content = redact(content)
    return content if len(content) <= MAX_CONTENT else content[:MAX_CONTENT] + f"… ({len(content)} characters in all)"


class Chain:
    def __init__(self, chain_id: str, hop: int):
        self.id = chain_id
        self.hop = hop

    def next(self) -> int:
        self.hop += 1
        return self.hop


class Tap:
    def __init__(self, now=lambda: 0.0, replay_now=lambda: None):
        self.now = now  # real seconds
        self.replay_now = replay_now  # the replay time (Unix seconds), or None when no dataset is loaded
        self.enabled = True  # False switches capture off entirely (FR-66)
        self.counts: dict[str, int] = {}
        self.buffer: list[dict] = []

    def count(self, src: str, dst: str, letter: str, n: int = 1) -> None:
        if not self.enabled:
            return
        key = f"{src}>{dst}:{letter}"
        self.counts[key] = self.counts.get(key, 0) + n

    def emit(self, src: str, dst: str, letter: str, summary: str, content=None, failed: bool = False,
             model: str | None = None, quiet: bool = False, push: bool = False) -> None:
        if not self.enabled:
            return
        assert letter in LETTERS, letter
        assert src in COMPONENTS and dst in COMPONENTS, (src, dst)
        self.count(src, dst, letter)
        if quiet:
            return
        ch = _chain.get()
        m = {"id": next(_ids), "t": round(float(self.now()), 3), "src": src, "dst": dst, "letter": letter,
             "summary": redact(summary), "content": _clip(content), "chain": ch.id if ch else None,
             "hop": ch.next() if ch else 0}
        rt = self.replay_now()
        if rt is not None:
            m["replay_t"] = round(float(rt), 3)
        if failed:
            m["failed"] = True
        if push:
            m["push"] = True
        if model:
            m["model"] = model
        self.buffer.append(m)

    def drain(self) -> list[dict]:
        out, self.buffer = self.buffer, []
        return out

    @staticmethod
    def begin_chain(chain_id: str | None, hop: int = 0):
        return _chain.set(Chain(chain_id or f"c{next(_ids)}", hop))

    @staticmethod
    def chain_id():
        ch = _chain.get()
        return ch.id if ch else None

    @staticmethod
    def end_chain(token) -> int:
        ch = _chain.get()
        try:
            _chain.reset(token)
        except ValueError:  # ended in another context (a streamed answer runs in a task of its own)
            _chain.set(None)
        return ch.hop if ch else 0


NULL = Tap()
NULL.enabled = False
