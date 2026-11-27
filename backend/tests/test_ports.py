"""FR-14, FR-15: no host clock or unseeded randomness outside the ports."""
import re
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "barge"


def test_only_the_clock_reads_the_host_clock():
    pat = re.compile(r"time\.(time|monotonic|perf_counter)\(|datetime\.(now|utcnow|today)\(")
    assert [p.name for p in SRC.glob("*.py") if p.name != "clock.py" and pat.search(p.read_text())] == []


def test_randomness_only_from_named_streams():
    pat = re.compile(r"\bimport random\b|np\.random\.(rand|randn|random|normal|uniform|seed)\(")
    assert [p.name for p in SRC.glob("*.py") if pat.search(p.read_text())] == []


def test_openapi_master_matches_fastapi():
    """AT-12: the committed master is the source of truth (FR-65)."""
    import json

    from barge.api import create_app
    from barge.runtime import Runtime

    app = create_app(Runtime())
    master = json.loads((SRC.parent.parent / "contracts" / "openapi.json").read_text())
    assert app.openapi() == master, "run scripts/export_openapi.py and review the diff"
