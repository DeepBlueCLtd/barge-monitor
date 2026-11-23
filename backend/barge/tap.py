"""Message capture (FR-66, FR-67): one tap at every component boundary.

Each boundary in SRD §3.1 calls ``tap.emit`` with a copy of what crosses it and
the letter of the standard it meets (SRD §5). The tap never alters a message
and never changes either side's behaviour: it only records. During
pre-generation it counts without recording (FR-16).

Messages that belong to one HTTP request share a ``chain`` and are numbered
by ``hop`` so the flowchart can play them in order.
"""
from __future__ import annotations

import contextvars
import itertools
import json

LETTERS = {
    "Q": "OGC API – Connected Systems request",
    "D": "Discovery resource: landing page, conformance, SensorML system and datastream descriptions, SWE Common schema",
    "O": "Observations, SWE Common JSON",
    "K": "Command on a Connected Systems control stream",
    "P": "Declared profile, validated by JSON Schema",
    "H": "Plain HTTP status (RFC 9110)",
    "S": "Store query: internal, no public standard",
    "L": "Legacy fixed-width record (the logger's own format)",
    "I": "Internal typed object, no public standard",
}
MAX_CONTENT = 4000
# The eight components of SRD §3 (docs/v4-interfaces.md §1).
COMPONENTS = ("platform", "store", "adapter", "server", "models", "scilibs", "client")

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
    return content if len(content) <= MAX_CONTENT else content[:MAX_CONTENT] + f"… ({len(content)} characters in all)"


class Chain:
    def __init__(self, chain_id: str, hop: int):
        self.id = chain_id
        self.hop = hop

    def next(self) -> int:
        self.hop += 1
        return self.hop


class Tap:
    def __init__(self, now=lambda: 0.0):
        self.now = now
        self.recording = True  # False during pre-generation: counts only
        self.enabled = True  # False switches capture off entirely (AT-10)
        self.counts: dict[str, int] = {}
        self.buffer: list[dict] = []

    def count(self, src: str, dst: str, letter: str, n: int = 1) -> None:
        if not self.enabled:
            return
        key = f"{src}>{dst}:{letter}"
        self.counts[key] = self.counts.get(key, 0) + n

    def emit(self, src: str, dst: str, letter: str, summary: str, content=None, failed: bool = False,
             model: str | None = None, quiet: bool = False) -> None:
        if not self.enabled:
            return
        assert letter in LETTERS, letter
        assert src in COMPONENTS and dst in COMPONENTS, (src, dst)
        self.count(src, dst, letter)
        if not self.recording or quiet:
            return
        ch = _chain.get()
        self.buffer.append({
            "id": next(_ids), "t": self.now(), "src": src, "dst": dst, "letter": letter,
            "summary": summary, "content": _clip(content), "failed": failed,
            "chain": ch.id if ch else None, "hop": ch.next() if ch else 0,
            **({"model": model} if model else {}),
        })

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
        _chain.reset(token)
        return ch.hop if ch else 0


NULL = Tap()
NULL.enabled = False
