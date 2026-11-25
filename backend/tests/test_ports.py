"""FR-14, SRD §2.2: no host clock or unseeded randomness outside the ports; the OpenAPI master."""
import json
import re
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "barge"


def test_only_the_clock_reads_the_host_clock():
    pat = re.compile(r"time\.(time|monotonic|perf_counter)\(|datetime\.(now|utcnow|today)\(")
    assert [p.name for p in SRC.glob("*.py") if p.name != "clock.py" and pat.search(p.read_text())] == []


def test_randomness_only_from_named_streams():
    pat = re.compile(r"\bimport random\b|np\.random\.(rand|randn|random|normal|uniform|seed)\(")
    assert [p.name for p in SRC.glob("*.py") if pat.search(p.read_text())] == []


def test_only_the_dialect_module_reads_the_csv_format():
    """FR-20: the importer is the only code that understands the CSV files, through its dialect port."""
    pat = re.compile(r"T_HS94|BOW_|\[dC\]")
    users = sorted(p.name for p in SRC.glob("*.py") if pat.search(p.read_text()))
    assert users == ["datafolder.py", "dialect.py"]  # the build-time writer, and the reader


def test_openapi_master_matches_fastapi():
    """The committed master is the source of truth (FR-05): run scripts/export_openapi.py and review the diff."""
    from barge.api import create_app
    from barge.runtime import Runtime

    app = create_app(Runtime(folder=None))
    master = json.loads((SRC.parent.parent / "contracts" / "openapi.json").read_text())
    assert app.openapi() == master, "run scripts/export_openapi.py and review the diff"
