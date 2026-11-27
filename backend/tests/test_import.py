"""The data folder and the CSV importer (SRD §6.1, §6.2; interfaces §5–§7): AT-01, AT-03, AT-04, AT-40 to
AT-43, AT-54, with the catalogue, the ``import`` control stream and Reset instance (FR-50a)."""
import gzip
import hashlib
import json
import time

import numpy as np
import pytest

from barge import config as C
from barge import dialect, qc
from barge.importer import dataset_id
from barge.server import parse_iso
from barge.truth import World
from tests import second_dialect
from tests.helpers import Rig

A_FILE = "MISSION_A_20310407.csv"
B_FILE = "MISSION_B_20310414.csv"
BX_FILE = "MISSION_B_20310414_REEXPORT.csv"
C_FILE = "MISSION_C_20310421.csv"
IMPORTER = "urn:x-barge:importer"
BOW, STERN = "urn:x-barge:sensor:bow", "urn:x-barge:sensor:stern"
SWE = {"f": "application/swe+json"}


def raw(folder, name):
    p = folder / (name + ".gz")
    return gzip.decompress(p.read_bytes()) if p.exists() else (folder / name).read_bytes()


def hashes(path):
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(path.iterdir())}


def ds(r, uid, output):
    """A datastream by its system's uniqueId and its output name (§6)."""
    _, body, _ = r.get(f"/systems/{r.systems()[uid]}/datastreams")
    return next(d for d in body["items"] if d["outputName"] == output)


def rows_of(r, d, params=None, user=None):
    return r.obs(d["id"], {"limit": "100000", **(params or {})}, user=user)


def catalogue(r):
    """The catalogue folded per file and hash: the latest observation of each is its status (§7)."""
    latest = {}
    for row in rows_of(r, ds(r, IMPORTER, "catalogue")):
        latest[(row["file"], row["sha256"])] = row
    return latest


def by_file(r, file):
    return [v for k, v in catalogue(r).items() if k[0] == file]


def cells(text_lines, head, i, col):
    return text_lines[4 + i].split(";")[head.index(col)]


@pytest.fixture(scope="module")
def bare(data_folder):
    """The back end alone (no models), over the data folder: Mission A imported silently at startup."""
    return Rig(models=False, folder=data_folder)


def test_dialect_units_and_missing_values():
    """FR-17: tenths of a degree, knots, a decimal comma, -9999, //// and VRB; a missing column is absent."""
    text = ("#LOGGER=X\r\n#EXPORT=Y\r\n#MISSION=Test\r\n"
            "T_HS94;BOW_AT[dC];BOW_AWS[kn];BOW_PR[hPa];BOW_AWD[deg]\r\n"
            "3351808000;173;10,0;1019,2;VRB\r\n3351808002;-9999;-9999;1019,3;////\r\n")
    p = dialect.parse(text.encode())
    assert p.t.tolist() == [3351808000 // 2 + dialect.LOGGER_EPOCH_UNIX, 3351808002 // 2 + dialect.LOGGER_EPOCH_UNIX]
    assert p.values[("bow", "air_temperature")][0] == pytest.approx(17.3)
    assert np.isnan(p.values[("bow", "air_temperature")][1])
    assert p.values[("bow", "apparent_wind_speed")][0] == pytest.approx(5.14444)
    assert p.values[("bow", "pressure")].tolist() == [1019.2, 1019.3]
    assert p.variable[("bow", "apparent_wind_direction")].tolist() == [True, False]
    assert ("stern", "air_temperature") not in p.values and p.mission == "Test"
    flags = qc.flags("apparent_wind_direction", p.values[("bow", "apparent_wind_direction")],
                     p.variable[("bow", "apparent_wind_direction")])
    assert flags.tolist() == ["2", "9"]  # variable: not evaluated; missing: 9


def test_co2_qc_range_and_spike():
    """Interfaces §5, D-144: CO₂ QC on import, range 250–5000 ppm and a 60 ppm spike test."""
    v = np.array([420.0, 421.0, 500.0, 422.0, 423.0, 470.0, 424.0, np.nan])
    assert qc.flags("co2", v).tolist() == ["1", "1", "3", "1", "1", "1", "1", "9"]  # 47 ppm off is not a spike
    assert qc.flags("co2", np.array([6000.0, 6001.0, 240.0, 245.0])).tolist() == ["4", "4", "4", "4"]


def test_at01_observations_match_the_file_and_the_manifest(bare, data_folder):
    """AT-01: what the server serves is the file's rows in declared units, and the manifest's truth at each time."""
    a = bare.dataset("MISSION_A")
    d = ds(bare, BOW, f"weather__{a}")
    rows = rows_of(bare, d, {"phenomenonTime": "2031-04-07T06:00:00Z/2031-04-07T07:59:59Z"})
    assert len(rows) == 7200
    lines = raw(data_folder, A_FILE).decode().split("\r\n")
    head = lines[3].split(";")
    for k in (0, 1234, 7199):
        i = 6 * 3600 + k
        assert rows[k]["time"] == f"2031-04-07T{6 + k // 3600:02d}:{k // 60 % 60:02d}:{k % 60:02d}Z"
        at = cells(lines, head, i, "BOW_AT[dC]")
        assert rows[k]["air_temperature"] == ("NaN" if at == "-9999" else pytest.approx(int(at) / 10))
        kn = cells(lines, head, i, "BOW_AWS[kn]")
        assert rows[k]["apparent_wind_speed"] == ("NaN" if kn == "-9999" else
                                                   pytest.approx(float(kn.replace(",", ".")) * 0.514444, abs=0.006))
        pr = cells(lines, head, i, "BOW_PR[hPa]")
        assert rows[k]["pressure"] == ("NaN" if pr == "-9999" else pytest.approx(float(pr.replace(",", "."))))
    manifest = json.loads(gzip.decompress((data_folder / "manifest.json.gz").read_bytes()))
    w = World(manifest["world"])
    t = np.array([parse_iso(x["time"]) for x in rows])
    truth = w.sensor_truth(t, "bow")
    sigma = manifest["world"]["noise"]["sigma"]
    for p in ("air_temperature", "relative_humidity", "pressure", "water_temperature"):
        v = np.array([np.nan if x[p] == "NaN" else x[p] for x in rows], dtype=float)
        good = np.array([x[f"{p}_qc"] == "1" for x in rows])
        assert good.mean() > 0.9, p
        q = 0.5 if p == "relative_humidity" else 0.06
        assert np.nanmax(np.abs(v[good] - truth[p][good])) <= 6 * sigma[p] + q, p


def test_co2_is_never_in_the_weather_record_and_is_restricted(bare):
    """FR-21c, FR-93: CO₂ goes to the analysers' datastreams, in [ppm] with its QC flag; the friend gets 403."""
    a = bare.dataset("MISSION_A")
    w = ds(bare, BOW, f"weather__{a}")
    c = ds(bare, BOW + ":co2", f"co2__{a}")
    assert "co2" not in json.dumps(bare.get(f"/datastreams/{w['id']}/schema")[1])
    sch = bare.get(f"/datastreams/{c['id']}/schema", {"obsFormat": "application/swe+json"})[1]["recordSchema"]
    assert [f["name"] for f in sch["fields"]] == ["time", "co2", "co2_qc"] and sch["fields"][1]["uom"]["code"] == "[ppm]"
    rows = bare.obs(c["id"], {"limit": "5"})
    assert set(rows[0]) == {"time", "co2", "co2_qc"} and 300 < rows[0]["co2"] < 2000
    for path in (f"/datastreams/{c['id']}", f"/datastreams/{c['id']}/schema", f"/datastreams/{c['id']}/observations"):
        assert bare.get(path, user="friend")[0] == 403, path
        assert bare.get(path, user="analyst")[0] == 200, path
    assert bare.get(f"/datastreams/{w['id']}/observations", user="friend")[0] == 200
    # The catalogue names files and spans only, never their columns (FR-21c), and every user reads it.
    cat = ds(bare, IMPORTER, "catalogue")
    assert "co2" not in json.dumps(rows_of(bare, cat, user="friend"))


def test_mission_a_is_imported_silently_at_startup_and_fast(bare):
    """FR-15: Mission A imported before the server answers, counted but not drawn; one I per 1,000 rows."""
    rate = bare.rt.importer.rate
    assert rate["file"] == A_FILE and rate["silent"] and rate["rows"] == 86400
    assert rate["rows_per_s"] > 50_000  # interfaces §7: 24 hours in well under 4 s
    assert not [m for m in bare.rt.tap.buffer if "importer" in (m["src"], m["dst"])]
    counts = bare.rt.tap.counts
    assert counts.get("importer>server:I", 0) >= 87 and counts.get("importer>folder:S", 0) >= 2
    st = bare.rt.control_state()
    assert st["import_rate"]["rows_per_s"] == rate["rows_per_s"]
    assert {f["file"]: f["status"] for f in st["folder"]} == {
        A_FILE: "imported", B_FILE: "not-imported", BX_FILE: "not-imported", C_FILE: "not-imported"}


def test_at04_the_last_hour_of_a_dataset_meets_its_budget(bare):
    """AT-04 on a dataset (FR-31): the last hour before a replay time, both sensors, within the declared budget.
    The one-field summary query comes with the summaries on import (plan Phase 6)."""
    a = bare.dataset("MISSION_A")
    hour = {"phenomenonTime": "2031-04-07T11:00:00Z/2031-04-07T12:00:00Z", "limit": "4000", **SWE}
    t0 = time.perf_counter()
    got = [bare.get(f"/datastreams/{ds(bare, u, f'weather__{a}')['id']}/observations", hour)[1] for u in (BOW, STERN)]
    assert (time.perf_counter() - t0) * 1000 < C.QUERY_BUDGET_MS["last-hour-each-sensor"]
    assert [len(g) for g in got] == [3601, 3601]


def test_at03_a_second_dialect_changes_the_importer_only(data_folder, tmp_path):
    """AT-03: the same recording in a second dialect; only the importer's parser differs; every response the same."""
    one, two = tmp_path / "one", tmp_path / "two"
    one.mkdir()
    two.mkdir()
    (one / (A_FILE + ".gz")).write_bytes((data_folder / (A_FILE + ".gz")).read_bytes())
    (two / A_FILE).write_bytes(second_dialect.write(raw(data_folder, A_FILE)))
    assert (two / A_FILE).read_bytes().startswith(b"time,bow.air_temperature (C)")
    first = Rig(models=False, folder=one)
    second = Rig(models=False, folder=two, parser=second_dialect.parse)
    da, db = first.dataset("MISSION_A"), second.dataset("MISSION_A")
    assert da != db  # the id carries the file's own hash (§6)
    for uid, out in ((BOW, "weather"), (STERN, "weather"), (STERN + ":co2", "co2")):
        a, b = ds(first, uid, f"{out}__{da}"), ds(second, uid, f"{out}__{db}")
        assert a["id"] == b["id"]  # the same opaque identifiers, made in the same order
        for params in ({"limit": "3000"}, {"resultTime": "latest"}, {"phenomenonTime": "2031-04-07T12:00:00Z/..", "limit": "500"},
                       {"phenomenonTime": "2031-04-07T05:00:00Z/2031-04-07T05:10:00Z"}):
            ra = first.get(f"/datastreams/{a['id']}/observations", {**SWE, **params})
            rb = second.get(f"/datastreams/{b['id']}/observations", {**SWE, **params})
            assert ra[0] == rb[0] == 200 and ra[1] == rb[1], (uid, params)
        sa = first.get(f"/datastreams/{a['id']}/schema", {"obsFormat": "application/swe+json"})[1]
        sb = second.get(f"/datastreams/{b['id']}/schema", {"obsFormat": "application/swe+json"})[1]
        assert sa == sb
    norm = lambda r, d: sorted(x["outputName"].replace(d, "{ds}") for x in r.get("/datastreams")[1]["items"])  # noqa: E731
    assert norm(first, da) == norm(second, db)
    ia, ib = first.rt.importer.datasets[da], second.rt.importer.datasets[db]
    assert (ia["start"], ia["end"], ia["records"]) == (ib["start"], ib["end"], ib["records"])


def test_at40_the_catalogue_lists_every_file_and_a_new_one_after_rescan(folder_copy):
    path = folder_copy
    r = Rig(models=False, folder=path)
    index = json.loads((path / "index.json").read_text())["files"]
    cat = catalogue(r)
    for f in index:
        row = cat[(f["file"], f["sha256"])]
        assert (row["size"], row["modified"]) == (f["size"], f["modified"])
        assert row["status"] == ("imported" if f["file"] == A_FILE else "not-imported")
        if row["status"] == "not-imported":  # a Count has no missing value in OpenSensorHub: 0 until imported (D-197)
            assert row["records"] == 0 and row["dataset"] == "" and row["start"] is None, row
    a = cat[(A_FILE, index[0]["sha256"])]
    assert a["dataset"] == dataset_id(A_FILE, index[0]["sha256"]) and a["records"] == 86400
    assert (a["start"], a["end"]) == ("2031-04-07T00:00:00Z", "2031-04-07T23:59:59Z")
    (path / "MISSION_D_20310428.csv.gz").write_bytes((path / (C_FILE + ".gz")).read_bytes())
    assert not by_file(r, "MISSION_D_20310428.csv")
    st = r.wait(r.command(IMPORTER, "import", {"action": "rescan", "file": ""}).json()["id"])
    assert [s["statusCode"] for s in st] == ["ACCEPTED", "COMPLETED"]
    d = by_file(r, "MISSION_D_20310428.csv")
    assert d and d[0]["status"] == "not-imported"


def test_at41_import_shows_progress_and_mission_c_opens_degraded(data_folder):
    """AT-41: import over HTTP as a user: REJECTED, or ACCEPTED, EXECUTING every 10 %, COMPLETED; the folder
    never changes. Mission C has no stern wind speed column, so its stern record has no such field (FR-21)."""
    r = Rig(models=False, folder=data_folder)
    before = hashes(data_folder)
    st = r.wait(r.command(IMPORTER, "import", {"action": "import", "file": "NO_SUCH.csv"}).json()["id"])
    assert st[-1]["statusCode"] == "REJECTED" and "NO_SUCH.csv" in st[-1]["message"]
    st = r.wait(r.command(IMPORTER, "import", {"action": "fetch", "file": C_FILE}).json()["id"])
    assert st[-1]["statusCode"] == "REJECTED"
    resp = r.command(IMPORTER, "import", {"action": "import", "file": C_FILE}, user="friend")
    assert resp.status_code == 200 and resp.json()["sender"] == "friend"  # every user may command the importer
    st = r.wait(resp.json()["id"])
    codes = [s["statusCode"] for s in st]
    assert codes == ["ACCEPTED"] + ["EXECUTING"] * 10 + ["COMPLETED"]
    assert [s["message"] for s in st if s["statusCode"] == "EXECUTING"] == [f"{p}%" for p in range(10, 101, 10)]
    c = r.dataset("MISSION_C")
    row = by_file(r, C_FILE)[0]
    assert row["status"] == "imported" and row["dataset"] == c and row["records"] == 43200
    pct = [x["pct"] for x in rows_of(r, ds(r, IMPORTER, "catalogue")) if x["file"] == C_FILE and x["status"] == "importing"]
    assert pct == list(range(0, 100, 10))
    bow = ds(r, BOW, f"weather__{c}")
    stern = ds(r, STERN, f"weather__{c}")
    names = lambda d: [f["name"] for f in r.get(f"/datastreams/{d['id']}/schema", {"obsFormat": "application/swe+json"})[1]["recordSchema"]["fields"]]  # noqa: E731
    assert "apparent_wind_speed" in names(bow)
    assert "apparent_wind_speed" not in names(stern) and "apparent_wind_speed_qc" not in names(stern)
    assert len(names(stern)) == len(names(bow)) - 2
    assert rows_of(r, stern, {"limit": "1"})[0]["time"] == "2031-04-21T00:00:00Z"
    assert hashes(data_folder) == before  # FR-17a: nothing in the folder changes
    # The rows/s of the last import, for the importer's panel (FR-110).
    assert r.rt.control_state()["import_rate"]["file"] == C_FILE


def test_at42_overlapping_files_are_kept_apart(data_folder):
    r = Rig(models=False, folder=data_folder)
    for f in (B_FILE, BX_FILE):
        assert r.wait(r.command(IMPORTER, "import", {"action": "import", "file": f}).json()["id"])[-1]["statusCode"] == "COMPLETED"
    b, bx = r.dataset(B_FILE), r.dataset(BX_FILE)
    db, dbx = ds(r, BOW, f"weather__{b}"), ds(r, BOW, f"weather__{bx}")
    assert db["id"] != dbx["id"] and b != bx
    span = {"phenomenonTime": "2031-04-14T06:00:00Z/2031-04-14T23:59:59Z"}
    rb, rbx = rows_of(r, db, span), rows_of(r, dbx, span)
    assert [x["time"] for x in rb] == [x["time"] for x in rbx] and len(rb) == 18 * 3600
    differ = [i for i, (x, y) in enumerate(zip(rb, rbx)) if x != y]
    assert 0 < len(differ) < 0.01 * len(rb)
    lines = raw(data_folder, B_FILE).decode().split("\r\n")
    head = lines[3].split(";")
    for i in differ[:20]:  # B's datastream holds B's readings, never the re-export's
        at = cells(lines, head, 6 * 3600 + i, "BOW_AT[dC]")
        assert rb[i]["air_temperature"] == ("NaN" if at == "-9999" else pytest.approx(int(at) / 10))
    whole = rows_of(r, dbx)
    assert whole[0]["time"] == "2031-04-14T06:00:00Z" and len(whole) == 86400
    assert rows_of(r, db)[0]["time"] == "2031-04-14T00:00:00Z"


def test_at43_a_changed_file_is_a_new_dataset_and_the_old_one_is_superseded(folder_copy):
    path = folder_copy
    r = Rig(models=False, folder=path)
    assert r.wait(r.command(IMPORTER, "import", {"action": "import", "file": C_FILE}).json()["id"])[-1]["statusCode"] == "COMPLETED"
    old = r.dataset(C_FILE)
    lines = raw(path, C_FILE).decode().split("\r\n")
    row = lines[4].split(";")
    row[1] = str(int(row[1]) + 5)  # one reading re-calibrated
    lines[4] = ";".join(row)
    (path / (C_FILE + ".gz")).unlink()
    (path / C_FILE).write_bytes("\r\n".join(lines).encode())
    r.wait(r.command(IMPORTER, "import", {"action": "rescan", "file": ""}).json()["id"])
    changed = [v for v in by_file(r, C_FILE) if v["status"] == "changed"]
    assert changed and changed[0]["dataset"] == old  # names the dataset it differs from
    assert r.wait(r.command(IMPORTER, "import", {"action": "import", "file": C_FILE}).json()["id"])[-1]["statusCode"] == "COMPLETED"
    new = r.dataset(C_FILE)
    assert new != old and r.rt.importer.datasets[old]["superseded"]
    statuses = {v["dataset"]: v["status"] for v in by_file(r, C_FILE)}
    assert statuses[old] == "superseded" and statuses[new] == "imported"
    # The superseded dataset stays, and still opens; the new one has the changed reading.
    o, n = ds(r, BOW, f"weather__{old}"), ds(r, BOW, f"weather__{new}")
    first_o, first_n = rows_of(r, o, {"limit": "2"}), rows_of(r, n, {"limit": "2"})
    assert first_n[0]["air_temperature"] == pytest.approx(first_o[0]["air_temperature"] + 0.5)
    assert first_n[1] == first_o[1]
    cur = {f["file"]: f for f in r.rt.control_state()["folder"]}[C_FILE]
    assert cur["status"] == "imported" and cur["dataset"] == new
    assert [d["superseded"] for d in r.rt.control_state()["datasets"] if d["file"] == C_FILE] == [True, False]


def test_at54_reset_instance_empties_the_store_and_leaves_the_folder(folder_copy):
    """AT-54, FR-50a: the whole store goes; the folder is byte-identical; Mission A is not imported again until
    the page is reloaded; identifiers a client held are not found; models register again."""
    path = folder_copy
    r = Rig(folder=path)
    before = hashes(path)
    a = r.dataset("MISSION_A")
    old = ds(r, BOW, f"weather__{a}")["id"]
    ws = r.systems()["urn:x-barge:workspace:owner"]
    assert r.request("POST", f"/systems/{ws}/datastreams", json={"name": "doi", "outputName": "data-of-interest", "schema": {
        "obsFormat": "application/swe+json", "recordSchema": {"type": "DataRecord", "label": "x", "fields": [
            {"type": "Time", "name": "time", "label": "t", "uom": {"href": "http://www.opengis.net/def/uom/ISO-8601/0/Gregorian"}},
            {"type": "Text", "name": "record", "label": "r"}]}}}).status_code == 201
    r.rt.reset_instance()
    r.ready()
    assert r.rt.running and not r.rt.importer.datasets
    names = [d["outputName"] for d in r.get("/datastreams", {"limit": "1000"})[1]["items"]]
    assert not [n for n in names if "__" in n] and "data-of-interest" not in names
    assert r.get(f"/datastreams/{old}")[0] == 404
    assert {v["status"] for v in catalogue(r).values()} == {"not-imported"}
    assert {v["records"] for v in catalogue(r).values()} == {0}
    assert hashes(path) == before  # AT-54: the folder is byte-identical
    # The models register again (their identifiers have gone) and the system tree is the configured one.
    sy = r.systems()
    assert "urn:x-barge:process:data-cleanse" in sy and "urn:x-barge:importer" in sy
    # Imported again on request, the same file gives the same dataset id (its name and hash, §6).
    assert r.wait(r.command(IMPORTER, "import", {"action": "import", "file": A_FILE}).json()["id"])[-1]["statusCode"] == "COMPLETED"
    assert r.dataset("MISSION_A") == a
    assert ds(r, BOW, f"weather__{a}")["id"] != old
