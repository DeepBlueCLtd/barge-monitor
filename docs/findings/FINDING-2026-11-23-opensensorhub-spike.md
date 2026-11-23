# Finding: a stock OpenSensorHub as the data server (AT-32, ADR 0005)

**Date:** 2026-11-23 · **Server:** OpenSensorHub `osh-core` 2.0.4, built from source at
commit `75bb094`, its Connected Systems service with resource creation switched on and
access control off; nothing else changed · **Where:** one development machine, client and
server on the same host · **How:** `backend/spike/osh_spike.py`; the record of the run is
`backend/spike/results.json`.

## Summary

OpenSensorHub does the **sensing and reading half** of what this system needs, as shipped:
systems, subsystems, datastreams with our SWE Common schemas, observations in and out,
the time filters the display client polls with, and persistence across a restart. Every
essential source of the declared profile was found by standard discovery.

It does **not** do three things the Version 4.1 design relies on, and each needs a design
change, not a setting:

1. **Commands.** A model cannot poll for commands. OpenSensorHub pushes each command to a
   receiver listening on the control stream, and without one the command is dropped.
2. **Restart and waiting mode.** There is no instance identifier and no 503 while starting.
3. **Replacing a result.** There is no way to replace a datastream's observations.

The **contract suite cannot serve as AT-32 as it stands**: it passed 0 of 15 tests, mostly
because it addresses resources by the stand-in's own identifiers and expects the
stand-in's JSON, not because OpenSensorHub lacks the behaviour.

**Not tried:** the store adapter as an OpenSensorHub module (the spike loaded data over
HTTP instead), the display client itself against OpenSensorHub, authentication, and
loading a full history.

## What was done

The demonstrator's own server (the stand-in of FR-38a) was run in process as the
reference. Its 7 systems, 14 datastreams with their schemas, 120 observations of the bow
record and up to 20 of every other datastream, and the clustering control stream were
replayed into an empty OpenSensorHub through the Connected Systems interface. Each answer
was recorded beside the reference's: 63 checks, of which 32 matched. The count overstates
the gap: several checks are measurements or fallbacks with no "same" answer.

## 1. The seven behaviours ADR 0005 asked about

| Behaviour | 4.1 stand-in | Stock OpenSensorHub | Consequence |
|---|---|---|---|
| Profile link on the landing page (FR-41) | `rel=profile` | **Absent.** The landing page's links are fixed | Take the fallback: publish the profile beside the server at a fixed relative path |
| Instance identifier (FR-47, FR-48) | `ETag` and `x-server-instance` | **None**, before or after a restart | A restart cannot be recognised from a header. See §3 |
| 503 with `Retry-After` while starting (FR-47) | Yes | **No.** Connections are refused until it is ready (about 1 s here), then 200 | Take the fallback: starting is the same as unreachable (FR-49) |
| 409 with `Location` on creating what exists (FR-28) | 409 | **201 with the same `Location`**, for systems and datastreams | Better than asked: a restarted model re-creates and gets its resources back. The model must accept 201 |
| Plain `PUT` to replace observations (FR-28a) | 200 | **405** | Take the fallback: one observation per run. But see §4: the array that fallback needs was refused too |
| `quality` as `{"href": "#…_qc"}` (FR-25, D-31) | Yes | **Accepted and returned unchanged** | No change |
| The store adapter as a module, and its language | n/a | **Not tried** | Still open; a spike of its own |

## 2. Works as needed

- **Discovery:** landing page, conformance, `/collections`, `/systems`, subsystems,
  `/datastreams`, schemas at `/datastreams/{id}/schema?obsFormat=application/swe+json`.
- **Creating resources over HTTP:** a system (as SensorML JSON), subsystems, all 14
  datastreams with their schemas, a control stream with its parameter schema.
- **Schemas** keep every field, type and unit; the bounds of a control stream are returned
  in its schema.
- **A model is a process system** (`assetType` Process); no system carries a location.
- **Observations** published one per request are returned with identical values.
- **Filters:** a `phenomenonTime` interval, an open interval (`t/..`, as the client polls),
  and `resultTime=latest`.
- **Persistence:** systems, datastreams and observations were all there after a restart,
  with the same identifiers.
- **The declared profile:** all of its essentials were found, with their types and units,
  by listing systems, subsystems and datastreams.

## 3. Missing: needs a design change

**Commands (FR-27, FR-55).**
- With nothing listening, `POST …/commands` waited, answered **202** ("accepted but request
  timed out") and the command was **not kept**: listing commands returned none, so a model
  polling `statusCode=PENDING` never sees it.
- With a receiver on the control stream's WebSocket (`ws://…/controlstreams/{id}/commands`),
  each command was **pushed** to it at once, then kept and listed.
- The sender's `POST` then took **5 seconds** and answered 200 with status PENDING, even
  when the receiver had already reported COMPLETED. FR-79 wants a click answered at once.
- **Bounds are not enforced:** algorithm `Z`, outside the schema's allowed tokens, was
  accepted. The 400 naming the bound (FR-27) would have to come from the model.
- A command must carry **every** parameter of the schema; one carrying only the changed
  settings was refused (400).
- Status is reported at `/controlstreams/{id}/status` with a `command@id`, not at
  `/commands/{id}/status` (400). The report was stored, but the command's `currentStatus`
  still read PENDING and the `statusCode=COMPLETED` filter returned nothing.

So the polling placeholder of FR-27 does not work here at all. Models would hold a
WebSocket (or MQTT) subscription, which is the push delivery §16 excludes. This is the
largest single change the adoption forces.

**Restart (FR-47, FR-48).** No header changes across a restart, so the client cannot
recognise one. But the reason for recognising it is weaker than in 4.1: what models
created persisted, with the same identifiers, so a client's discovered configuration stays
valid. A restart could simply be a period of unreachability.

**Replacing a result (FR-28a).** `PUT` and `DELETE` on a datastream's observations answer
405, although the server claims the create-replace-delete classes. Latest-run results
need another shape.

**OpenAPI definition (FR-23, AT-06).** The server does not serve one; its landing page
links to the OGC's published definitions. "The served OpenAPI matches the master" has
nothing to compare against.

## 4. Differs: workable, with changes on our side

| What | Stock OpenSensorHub | Change |
|---|---|---|
| Identifiers | Opaque, assigned by the server (`040g`). The stand-in's are readable (`models`, `bow`) | Models post to `/systems/models/subsystems`: they must find Models by its unique id first. The display client already follows discovery |
| Default system encoding | GeoJSON: `uid` and `name` under `properties`. SensorML JSON on `f=application/sml+json` | The display client already reads both forms |
| Observations by `Accept` header | The header is ignored; `application/json` observation resources come back | Ask with `f=application/swe+json`. The display client asks by header today; it also reads the JSON form |
| Paging SWE JSON | No `next` link (the JSON form has one) | Page by `offset`, or read the JSON form |
| Several observations in one request | Refused (400): one observation per request | Models publish one at a time. Measured 427 to 496 a second on one machine: about six minutes for 24 hours of two 1 Hz sensors, before any model output |
| A missing value | JSON `null` refused in a Quantity; the string `"NaN"` accepted and returned as `"NaN"` | Models and the display client encode and read missing values as `"NaN"`. 28 of 40 sampled cleaned records were refused for this |
| An array in a record | Refused: "implicit size not supported by JSON parser" (the correlation matrix) | Give the array a declared size, or another shape. This also blocks the one-observation-per-run fallback until solved |
| Refusals | HTML error pages; 400 for an unknown resource name | The client must not expect a JSON body naming what was refused |
| An oversize `limit` | Not refused: everything was returned | Nothing relies on the refusal |
| Constraint and record name | `"type": "AllowedTokens"` dropped; the record is renamed to the output name | Compare schemas by fields, not whole documents |
| Conformance class identifiers | 4 of the stand-in's 16 are not claimed (`api-common` of Parts 1 and 2, `landing-page`, and Common Part 2 `collections` under a different version) | The client's check should name only the classes it needs |
| `Content-Type` | The landing page and single resources answer `Content-Type: auto` | A defect to report upstream; tolerate it meanwhile |

## 5. The contract suite

Run unchanged, 0 of 15 tests passed. The causes, by test:

- **Addressed by the stand-in's identifiers** (`systems/bow`, `systems/models`,
  `systems/analysis`): 8 tests. They never reached the behaviour they test.
- **Validated against the stand-in's JSON** (landing page, conformance, system schema): 3.
- **Behaviour genuinely absent** (profile, OpenAPI, refusals by name): 4.

To be AT-32, the suite must find resources by unique id and output name, as the display
client does, and separate "what we need of any server" from "what the stand-in also does".

## 6. What this means for ADR 0005

- The adoption **stands for sensing, discovery and reading**. Nothing found there needs
  more than small changes to the models' library and the display client.
- It is **not yet shown for commands**, which need a different delivery, and so a revised
  FR-27 and a decision on push delivery.
- The **store adapter as a module is untested** and is now the main unknown: the spike's
  one-observation-per-request loading is too slow to stand in for it at scale.
- The stand-in should be changed to **behave as OpenSensorHub does** where they differ, or
  the demonstrator will keep showing a server that does not exist.

## 7. Limits of this spike

- One version, one machine, default settings apart from the three named above.
- The display client was not run against OpenSensorHub; §2's profile result comes from a
  re-implementation of its discovery in the spike script.
- No authentication, no load beyond a few hundred observations, no WebSocket or MQTT for
  observations, no admin interface.
- Where a behaviour looked like a defect (`Content-Type: auto`, `currentStatus` not
  following a status report) it was recorded as observed, not investigated.
