"""FR-11 and FR-12: no host clock or unseeded randomness outside the ports."""
import re
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "barge"


def test_only_the_clock_reads_the_host_clock():
    pattern = re.compile(r"time\.(time|monotonic)\(|datetime\.(now|utcnow|today)\(|date\.today\(")
    offenders = [p.name for p in SRC.glob("*.py") if p.name != "clock.py" and pattern.search(p.read_text())]
    assert offenders == []


def test_randomness_only_from_named_streams():
    pattern = re.compile(r"\bimport random\b|np\.random\.(rand|randn|random|normal|uniform|seed)\(")
    offenders = [p.name for p in SRC.glob("*.py") if pattern.search(p.read_text())]
    assert offenders == []


def test_bridge_calls_the_asgi_app():
    import asyncio

    from barge.bridge import Bridge

    b = Bridge(seed=1)
    status, headers, body = asyncio.run(b.handle("GET", "/conformance", "", None, "/x/api"))
    assert status == 200 and b"conformsTo" in body
