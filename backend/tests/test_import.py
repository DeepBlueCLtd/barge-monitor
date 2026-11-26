"""The data folder and the CSV importer (SRD §6.1, §6.2): AT-01, AT-03, AT-40 to AT-43, AT-48, AT-54."""
import gzip
import hashlib
import json

import numpy as np
import pytest

from barge import dialect
from barge.importer import dataset_id
from barge.times import parse_iso
from barge.truth import World
from tests import second_dialect
from tests.helpers import Rig, column, copy_folder, folder_path

A_FILE = "MISSION_A_20310407.csv"
B_FILE = "MISSION_B_20310414.csv"
BX_FILE = "MISSION_B_20310414_REEXPORT.csv"
IMPORTER = "urn:x-barge:importer"
REPLAY = "urn:x-barge:replay"


def raw(name, folder=None):
    p = (folder or folder_path()) / (name + ".gz")
    return gzip.decompress(p.read_bytes()) if p.exists() else ((folder or folder_path()) / name).read_bytes()


def folder_hashes(path):
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(path.iterdir())}


def catalogue(r):
    d = r.ds(IMPORTER, "catalogue")
    latest = {}
    for row in r.obs(d["id"]):
        latest[(row["file"], row["sha256"])] = row
    return latest


def wait_status(r, uid, name, cmd_id, final=("COMPLETED", "FAILED", "REJECTED"), steps=50):
    for _ in range(steps):
        st = r.status_of(uid, name, cmd_id)
        if st and st[-1]["statusCode"] in final:
            return st
        r.step(0.1)
    raise AssertionError(f"command {cmd_id} never finished: {st}")


@pytest.fixture(scope="module")
def bare():
    """The back end alone (no models) over a private copy of the folder."""
    return Rig(models=False)


def test_dialect_units_and_missing_values():
    """FR-17: tenths of a degree, knots, a decimal comma, -9999 and VRB; a missing column is absent."""
    text = ("#LOGGER=X\r\n#EXPORT=Y\r\n#MISSION=Test\r\n"
            "T_HS94;BOW_AT[dC];BOW_AWS[kn];BOW_PR[hPa];BOW_AWD[deg]\r\n"
            "3351808000;173;10,0;1019,2;VRB\r\n3351808002;-9999;-9999;1019,3;12\r\n")
    p = dialect.parse(text.encode())
    assert p.t.tolist() == [3351808000 // 2 + dialect.LOGGER_EPOCH_UNIX, 3351808002 // 2 + dialect.LOGGER_EPOCH_UNIX]
    assert p.values[("bow", "air_temperature")][0] == pytest.approx(17.3)
    assert np.isnan(p.values[("bow", "air_temperature")][1])
    assert p.values[("bow", "apparent_wind_speed")][0] == pytest.approx(5.14444)
    assert p.values[("bow", "pressure")].tolist() == [1019.2, 1019.3]
    assert p.variable[("bow", "apparent_wind_direction")].tolist() == [True, False]
    assert ("stern", "air_temperature") not in p.values and p.mission == "Test"


def test_at01_observations_match_the_file_and_the_manifest(bare):
    """AT-01: what the server serves is the file's rows in declared units, and the manifest's truth at each time."""
    r = bare
    ds = r.dataset("MISSION_A")
    d = r.ds("urn:x-barge:sensor:bow", f"weather__{ds}")
    rows = r.obs(d["id"], {"phenomenonTime": "2031-04-07T06:00:00Z/2031-04-07T07:59:59Z"})
    assert len(rows) == 7200
    lines = raw(A_FILE).decode().split("\r\n")
    head = lines[3].split(";")
    first = 4 + 6 * 3600
    for k in (0, 1234, 7199):
        cells = lines[first + k].split(";")
        assert rows[k]["time"] == f"2031-04-07T{6 + k // 3600:02d}:{k // 60 % 60:02d}:{k % 60:02d}Z"
        at = cells[head.index("BOW_AT[dC]")]
        assert rows[k]["air_temperature"] == ("NaN" if at == "-9999" else pytest.approx(int(at) / 10))
        kn = cells[head.index("BOW_AWS[kn]")]
        assert rows[k]["apparent_wind_speed"] == pytest.approx(float(kn.replace(",", ".")) * 0.514444, abs=1e-4)
        assert rows[k]["pressure"] == pytest.approx(float(cells[head.index("BOW_PR[hPa]")].replace(",", ".")))
    manifest = json.loads(gzip.decompress((folder_path() / "manifest.json.gz").read_bytes()))
    w = World(manifest["world"])
    t = np.array([parse_iso(x["time"]) for x in rows])
    truth = w.sensor_truth(t - 1933286400, "bow")
    sigma = manifest["world"]["noise"]["sigma"]
    for p in ("air_temperature", "relative_humidity", "pressure", "water_temperature"):
        v = column(rows, p)
        good = np.array([x[f"{p}_qc"] == "1" for x in rows])
        assert good.mean() > 0.9
        q = 0.5 if p == "relative_humidity" else 0.06
        assert np.nanmax(np.abs(v[good] - truth[p][good])) <= 6 * sigma[p] + q, p


def test_co2_is_never_in_the_weather_record(bare):
    """FR-21c: CO₂ goes to the analysers' datastreams, in ppm with its QC flag."""
    ds = bare.dataset("MISSION_A")
    w = bare.ds("urn:x-barge:sensor:bow", f"weather__{ds}")
    c = bare.ds("urn:x-barge:sensor:bow:co2", f"co2__{ds}")
    assert "co2" not in json.dumps(bare.get(f"/datastreams/{w['id']}/schema").json)
    rows = bare.obs(c["id"], {"limit": "5"})
    assert set(rows[0]) == {"time", "co2", "co2_qc"} and 300 < rows[0]["co2"] < 2000


def test_import_speed_and_silent_start(bare):
    """FR-15: Mission A imported silently at startup; a 24-hour file in well under 10 s."""
    assert bare.rt.importer.rate and 86400 / bare.rt.importer.rate < 10
    assert not [m for m in bare.rt.tap.buffer if m["src"] == "importer" and "MISSION_A" in m["summary"]]
    assert bare.rt.tap.counts.get("importer>server:I", 0) >= 87  # counted, one I per 1,000 rows (FR-67)


def test_at03_a_second_dialect_changes_the_importer_only(tmp_path):
    """AT-03: the same recording in a second dialect; only the importer's parser differs; every response the same."""
    one = copy_folder(tmp_path / "one", files=[A_FILE + ".gz"])
    two = tmp_path / "two"
    two.mkdir()
    (two / A_FILE).write_bytes(second_dialect.write(raw(A_FILE)))
    (two / "manifest.json.gz").write_bytes((one / "manifest.json.gz").read_bytes())
    assert (two / A_FILE).read_bytes().startswith(b"time,bow.air_temperature (C)")
    first = Rig(folder=one, models=False)
    second = Rig(folder=two, models=False, parser=second_dialect.parse)
    da, db = first.dataset("MISSION_A"), second.dataset("MISSION_A")
    assert da != db  # the id carries the file's own hash (§6)
    for uid, out in (("urn:x-barge:sensor:bow", "weather"), ("urn:x-barge:sensor:stern", "weather"),
                     ("urn:x-barge:sensor:stern:co2", "co2")):
        a, b = first.ds(uid, f"{out}__{da}"), second.ds(uid, f"{out}__{db}")
        for params in ({"limit": "3000"}, {"resultTime": "latest"}, {"phenomenonTime": "2031-04-07T12:00:00Z/..", "limit": "500"}):
            ra = first.get(f"/datastreams/{a['id']}/observations", {"f": "application%2Fswe%2Bjson", **params})
            rb = second.get(f"/datastreams/{b['id']}/observations", {"f": "application%2Fswe%2Bjson", **params})
            assert ra.status == rb.status == 200 and ra.body == rb.body, (uid, params)
        sa = first.get(f"/datastreams/{a['id']}/schema", {"obsFormat": "application%2Fswe%2Bjson"}).body
        sb = second.get(f"/datastreams/{b['id']}/schema", {"obsFormat": "application%2Fswe%2Bjson"}).body
        assert sa == sb
    norm = lambda r, ds: sorted(d["outputName"].replace(ds, "{ds}") for d in r.get("/datastreams").json["items"])  # noqa: E731
    assert norm(first, da) == norm(second, db)
    assert first.state()["start"] == second.state()["start"] and first.state()["end"] == second.state()["end"]


@pytest.fixture(scope="module")
def folder_rig(tmp_path_factory):
    path = copy_folder(tmp_path_factory.mktemp("folder"))
    return path, Rig(folder=path, models=False)


def test_at40_the_catalogue_lists_every_file_and_a_new_one_after_rescan(folder_rig):
    path, r = folder_rig
    index = json.loads((path / "index.json").read_text())["files"]
    cat = catalogue(r)
    for f in index:
        row = cat[(f["file"], f["sha256"])]
        assert (row["size"], row["modified"]) == (f["size"], f["modified"])
        assert row["status"] == ("imported" if f["file"] == A_FILE else "not-imported")
        if row["status"] == "not-imported":  # a Count has no missing value in OpenSensorHub: 0 until imported (D-197)
            assert row["records"] == 0, row
    a = cat[(A_FILE, index[0]["sha256"])]
    assert a["dataset"] == dataset_id(A_FILE, index[0]["sha256"]) and a["records"] == 86400
    (path / "MISSION_D_20310428.csv.gz").write_bytes((path / "MISSION_C_20310421.csv.gz").read_bytes())
    assert not [k for k in catalogue(r) if k[0].startswith("MISSION_D")]
    cid = r.command(IMPORTER, "import", {"action": "rescan", "file": ""}).json["id"]
    wait_status(r, IMPORTER, "import", cid)
    d = [v for k, v in catalogue(r).items() if k[0] == "MISSION_D_20310428.csv"]
    assert d and d[0]["status"] == "not-imported"
    (path / "MISSION_D_20310428.csv.gz").unlink()


def test_at41_opening_a_file_imports_it_with_progress_then_loads_it(folder_rig):
    path, r = folder_rig
    before = folder_hashes(path)
    rej = r.command(IMPORTER, "import", {"action": "import", "file": "NO_SUCH.csv"}).json["id"]
    st = wait_status(r, IMPORTER, "import", rej)
    assert st[-1]["statusCode"] == "REJECTED" and "NO_SUCH.csv" in st[-1]["message"]
    cid = r.command(IMPORTER, "import", {"action": "import", "file": B_FILE}).json["id"]
    st = wait_status(r, IMPORTER, "import", cid)
    codes = [s["statusCode"] for s in st]
    assert codes[0] == "ACCEPTED" and codes[-1] == "COMPLETED" and codes.count("EXECUTING") == 10
    assert [s["message"] for s in st if s["statusCode"] == "EXECUTING"][-1] == "100%"
    ds = r.dataset("MISSION_B_20310414.csv")
    rows = [v for k, v in catalogue(r).items() if k[0] == B_FILE]
    assert rows[0]["status"] == "imported" and rows[0]["dataset"] == ds
    pct = [x["pct"] for x in r.obs(r.ds(IMPORTER, "catalogue")["id"]) if x["file"] == B_FILE and x["status"] == "importing"]
    assert pct[0] == 0 and len(pct) >= 5
    r.replay("load", dataset=ds)
    assert r.state()["dataset"] == ds and r.state()["start"] == "2031-04-14T00:00:00Z"
    assert folder_hashes(path) == before  # FR-17a: nothing in the folder changes


def test_at42_overlapping_files_are_kept_apart(folder_rig):
    path, r = folder_rig
    if not any(d["file"] == B_FILE for d in r.rt.importer.datasets.values()):
        wait_status(r, IMPORTER, "import", r.command(IMPORTER, "import", {"action": "import", "file": B_FILE}).json["id"])
    cid = r.command(IMPORTER, "import", {"action": "import", "file": BX_FILE}).json["id"]
    wait_status(r, IMPORTER, "import", cid)
    b, bx = r.dataset("MISSION_B_20310414.csv"), r.dataset(BX_FILE)
    db, dbx = r.ds("urn:x-barge:sensor:bow", f"weather__{b}"), r.ds("urn:x-barge:sensor:bow", f"weather__{bx}")
    assert db["id"] != dbx["id"]
    span = {"phenomenonTime": "2031-04-14T06:00:00Z/2031-04-14T23:59:59Z"}
    rb, rbx = r.obs(db["id"], span), r.obs(dbx["id"], span)
    assert [x["time"] for x in rb] == [x["time"] for x in rbx] and len(rb) == 18 * 3600
    differ = [i for i, (x, y) in enumerate(zip(rb, rbx)) if x != y]
    assert 0 < len(differ) < 0.01 * len(rb)
    lines_b = raw(B_FILE).decode().split("\r\n")
    head = lines_b[3].split(";")
    for i in differ[:20]:  # B's datastream holds B's readings, never the re-export's
        cells = lines_b[4 + 6 * 3600 + i].split(";")
        at = cells[head.index("BOW_AT[dC]")]
        assert rb[i]["air_temperature"] == ("NaN" if at == "-9999" else pytest.approx(int(at) / 10))
    whole = r.obs(dbx["id"])
    assert whole[0]["time"] == "2031-04-14T06:00:00Z" and len(whole) == 86400


def test_at43_a_changed_file_is_a_new_dataset_and_the_old_one_is_superseded(folder_rig):
    path, r = folder_rig
    if not any(d["file"] == B_FILE for d in r.rt.importer.datasets.values()):
        wait_status(r, IMPORTER, "import", r.command(IMPORTER, "import", {"action": "import", "file": B_FILE}).json["id"])
    old = r.dataset("MISSION_B_20310414.csv")
    text = raw(B_FILE, path).decode()
    lines = text.split("\r\n")
    cells = lines[4].split(";")
    cells[1] = str(int(cells[1]) + 5)  # one reading re-calibrated
    lines[4] = ";".join(cells)
    (path / (B_FILE + ".gz")).unlink()
    (path / B_FILE).write_bytes("\r\n".join(lines).encode())
    cid = r.command(IMPORTER, "import", {"action": "rescan", "file": ""}).json["id"]
    wait_status(r, IMPORTER, "import", cid)
    assert [v for k, v in catalogue(r).items() if k[0] == B_FILE and v["dataset"] == old][-1]["status"] == "changed"
    cid = r.command(IMPORTER, "import", {"action": "import", "file": B_FILE}).json["id"]
    wait_status(r, IMPORTER, "import", cid)
    new = r.dataset("MISSION_B_20310414.csv")
    assert new != old and r.rt.importer.datasets[old]["superseded"]
    cat = catalogue(r)
    statuses = {v["dataset"]: v["status"] for k, v in cat.items() if k[0] == B_FILE}
    assert statuses[old] == "superseded" and statuses[new] == "imported"
    r.replay("load", dataset=old)  # the superseded one still opens
    assert r.state()["dataset"] == old
    assert r.ds("urn:x-barge:sensor:bow", f"weather__{old}") and r.ds("urn:x-barge:sensor:bow", f"weather__{new}")


def test_at54_at48_reset_instance_empties_the_store_and_reimporting_restores(tmp_path):
    path = copy_folder(tmp_path / "f")
    r = Rig(folder=path, models=False)
    before = folder_hashes(path)
    a = r.dataset("MISSION_A")
    sha = r.rt.importer.datasets[a]["sha256"]
    ws = r.ds("urn:x-barge:workspace:owner", "data-of-interest")
    doi = {"version": 1, "label": "x", "dataset": {"file": A_FILE, "size": 1, "modified": "2031-04-08T02:00:00Z",
                                                    "sha256": sha}}
    assert r.request("POST", f"/datastreams/{ws['id']}/observations", body={
        "time": "2026-11-25T12:00:00Z", "doi_id": "d1", "action": "save", "record": json.dumps(doi)},
        ctype="application/swe+json").status == 201
    r.control("reset-instance")
    r.step(0.5)
    assert r.rt.running and not r.rt.importer.datasets
    assert r.state() is None  # nothing loaded: Mission A is not imported again until the page is reloaded
    assert not [d for d in r.get("/datastreams").json["items"] if "__" in d["outputName"]]
    ws = r.ds("urn:x-barge:workspace:owner", "data-of-interest")
    assert r.obs(ws["id"]) == []  # no data of interest: the whole store is gone
    assert {v["status"] for v in catalogue(r).values()} == {"not-imported"}
    assert folder_hashes(path) == before  # AT-54: the folder is byte-identical
    cid = r.command(IMPORTER, "import", {"action": "import", "file": A_FILE}).json["id"]
    wait_status(r, IMPORTER, "import", cid)
    # AT-48 (server side): a record names the file and its hash, so re-importing gives the same dataset back.
    assert r.dataset("MISSION_A") == dataset_id(doi["dataset"]["file"], doi["dataset"]["sha256"]) == a
