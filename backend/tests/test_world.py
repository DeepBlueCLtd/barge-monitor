import numpy as np

from barge import config as C
from barge.truth import World
from barge.world import generate


def test_manifest_is_deterministic_and_records_seeds():
    a, b = generate(11), generate(11)
    assert a == b
    assert set(a["seeds"]["streams"]) >= {"timetable", "airmass", "fronts", "anomaly", "noise-bow", "noise-stern"}
    assert a["generator_version"] == C.GENERATOR_VERSION
    assert generate(12)["voyage"] != a["voyage"]


def test_location_is_declared_open_ocean():
    m = generate(1)
    lat = np.asarray(m["canal"]["centreline"]["lat"])
    lon = np.asarray(m["canal"]["centreline"]["lon"])
    # Within a few km of the declared origin in the open equatorial Atlantic.
    assert np.all(np.abs(lat - C.ORIGIN_LAT) < 0.1) and np.all(np.abs(lon - C.ORIGIN_LON) < 0.1)


def test_every_reach_in_every_hour_within_first_week():
    """FR-06a: revisits cover every reach at every hour of the day in week one."""
    for seed in (1, 2, 3, 4, 5):
        w = World(generate(seed))
        t = np.arange(0, 7 * 86400, 10.0)
        b = w.boat(t)
        r = w.reach_index(b["chainage"])
        h = w.local_hour(t).astype(int)
        moving = b["speed"] > 0
        cov = np.zeros((len(w.r_start), 24), bool)
        cov[r[moving], h[moving]] = True
        assert cov.all(), (seed, np.argwhere(~cov))


def test_period_does_not_divide_a_day():
    from barge import world

    assert 86400 % world.TIMETABLE_PERIOD_S != 0


def test_stoppages_happen():
    m = generate(1)
    assert len(m["voyage"]["stoppages"]) >= 2
    kinds = {s["kind"] for s in m["voyage"]["stoppages"]}
    assert kinds == {"lock-closed", "wharf-delay"}


def test_speed_within_limit_and_locks_change_elevation():
    w = World(generate(1))
    t = np.arange(0, 2 * 86400, 5.0)
    b = w.boat(t)
    assert b["speed"].max() <= C.SPEED_LIMIT_MS + 1e-9
    assert np.ptp(b["elevation"]) > 10.0


def test_week_passes_in_under_an_hour_at_top_rate():
    assert 7 * 86400 / max(C.CLOCK_RATES) < 3600
