"""FR-10, FR-19, FR-20: the awkward store, and the adapter's index over it."""
import numpy as np

from barge import logger as L
from barge.adapter import StoreAdapter, parse_records
from barge.truth import World
from barge.world import generate
from barge.sensors import Sensors


def test_record_layout_is_fixed_width_and_coded():
    rec = L.format_records(np.array([0.0, 1.0]), {
        "air_temperature": np.array([-1.2, 21.5]), "relative_humidity": np.array([88.0, 50.0]),
        "pressure": np.array([1008.8, 1010.0]), "apparent_wind_speed": np.array([0.3, 4.0]),
        "apparent_wind_direction": np.array([123.0, 359.6]), "solar_irradiance": np.array([0.0, 500.0]),
        "water_temperature": np.array([9.9, np.nan]), "precipitation_type": np.array([0, 2])}).decode()
    a, b = rec.splitlines()
    assert len(a) + 1 == L.REC_LEN
    assert a[13:17] == "M012" and a[32:35] == "VRB" and a[46] == "N"
    assert b[32:35] == "000" and b[41:45] == "////" and b[46] == "R"
    cols = parse_records(rec.encode())
    assert cols["air_temperature"][0] == -1.2 and np.isnan(cols["apparent_wind_direction"][0])
    assert np.isnan(cols["water_temperature"][1]) and cols["precipitation_type"][1] == 2


def test_no_position_is_recorded():
    lg = L.Logger()
    Sensors(World(generate(2)), lg).sample_until(60)
    text = lg.read(lg.list_files()[0][0]).decode()
    assert "GPGGA" not in text and "$" not in text


def test_partial_appends_and_index_rebuild():
    lg = L.Logger()
    s = Sensors(World(generate(2)), lg)
    ad = StoreAdapter(lg)
    for k in range(1, 40):
        s.sample_until(k * 37)
        ad.refresh()
        assert ad.indexed_records() <= 2 * s.next_t
    before = {n: lg.read(n) for n, _ in lg.list_files()}
    a = ad.read("bow", 0, 1e9)
    ad.reset()
    ad.refresh()
    b = ad.read("bow", 0, 1e9)
    for k in a:
        assert np.array_equal(a[k], b[k], equal_nan=True), k
    assert before == {n: lg.read(n) for n, _ in lg.list_files()}  # the store is never altered
    assert np.all(np.diff(a["t"]) == 1.0)
