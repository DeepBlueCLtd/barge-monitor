"""The contract test suite for the HTTP seam (AT-02).

Written against a minimal async client so that the *same* tests run:

* in CPython, against the application under an ordinary ASGI server
  (``backend/tests/test_contract_uvicorn.py``), and
* in the browser, from the analyst's workspace worker, through the Service
  Worker to the application in Pyodide (the display's "Contract tests" panel,
  checked by the end-to-end test).

A client provides ``async get(path, params=None)`` and
``async put(path, json_body)``, each returning ``(status, json_body)``.
Paths are relative to the API base URL.
"""
from __future__ import annotations

import json
import traceback

import jsonschema

TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


class Skip(Exception):
    pass


class Ctx:
    def __init__(self, client, openapi):
        self.c = client
        self.openapi = openapi
        self._route = None

    def validate(self, instance, schema_name):
        schema = {"$ref": f"#/components/schemas/{schema_name}", "components": self.openapi["components"]}
        jsonschema.Draft202012Validator(schema).validate(instance)

    async def route(self):
        if self._route is None:
            st, canal = await self.c.get("sim/canal")
            assert st == 200
            cl = canal["centreline"]
            self._route = "LINESTRING(" + ",".join(f"{x} {y}" for x, y in zip(cl["lon"], cl["lat"])) + ")"
            self.canal = canal
        return self._route


def refused(st, body, status, name):
    assert st == status, f"expected {status}, got {st}: {body}"
    assert body.get("refused") == name, f"refusal should name {name!r}: {body}"


@test
async def landing_page_links(ctx):
    st, body = await ctx.c.get("")
    assert st == 200
    ctx.validate(body, "Landing")
    rels = {lk["rel"] for lk in body["links"]}
    assert {"self", "service-desc", "conformance", "data"} <= rels


@test
async def conformance_matches_code(ctx):
    st, body = await ctx.c.get("conformance")
    assert st == 200
    ctx.validate(body, "Conformance")
    claims = set(body["conformsTo"])
    # The code supports JSON and CoverageJSON; it does not claim HTML, GeoJSON or OpenAPI 3.0.
    assert any(c.endswith("/conf/covjson") for c in claims)
    assert not any(c.endswith(("/conf/html", "/conf/geojson", "/conf/edr-geojson", "/conf/oas30")) for c in claims)


@test
async def collections_validate(ctx):
    st, body = await ctx.c.get("collections")
    assert st == 200
    ctx.validate(body, "Collections")
    ids = {c["id"] for c in body["collections"]}
    assert {"bow", "stern", "analysis-derived"} <= ids


@test
async def collection_states_its_limits(ctx):
    st, body = await ctx.c.get("collections/bow")
    assert st == 200
    ctx.validate(body, "Collection")
    assert set(body["data_queries"]) == {"trajectory", "corridor"}
    assert body["barge:limits"]["max_response_points"] > 0


@test
async def trajectory_returns_coverage(ctx):
    route = await ctx.route()
    st, body = await ctx.c.get("collections/bow/trajectory", {"coords": route, "datetime": await _recent(ctx, 600)})
    assert st == 200, body
    ctx.validate(body, "Coverage")
    assert body["domain"]["domainType"] == "Trajectory"
    n = len(body["domain"]["axes"]["composite"]["values"])
    assert n > 0
    for name, r in body["ranges"].items():
        assert r["shape"] == [n], name
    assert "air_temperature_qc" in body["ranges"]


@test
async def corridor_returns_coverage(ctx):
    await ctx.route()
    cl = ctx.canal["centreline"]
    coords = "LINESTRING(" + ",".join(f"{x} {y}" for x, y in zip(cl["lon"][2:5], cl["lat"][2:5])) + ")"
    st, body = await ctx.c.get("collections/stern/corridor",
                               {"coords": coords, "corridor-width": "60", "width-units": "m",
                                "parameter-name": "air_temperature,pressure"})
    assert st == 200, body
    ctx.validate(body, "Coverage")
    assert set(body["parameters"]) == {"air_temperature", "air_temperature_qc", "pressure", "pressure_qc", "position_qc"}


@test
async def refuses_unsupported_geometry(ctx):
    st, body = await ctx.c.get("collections/bow/trajectory", {"coords": "POINT(1 2)"})
    ctx.validate(body, "Exception")
    refused(st, body, 400, "coords:POINT")


@test
async def refuses_unsupported_options(ctx):
    route = await ctx.route()
    for name in ("z", "bbox", "resolution-x"):
        st, body = await ctx.c.get("collections/bow/trajectory", {"coords": route, name: "1"})
        refused(st, body, 400, name)
    st, body = await ctx.c.get("collections/bow/trajectory", {"coords": route, "f": "GeoJSON"})
    refused(st, body, 400, "f")
    st, body = await ctx.c.get("collections/bow/trajectory", {"coords": route, "crs": "EPSG:27700"})
    refused(st, body, 400, "crs")
    st, body = await ctx.c.get("collections/bow/corridor",
                               {"coords": route, "corridor-width": "10", "corridor-height": "5"})
    refused(st, body, 400, "corridor-height")


@test
async def refuses_unknown_names(ctx):
    route = await ctx.route()
    st, body = await ctx.c.get("collections/bow/trajectory", {"coords": route, "colour": "red"})
    refused(st, body, 400, "colour")
    st, body = await ctx.c.get("collections/bow/trajectory", {"coords": route, "parameter-name": "rainfall"})
    refused(st, body, 400, "parameter-name:rainfall")
    st, body = await ctx.c.get("collections/nowhere")
    refused(st, body, 404, "collection:nowhere")
    st, body = await ctx.c.get("collections/bow/area", {"coords": route})
    refused(st, body, 400, "query:area")


@test
async def analysis_refuses_out_of_bounds(ctx):
    route = await ctx.route()
    st, coll = await ctx.c.get("collections/analysis-clusters")
    bounds = coll["barge:analysis_parameters"]["properties"]
    too_many = bounds["clusters"]["maximum"] + 1
    st, body = await ctx.c.get("collections/analysis-clusters/trajectory", {"coords": route, "clusters": str(too_many)})
    refused(st, body, 400, "clusters")
    assert str(bounds["clusters"]["maximum"]) in body["description"]


@test
async def analysis_carries_parameters_range_and_scores(ctx):
    route = await ctx.route()
    st, body = await ctx.c.get("collections/analysis-derived/trajectory", {"coords": route, "window-hours": "1"})
    assert st == 200, body
    ctx.validate(body, "Coverage")
    meta = body["barge:analysis"]
    assert meta["parameters"]["window_hours"] == 1.0
    assert meta["data_range"]["records"] > 0
    assert "true_wind" in meta["scores"] and "lag_correction" in meta["scores"]


@test
async def correlation_is_a_coverage(ctx):
    route = await ctx.route()
    st, body = await ctx.c.get("collections/analysis-correlation/trajectory", {"coords": route, "window-hours": "1"})
    assert st == 200, body
    ctx.validate(body, "Coverage")
    n = len(body["domain"]["axes"]["row"]["values"])
    assert body["ranges"]["correlation"]["shape"] == [n, n]


@test
async def clock_states_and_refuses(ctx):
    st, clock = await ctx.c.get("sim/clock")
    assert st == 200
    ctx.validate(clock, "ClockState")
    st, body = await ctx.c.put("sim/clock", {"rate": 7})
    refused(st, body, 400, "rate")
    st, body = await ctx.c.put("sim/clock", {"rate": clock["rate"]})
    assert st == 200


@test
async def too_large_is_refused_with_the_limit(ctx):
    route = await ctx.route()
    st, coll = await ctx.c.get("collections/bow")
    limit = coll["barge:limits"]["max_response_points"]
    st, clock = await ctx.c.get("sim/clock")
    if clock["records"]["bow"] <= limit:
        raise Skip(f"the store holds {clock['records']['bow']} records, under the limit of {limit}")
    st, body = await ctx.c.get("collections/bow/trajectory", {"coords": route})
    refused(st, body, 413, "size")
    assert body["limit"] == limit and body["matched"] > limit


async def _recent(ctx, seconds):
    """An interval covering the last `seconds` of simulated time."""
    import datetime as dt

    st, clock = await ctx.c.get("sim/clock")
    now = dt.datetime.fromisoformat(clock["now"].replace("Z", "+00:00"))
    start = now - dt.timedelta(seconds=seconds)
    return start.strftime("%Y-%m-%dT%H:%M:%SZ") + "/.."


async def run(client, openapi=None, only=None) -> list[dict]:
    """Run every test; never raises. Returns one result per test."""
    if openapi is None:
        st, openapi = await client.get("api")
    ctx = Ctx(client, openapi)
    results = []
    for fn in TESTS:
        if only and fn.__name__ not in only:
            continue
        try:
            await fn(ctx)
            results.append({"test": fn.__name__, "outcome": "passed"})
        except Skip as s:
            results.append({"test": fn.__name__, "outcome": "skipped", "detail": str(s)})
        except Exception as e:  # noqa: BLE001 - every failure is reported, none is fatal
            results.append({"test": fn.__name__, "outcome": "failed", "detail": f"{type(e).__name__}: {e}",
                            "trace": traceback.format_exc(limit=3)})
    return results


def summary(results) -> str:
    return json.dumps({k: sum(1 for r in results if r["outcome"] == k) for k in ("passed", "failed", "skipped")})
