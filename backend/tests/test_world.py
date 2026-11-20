import numpy as np

from barge import config as C
from barge.truth import World
from barge.world import generate


def test_manifest_is_deterministic_and_records_seeds():
    a, b = generate(11), generate(11)
    assert a == b
    assert {"timetable", "fronts", "anomaly", "noise-bow", "noise-stern"} <= set(a["seeds"]["streams"])
    assert a["generator_version"] == C.GENERATOR_VERSION


def test_every_reach_in_every_hour_within_a_week():
    """FR-07: the timetable's period drifts through the day."""
    for seed in (1, 2, 3):
        w = World(generate(seed))
        t = np.arange(0, 7 * 86400, 10.0)
        b = w.boat(t)
        r = w.reach_index(b["chainage"])
        h = w.local_hour(t).astype(int)
        moving = b["speed"] > 0
        cov = np.zeros((len(w.r_start), 24), bool)
        cov[r[moving], h[moving]] = True
        assert cov.all(), (seed, np.argwhere(~cov))


def test_stoppages_happen():
    kinds = {s["kind"] for s in generate(1)["voyage"]["stoppages"]}
    assert kinds == {"lock-closed", "wharf-delay"}
