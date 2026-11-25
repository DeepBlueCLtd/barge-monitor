"""The data folder (FR-15, FR-15a, FR-17, FR-09a; AT-28)."""
import hashlib
import json

import numpy as np
import pytest

from barge import datafolder as DF


@pytest.fixture(scope="module")
def folder():
    return DF.build()


def rows(b: bytes):
    lines = b.decode("ascii").split("\r\n")
    assert lines[-1] == ""
    head = lines[3].split(";")
    return head, [ln.split(";") for ln in lines[4:-1]]


def test_reproducible(folder):
    again = DF.build()
    assert {k: hashlib.sha256(v).hexdigest() for k, v in again.items()} == \
           {k: hashlib.sha256(v).hexdigest() for k, v in folder.items()}


def test_index_lists_every_file(folder):
    index = json.loads(folder["index.json"])
    assert [f["file"] for f in index["files"]] == [m.file for m in DF.MISSIONS]
    for f in index["files"]:
        assert f["size"] == len(folder[f["file"]])
        assert f["sha256"] == hashlib.sha256(folder[f["file"]]).hexdigest()


def test_awkward_dialect(folder):
    b = folder["MISSION_A_20310407.csv"]
    assert b.startswith(b"#") and b"\r\n" in b
    head, rs = rows(b)
    assert head[0] == "T_HS94" and "BOW_AWS[kn]" in head and "STN_CO2[ppm]" in head
    assert len(rs) == 86400
    pr = rs[0][head.index("BOW_PR[hPa]")]
    assert "," in pr and "." not in pr
    t0 = int(rs[0][0])
    assert (t0 // 2) + DF.LOGGER_EPOCH_UNIX == DF.C.SIM_EPOCH_UNIX  # half-seconds since 1994
    assert int(rs[1][0]) - t0 == 2


def test_mission_c_lacks_stern_wind_speed(folder):
    head, rs = rows(folder["MISSION_C_20310421.csv"])
    assert "STN_AWS[kn]" not in head and "BOW_AWS[kn]" in head
    assert len(rs) == 43200


def test_reexport_overlaps_and_differs_in_a_few_readings(folder):
    hb, b = rows(folder["MISSION_B_20310414.csv"])
    hr, r = rows(folder["MISSION_B_20310414_REEXPORT.csv"])
    assert hb == hr
    off = 6 * 3600
    overlap = b[off:]
    assert [x[0] for x in overlap] == [x[0] for x in r[: len(overlap)]]
    differ = sum(1 for x, y in zip(overlap, r) if x != y)
    assert 0 < differ < 0.01 * len(overlap)


def test_co2_follows_engine_load(folder):
    head, rs = rows(folder["MISSION_A_20310407.csv"])
    s = DF.Sampler()
    t = np.arange(0, 86400, dtype=float)
    kind = s.world.boat(t)["kind"]
    co2 = np.array([int(x[head.index("BOW_CO2[ppm]")]) for x in rs], dtype=float)
    moving = co2[kind == DF.KIND_CODES["move"]].mean()
    dwell = co2[kind == DF.KIND_CODES["dwell"]].mean()
    assert moving > dwell + 100
    stern = np.array([int(x[head.index("STN_CO2[ppm]")]) for x in rs], dtype=float)
    assert stern[kind == DF.KIND_CODES["move"]].mean() > moving


def test_at28_the_built_folder_reproduces_exactly():
    """AT-28, FR-15a: scripts/build_data_folder.py --check against the folder the tests read."""
    import subprocess
    import sys
    from pathlib import Path

    from tests.helpers import folder_path

    root = Path(__file__).resolve().parents[2]
    r = subprocess.run([sys.executable, str(root / "scripts" / "build_data_folder.py"), "--check", str(folder_path())],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
