import numpy as np

from barge import logger as L
from barge.adapter import StoreAdapter, parse_records
from barge.clock import ManualClock
from barge.sim import Simulation
from barge.world import PARAMS


def test_record_layout_is_fixed_width_and_awkward():
    rec = L.format_record(0.0, -1.25, -24.75, 41.5, {
        "air_temperature": -1.2, "relative_humidity": 88, "pressure": 1008.8,
        "apparent_wind_speed": 0.3, "apparent_wind_direction": 123, "solar_irradiance": 0,
        "water_temperature": 9.9})
    assert len(rec) == L.REC_LEN
    assert rec[84:88] == "M012"  # METAR-style minus
    assert rec[103:106] == "VRB"  # wind too light for a direction
    assert rec[13:19] == "$GPGGA"
    dropout = L.format_record(0.0, None, None, 41.5, {p: 1.0 for p in PARAMS})
    assert ",,,,,0," in dropout
    cols = parse_records((rec + dropout).encode())
    assert cols["air_temperature"][0] == -1.2
    assert np.isnan(cols["apparent_wind_direction"][0]) and cols["wd_code"][0] == 1
    assert abs(cols["lat"][0] + 1.25) < 1e-5 and abs(cols["lon"][0] + 24.75) < 1e-5
    assert np.isnan(cols["lat"][1])


def test_adapter_reads_partial_appends_and_only_complete_records():
    clock = ManualClock(0)
    sim = Simulation(seed=2, clock=clock, warm_start=0)
    ad = sim.adapter
    total = 0
    for _ in range(30):
        clock.advance(37)
        sim.tick()
        total += ad.refresh()
        # The logger holds back part of a record: the adapter never reads past the last newline.
        assert ad.count("bow") <= sim.sensors.next_t
    assert ad.count("bow") >= sim.sensors.next_t - 1
    t = ad.columns("bow")["t"]
    assert np.all(np.diff(t) == 1.0)


def test_store_is_never_altered_and_index_rebuilds_identically():
    clock = ManualClock(0)
    sim = Simulation(seed=4, clock=clock, warm_start=0)
    clock.advance(30 * 3600)  # crosses a day rollover
    sim.tick()
    before = {n: sim.logger.read(n) for n, _ in sim.logger.list_files()}
    sim.adapter.refresh()
    a = {k: v.copy() for k, v in sim.adapter.columns("stern").items()}
    sim.adapter.reset()
    sim.adapter.refresh()
    b = sim.adapter.columns("stern")
    for k in a:
        assert np.array_equal(a[k], b[k], equal_nan=True), k
    after = {n: sim.logger.read(n) for n, _ in sim.logger.list_files()}
    assert before == after
    assert len(before) == 4  # two sensors, two days


def test_readings_match_truth_within_declared_noise():
    clock = ManualClock(0)
    sim = Simulation(seed=6, clock=clock, warm_start=0)
    clock.advance(6 * 3600)
    sim.tick()
    sim.adapter.refresh()
    col = sim.adapter.columns("bow")
    tr = sim.world.sensor_truth(col["t"], "bow")
    sigma = sim.manifest["noise"]["sigma"]
    for p in ("air_temperature", "pressure", "water_temperature", "apparent_wind_speed"):
        d = col[p] - tr[p]
        # Quantisation of the logger adds at most half a unit of its last digit.
        q = 0.05 if p != "relative_humidity" else 0.5
        within = np.abs(d) <= 5 * sigma[p] + q
        assert within.mean() > 0.995, p
