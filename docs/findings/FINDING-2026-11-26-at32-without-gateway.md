# Finding: the contract suite against a stock OpenSensorHub, without the gateway (AT-32, 4.7)

**Date:** 2026-11-26 · **Server:** OpenSensorHub `osh-core` 2.0.4, built from source at commit `75bb094`,
unmodified · **Where:** one cloud container, everything on the same host · **How:**
`backend/independent/at32_osh.py` with `osh_server.py`; the record is `backend/independent/at32-osh-results.json`.
Plan-v4.7 Phase 10; decisions D-344 to D-348. It follows the finding of the same date made through the access
gateway, now withdrawn (ADR 0010).

> **Update, 2026-11-27 (D-351).** The owner decided that a stream's title may be known, not its contents.
> The configuration was reworked accordingly (`osh_server.py`): every role reads every description (systems,
> datastreams with their schemas, control streams); a role without CO₂ reads contents (observations, commands,
> status) by an allow-list of open resources, with every contents form **denied** for each restricted resource and
> each system above it; and OpenSensorHub starts with its own `useSecureIds` option, which gives each kind of
> resource ids of its own, so they no longer share strings. Run again (`at32-osh-results.json`): **13 of 14 `need`
> checks pass.** As the friend: all 12 restricted datastreams described, **none of their observations read**; all 17
> open datastreams' observations read. `restricted_resources_are_listed_and_refused` passes (the suite now asks
> for the description to be readable and the observations refused). The one failure left is
> `credentials_are_needed_everywhere`: the profile, a static document, is served without credentials (D-345).
> Without `useSecureIds` the denies still kept every restricted observation closed, but 7 of the 17 open datastreams
> (the bow's and stern's weather among them) were refused to the friend, their ids being also denied systems'.
> The rest of this finding describes the run of 2026-11-26.

## Summary

**AT-32 is not passed: 12 of the 14 `need` checks pass** with the suite unchanged and nothing of ours between the
clients and OpenSensorHub. The two failures are differences of OpenSensorHub, not of our clients:

1. **The allow-list leaks CO₂** (`restricted_resources_are_listed_and_refused`). Restriction by role is an
   allow-list by OpenSensorHub id (D-222), and OpenSensorHub matches a datastream's schema and observations by a
   "parent" form that it also tries against every ancestor *system*. System and datastream ids are separate spaces
   that share strings (ten of the ids granted to the friend were also ids of systems above a restricted resource), so granting an open datastream granted the
   system with the same id and everything under it. Logged in as the friend (weather only), **every one of the 12
   restricted datastreams** (the CO₂ readings, Data cleanse's and Summaries' restricted outputs, Analysis's
   restricted results) was readable: resource, schema and observations.
2. **The profile is served without credentials** (`credentials_are_needed_everywhere`). OpenSensorHub serves no
   file under its API; the only file it serves is a static document, and static documents need no credentials.

## What runs

| Piece | What it is | Ours? |
|---|---|---|
| OpenSensorHub 2.0.4 | Unmodified; JSON configuration only (`osh_server.config`): the delivered accounts in a `BasicSecurityRealm`, one role per role, HTTP Basic, `/api` (access control on) and `/api-internal` (off, for receivers, D-223) on one store, the profile as a static document | No |
| Installation | Platform, sensors, CO₂ analysers and Models made by the owner; each workspace made by its user (who then owns it) | Configuration |
| Allow-list | Written from what the server holds once the importer and the models have made their resources; the server restarted to read it (about 1 s; the receivers were back 1.3 s later) | Configuration |
| CSV importer | A client under `svc-importer` (D-201): the first 900 rows of Mission A, one observation per `POST`, about 800 a second; its receiver on `/api-internal` | Yes, a stand-in for the Java module |
| Data cleanse, Summaries, Analysis | `backend/models/`, unchanged but for D-346, straight to OpenSensorHub, their receivers on its WebSocket; each processed Mission A on import | Yes |
| Referee | The demonstrator's scaffolding (FR-37), answered beside OpenSensorHub by the harness (D-347) | Scaffolding |

## Results

| Check (`need`) | Result | Note |
|---|---|---|
| landing_and_conformance | pass | |
| credentials_are_needed_everywhere | **fail** | `profile.json` without credentials: 200 (D-345). Every API path: 401 |
| every_system_is_found_by_unique_id | pass | `GET /systems?searchMembers=true` (D-193) |
| the_profile_is_beside_the_server | pass | At `/sensorhub/profile.json`, beside `/sensorhub/api/`; the run's client reads it there |
| every_fixed_essential_is_found | pass | Every essential, the models' outputs on Mission A included |
| the_importer_offers_its_catalogue_and_import | pass | |
| a_sensor_record_has_quality_flags | pass | |
| observations_by_time_latest_and_offset | pass | |
| creating_again_answers_the_same_location | pass | |
| one_observation_with_a_missing_value | pass | |
| commands_are_pushed_to_a_subscriber | pass | On `/api-internal`'s WebSocket, with `sender`; outcome by D-199 |
| restricted_resources_are_listed_and_refused | **fail** | The suite's CO₂ datastream, made after the allow-list was written, read by the friend (200) |
| workspaces_are_private | pass | The friend is refused the owner's workspace system (403) |
| creating_only_under_ones_own_systems | pass | With the owner's role reduced to reading and commanding (it may not create under a model's system or another's workspace, or append to a model's datastream) |

`standin` checks, for information: 5 of 8. `PUT` is refused with 403, not 405 (a 4xx is all clients rely on);
the 401 challenge names a realm (`basic realm="OpenSensorHub: Authentication Required"`); the internal endpoint
takes any authenticated account (§14 already says so).

## The leak

OpenSensorHub's `ConSysApiSecurity.hasPermission` grants a request if the user holds the permission itself or the
same permission in the form `…[parent=<id>]` for any ancestor. For a datastream's schema the request is
`get/datastreams[parent=<datastream id>]`, and the ancestors it tries are those of the *system* whose id is that
string; for observations, `list/obs[parent=<datastream id>]` and then `[parent=<system id>]` for each system above
the datastream. To let the friend read an open datastream's schema and observations, the allow-list must hold
`get/datastreams[parent=D]` and `list/obs[parent=D]` for each open datastream `D`, and these are the same strings
as a grant on a system whose id is `D`. Ten of the ids the friend was granted by were systems on the chain of a
restricted resource (the platform, the sensors, Models, Data cleanse, …), so their restricted descendants opened.

Tried without those two forms: nothing leaked but one schema (the friend's own workspace had the id of a restricted
datastream, and its owner's rights reach it the same way), and the friend could no longer read any open schema or
observation, so the display client would show the friend nothing (FR-118 leaves out what answers 403).

No allow-list written by id is both useful and safe on OpenSensorHub 2.0.4. The generator reports the collisions it
can see (`osh_server.allow_list`), but whether a collision exists depends on the identifiers the server happens to
allocate. C6, even in 4.7's relaxed form, does not hold on a stock server.

## Other differences found and handled

- **A SWE JSON record's members in the schema's order** (D-346): OpenSensorHub refused all of Data cleanse's
  blocks ("Expected field 'air_temperature' but was 'removed'"). Both `csmodel`s now send the schema's order; the
  stand-ins accept any, which hid it.
- **The referee** (D-347): Analysis scores each run at `/demonstrator/referee`, which is not the data server's; the
  harness answers it.
- **The allow-list is read only at a restart** of the security module. Every import and every model registering
  needs one; while it restarts, OpenSensorHub's source says access control is off (not tested).

## Limits of this run

- 900 rows of Mission A (15 minutes), so each model's processing was short (about 2 s for all three).
- One version, one machine, one run; Basic authentication over plain HTTP on localhost.
- The display client was not run against OpenSensorHub.
- The restart window was not probed.

## Consequences

For the OpenSensorHub team, beside interfaces §14: restriction that holds (hiding, or permissions matched by
resource type), the profile with credentials beside the API, and `DELETE` refused. Until restriction holds, a
developed system cannot rely on stock OpenSensorHub for C6.
