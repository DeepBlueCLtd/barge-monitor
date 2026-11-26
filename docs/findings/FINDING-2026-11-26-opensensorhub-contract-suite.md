# Finding: the contract suite against a stock OpenSensorHub (AT-32, ADR 0005)

**Date:** 2026-11-26 · **Server:** OpenSensorHub `osh-core` 2.0.4, built from source at commit
`75bb094`, unmodified; configured with the delivered demo accounts, HTTP Basic authentication,
and two Connected Systems endpoints on one store (`/api`, access control on; `/api-internal`,
access control off, for command receivers) · **Where:** one cloud VM, everything on the same host
· **How:** `backend/independent/at32_osh.py` (with `osh_server.py` and `osh_gateway.py`); the
record of the run is `backend/independent/at32-osh-results.json`. About one minute for both runs.

## Summary

**AT-32 is not passed: 1 of the 12 `need` checks passes** against OpenSensorHub behind the
access gateway, with the suite (`backend/contract_suite/suite.py`) unchanged. Almost every
failure has one cause: the suite, the models and the gateway find systems with
`GET /collections/all_systems/items` (D-162), and OpenSensorHub answers **400** ("Invalid
resource name: 'items'"). The one check that passes, `the_profile_is_beside_the_server`, is
answered by the gateway.

Four **client-side** changes (D-193 to D-196) clear every `need` check: applied as an experiment
in the gateway's upstream layer (`--proposed`), **all 12 pass**, and 6 of the 7 `standin` checks.
None of the four bends what the suite asserts; each makes our clients send or read what
OpenSensorHub serves. They are proposals for the contract's owner, not adopted: until they are,
AT-32 stays failed.

What runs, and what is ours:

| Piece | What it is | Written for this system? |
|---|---|---|
| OpenSensorHub 2.0.4 | Unmodified; JSON configuration only (`osh_server.config`) | No |
| Access gateway | `barge.gateway.Gateway`, unchanged in what it decides; its discovery is overridden for OpenSensorHub (D-192), and it bridges push subscriptions (D-190) and serves the profile (D-191) | Yes (D-150) |
| Installation | The platform, sensors, CO₂ analysers, Models, and each user's workspace created by that user | Configuration |
| CSV importer, replay controller | Clients of OpenSensorHub under `svc-importer` and `svc-replay`, receivers on `/api-internal` | Yes; the importer writes over HTTP here, not as the Java module of S-IMPORT |
| Data cleanse, Summaries, Analysis | The models of `backend/models/`, unchanged, through the gateway | Yes |

## Results

| Check (`need`) | As specified | With D-193 to D-196 | Why it failed |
|---|---|---|---|
| landing_and_conformance | **fail** | pass | The landing page answers `Content-Type: auto` (D-196). The conformance classes are claimed |
| credentials_are_needed_everywhere | **fail** | pass | Discovery (D-193). 401 everywhere is the gateway's and OpenSensorHub's alike |
| the_platform_is_found_by_unique_id | **fail** | pass | Discovery (D-193) |
| the_profile_is_beside_the_server | pass | pass | Served by the gateway (D-191) |
| every_essential_of_the_loaded_dataset_is_found | **fail** | pass | Discovery (D-193); the models could not register (D-193, D-194, D-195), so Summaries' datastreams were missing; the schema answers `Content-Type: auto` (D-196) |
| a_sensor_record_has_quality_flags | **fail** | pass | Discovery (D-193); schema content type (D-196). The `quality` reference form round-trips unchanged |
| observations_by_time_latest_and_offset | **fail** | pass | Discovery (D-193). `phenomenonTime` open intervals, `resultTime=latest` and `offset` behave as specified |
| creating_again_answers_the_same_location | **fail** | pass | Discovery (D-193); a SensorML body sent as `application/json` is read as GeoJSON and refused (D-194) |
| one_observation_with_a_missing_value | **fail** | pass | Discovery (D-193). `"NaN"` in a Quantity round-trips |
| commands_are_pushed_to_a_subscriber | **fail** | pass | Discovery (D-193). Push works through the gateway's bridge (D-190): the command arrives in about 20 ms with `sender` |
| the_friend_finds_no_co2 | **fail** | pass | Discovery (D-193). Hiding is the gateway's (D-150), as designed |
| workspaces_are_private | **fail** | pass | Discovery (D-193). Hiding is the gateway's (D-150) |

`standin` checks (information only; with the proposed changes): refusals are HTML, and the gateway
strips `WWW-Authenticate` (pass); one observation per `POST` and `null` refused (pass); `Accept`
ignored, `f` chooses (pass); no instance identifier (pass); a command without a subscriber is
answered 202 and not listed (pass, but after **29.5 s**, not 5 s: D-199); only services subscribe
(pass, by the gateway). **`PUT` on a system answers 400, not 405** (fail; D-200; the check stops
there, so `DELETE` was not tried).

## Divergences found

Each was observed against the running server; the run record holds the suite's side, the probes
behind the rest are described here.

1. **No `/collections/all_systems/items`** (D-193). `/collections` lists `all_systems`, whose
   `items` link is `systems`; `/collections/all_systems/items` is 400. Every system, subsystems
   included, is listed by `GET /systems?searchMembers=true`, in either encoding
   (`f=application/sml+json` gives `uniqueId`). Listings carry **no parent link**; a single
   system in GeoJSON does (`rel=parent`), and `/systems?parent={id}` and
   `/systems/{id}/subsystems` list children (D-192).
2. **SensorML must be sent as `application/sml+json`** (D-194). With `application/json` the body
   is read as GeoJSON: 400 "The type of a GeoJSON feature must be 'Feature'". The Python
   `csmodel.Api.create_system` and the suite's `_model_resources` send `application/json`; the
   TypeScript `csmodel.ts` already sends `application/sml+json`. Both stand-ins accept either,
   so the browser never showed it.
3. **`ppm` is not a UCUM code** (D-195): a datastream with `uom.code` `ppm` is refused (400
   "Invalid UCUM code 'ppm'"). UCUM's code is `[ppm]`, which is accepted (also seen in S-IMPORT).
   It affects the CO₂ datastreams (importer) and every model output carrying CO₂ (Data cleanse's
   restricted subsystem failed to register, which held up Summaries).
4. **`Content-Type: auto`** (D-196) on the landing page, `/conformance` and
   `/datastreams/{id}/schema` when no `f` is given; the bodies are JSON. With `f=json` the
   header is `application/json`. Listings and observations are labelled correctly.
5. **A Count has no missing value** (D-197). `"NaN"` and `null` are both refused in a Count
   (400 "Expected an int"), so the catalogue's `records` cannot be written before a file is
   imported. A Time accepts `null` (returned as `null`). Every field must be present.
6. **One observation per phenomenon time** (D-198). A second observation in a datastream with the
   same `time` **replaces** the first (four `POST`s at one time left one observation, the last).
   The replay `log` is keyed by the replay time a command took effect, so two commands applied
   at the same replay time (a `load` and a `pause`, say) keep only the second.
7. **Command status after the sender's wait** (D-199). With a subscriber, the sender's `POST`
   answers 200 after 5 s with `PENDING`, and OpenSensorHub **stores that `PENDING` report after**
   the receiver's `COMPLETED` (by `reportTime`). A client reading the latest report from
   `/controlstreams/{id}/status` (D-164) would see `PENDING` last. Without a subscriber the
   answer is 202 after **29.5 s** (the contract says 5 s).
8. **`PUT` on a system answers 400** (with an empty body), not 405 (D-200). `DELETE` was not
   tried on a resource that exists; the conformance claims `create-replace-delete`.
9. **Bulk observations over HTTP are unusable** (D-201). OpenSensorHub accepts several rows in
   one `POST` as `application/swe+csv` (201, one id per row) but stores **every row with the last
   row's time and values**. A SWE JSON array is refused (400). An importer outside the server
   is therefore one observation per `POST`: about 700 a second with 8 requests in flight here.

Confirmed as specified: 401 with `WWW-Authenticate: basic` without credentials (the gateway
strips it, D-153); 201 with the existing `Location` when creating a system or datastream again;
the `quality` reference form; `"NaN"` in a Quantity; open time intervals, `resultTime=latest`,
paging by `offset`; command push with `sender` (the user id) and parameters (numbers come back
as floats: `3` is pushed as `3.0`); status posted as `{"command@id", "statusCode"}`.

## Consequences

- **AT-32 needs the four client changes (D-193 to D-196) in the contract, both stand-ins and the
  clients** before it can pass. None is a server change; each is "send and read what OpenSensorHub
  serves", which PR-06 already makes the rule. The stand-ins should then refuse what
  OpenSensorHub refuses (SensorML as `application/json`, `ppm`), or the browser will hide the
  next such slip as it hid D-194.
- **The gateway grows by three jobs in front of a real server** (D-190 to D-192): a WebSocket
  bridge for receivers, the profile file, and its own discovery of the system tree (one request
  per system per refresh). It still decides nothing that D-150 did not already give it.
- **D-197, D-198 and D-199 change data, not discovery**: the catalogue's empty Count, the replay
  log's key, and reading the latest command status. They do not show in the suite today, but the
  display client and the replay log would meet them.
- The **importer over HTTP** (§15's fallback) is about 700 observations a second at best; a whole
  24-hour Mission A (four datastreams, about 345,600 observations) would take about 8 minutes.
  The Java module of S-IMPORT remains the way in.

## Limits of this run

- The importer imports the **first 900 rows** of Mission A over HTTP (`--rows`, 0 for all); the
  replay controller is a small client written for this run that loads Mission A, publishes its
  state and waits for the models, and is paused throughout, so no model processed a window.
  Neither is the Python stand-in's code, which writes into its store in process.
- The display client was not run against OpenSensorHub; `Content-Type: auto` does not trouble
  `fetch().json()`, but nothing else about the browser was tried, nor WebSocket credentials from
  a browser (the gateway's bridge sidesteps them).
- OpenSensorHub's own role permissions are left wide (read, list, stream, create) and only the
  gateway restricts (D-150); OpenSensorHub's port must not be reachable except through the
  gateway, which this run does not enforce (everything is on localhost).
- The `--proposed` run applies D-193 to D-196 by rewriting requests and headers in the gateway's
  upstream layer, to emulate the client changes. That rewriting is not proposed as gateway code.
- One version, one machine, one store; no restart was tried in this run (the 2026-11-23 spike did).
