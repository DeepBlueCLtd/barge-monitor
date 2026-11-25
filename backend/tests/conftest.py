import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "models"))

PLAYED_TO = "2031-04-07T01:00:00Z"


@pytest.fixture(scope="session")
def played():
    """The back end with the core models, Mission A played from its start to 01:00 at 10×, then paused.
    Tests that use it must leave it as they found it (or say what they change)."""
    from tests.helpers import Rig

    r = Rig()
    r.play_until(PLAYED_TO, rate=10)
    yield r
    r.close()


def pytest_sessionfinish(session, exitstatus):
    from tests.helpers import Rig

    for r in Rig.all:
        r.close()
