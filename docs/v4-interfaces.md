# Version 4.1 interfaces (implementation contract)

The fixed points that the Python back end, the JavaScript stand-in and the front end
are built against. SRD Version 4.1 (`srd-barge.md`) is the requirement; this file is the
design that meets it. Where they disagree, the SRD wins and this file is wrong.

## 1. Component identifiers

Every captured message names its sender and receiver with one of these ids (SRD §3):

| id | Component | Zone |
|---|---|---|
| `platform` | Collection platform | World |
| `store` | Logger store | Legacy |
| `adapter` | Store adapter | New build · back end |
| `server` | Data server | New build · back end |
| `models` | Models | New build · back end ★ |
| `fastapi` | FastAPI | Third-party libraries |
| `scilibs` | Scientific libraries | Third-party libraries |
| `client` | Display client | New build · front end ★ |

The relay is not a component: HTTP messages are captured as `client → fastapi` and
`fastapi → client` (FR-03).

## 2. Flows and letters (SRD §3.1, §5)

| src → dst | Letters | What |
|---|---|---|
| platform → store | L | one fixed-width record per sensor per second |
| server → adapter | S | store query: sensors, fields, period, source |
| adapter → store | S | file read found through the index: file, offset, length |
| store → adapter | L | the records read (first three shown) |
| adapter → server | I | columns |
| models → fastapi | Q, O, I | HTTP request: create a system, datastream or control stream, read (Q); publish observations (O); ask the referee (I) |
| fastapi → models | D, O, H, I | HTTP response |
| models → scilibs | I | a call (numpy, pandas, scipy, scikit-learn) |
| scilibs → models | I | its result |
| fastapi → server | I | parsed request |
| server → fastapi | I | response |
| client → fastapi | Q, K | HTTP request (K = POST to `/controlstreams/{id}/commands`) |
| fastapi → client | D, P, O, H | HTTP response (H = any status ≥ 400, and 503) |

A request says who makes it only for the capture: a model sends `x-tap-model: <id>`, and
`x-tap-quiet: 1` while it works through history at startup (counted, not drawn). Nothing
is decided by either header.

## 3. Captured message

```ts
interface Captured {
  id: number | string;
  t: number;          // simulated seconds since the simulation epoch
  src: ComponentId; dst: ComponentId;
  letter: 'Q'|'D'|'O'|'K'|'P'|'H'|'S'|'L'|'I';
  summary: string;    // one line
  content: string;    // the message, at most 4000 characters, monospace
  failed?: boolean;   // a request that got no answer (server down)
  chain?: string|null;// messages caused by one HTTP request or one model call share a chain
  hop?: number;       // order within the chain
  model?: string;     // for models ↔ fastapi/scilibs, and the hops their requests cause: which model (data-cleanse, summaries, …)
}
```

The display client sends `x-tap-chain: <chain>` on every request, so the S messages a
selection causes can be found by chain (FR-70).

## 4. Connected Systems resources

Systems (`/systems`, top level; subsystems under `/systems/{id}/subsystems`):

| id | uniqueId | label | systemType | assetType | parent |
|---|---|---|---|---|---|
| `barge` | `urn:x-barge:platform:barge` | Collection platform | sosa:Platform | Equipment | |
| `bow` | `urn:x-barge:sensor:bow` | Bow sensor | sosa:Sensor | Equipment | barge |
| `stern` | `urn:x-barge:sensor:stern` | Stern sensor | sosa:Sensor | Equipment | barge |
| `models` | `urn:x-barge:process:models` | Models | sosa:System | Process | |
| `data-cleanse` | `urn:x-barge:process:data-cleanse` | Data cleanse | sosa:System | Process | models |
| `summaries` | `urn:x-barge:process:summaries` | Summaries | sosa:System | Process | models |
| `analysis` | `urn:x-barge:process:analysis` | Analysis | sosa:System | Process | models |

`data-cleanse`, `summaries`, `analysis` (and any new model) are **created by the models
themselves** (FR-28) as subsystems of `models`, with `POST /systems/models/subsystems`.
The server creates only `barge`, `bow`, `stern` and `models`.

Datastreams (identifier `{system}-{outputName}-{hash6}`; the hash is of the published
field names, so a schema change gives a new id, FR-51):

| system | outputName | fields (after `time`) | resolution |
|---|---|---|---|
| bow, stern | `weather` | 7 quantities, each followed by `<name>_qc` (Category, QARTOD); `precipitation_type` (Category, extra) | raw, 1 s |
| data-cleanse | `cleaned-bow`, `cleaned-stern` | 7 quantities (cleaned; removed values are null), `precipitation_type` | 1 s |
| summaries | `summary-1min-bow`, `summary-1min-stern` | 7 quantity means, `readings_removed` (Count, extra), `precipitation_type` (most frequent, extra) | 1 min |
| summaries | `summary-1h-bow`, `summary-1h-stern` | as above | 1 h |
| summaries | `derived-1min`, `derived-1h` | `dew_point`, `bow_minus_stern` (air temperature, bow minus stern), `pressure_tendency_3h` (extra) | 1 min, 1 h |
| analysis | `changes` | `run_id`, `scale` (minutes/hours), `strength` | latest run only |
| analysis | `clusters` | `run_id`, `cluster` (Category c1…c8) | latest run only |
| analysis | `correlation` | `run_id`, `fields`, `matrix` | latest run only |
| analysis | `runs` | `run_id`, `command_id`, `algorithm`, `fields`, `period`, `window_start`, `window_end`, `records`, `clusters`, `score_changes`, `score_clusters`, `scored_against`, `illustrative` (Boolean) | one per run |

Field definitions are `https://deepbluecltd.github.io/barge-monitor/def/<name>`. A summary
mean or a cleaned value has **the same definition as the raw quantity** it comes from, so
a client groups fields into properties by definition.

Quantities and units: `air_temperature` Cel, `apparent_wind_speed` m/s,
`relative_humidity` %, `pressure` hPa, `apparent_wind_direction` deg (angular),
`solar_irradiance` W/m2, `water_temperature` Cel.

Control streams (one per model, created by the model): `data-cleanse` `settings`
(`spike_threshold` Quantity 1–10); `summaries` `settings` (`tendency_hours` Quantity 1–6);
`analysis` `clustering`:

| field | type | bounds |
|---|---|---|
| `algorithm` | Category | A, B, C |
| `fields` | Text | comma-separated property names; each must be a published property |
| `period` | Category | PT1M, PT1H, PT6H, P1D, P7D, P28D |
| `clusters` | Count | 2–8 (default 4) |
| `sensitivity` | Quantity | 1–10 (default 5) |

A command outside the bounds is refused with HTTP 400 and `refused` naming the field
(FR-27). A valid command returns 201 with `currentStatus: PENDING`; the model moves it
to ACCEPTED and COMPLETED (or FAILED) and publishes a new run.

Commands are POSTed to `/controlstreams/{id}/commands` with body
`{"parameters": {...}}`. `GET /commands/{id}` gives `currentStatus`.

Observations: `GET /datastreams/{id}/observations?phenomenonTime=a/b&limit=n&offset=k`
or `resultTime=latest`; `application/swe+json` (an array of records keyed by field name,
`time` first, `Link: rel="next"` when paged, `x-total-count`). Over `MAX_LIMIT`
(100 000) is refused naming `limit`.

Creating and publishing (how a model registers, FR-28):

| request | body | answer |
|---|---|---|
| `POST /systems/models/subsystems` | `{uniqueId, label, description}` | 201 and `Location: /systems/{id}`; 409 with the same `Location` if that `uniqueId` exists |
| `POST /systems/{id}/datastreams` | `{name, outputName, schema: {obsFormat: "application/swe+json", recordSchema}}` | 201 and `Location: /datastreams/{dsId}`; 409 with its `Location` if that output exists with the same fields; a different schema makes a new datastream |
| `POST /systems/{id}/controlstreams` | `{name, inputName, schema: {commandFormat: "application/json", parametersSchema}}` | 201 or 409, as above |
| `POST /datastreams/{dsId}/observations` | one record or an array, `application/swe+json` | 201 `{created}`; an unknown field or a missing `time` is refused by name |
| `PUT /datastreams/{dsId}/observations` | as POST | 200 `{created}`: these in place of all before. **Plain HTTP, not Connected Systems** |
| `GET /controlstreams/{csId}/commands?statusCode=PENDING` | | the commands a model has yet to take up |
| `POST /commands/{cmdId}/status` | `{statusCode, message?}` | 201; `statusCode` is ACCEPTED, EXECUTING, COMPLETED, FAILED or REJECTED |
| `POST /demonstrator/referee/{changes\|clusters}` | what to score | scores against the manifest. **Scaffolding**, not part of the system |

Only the Models system takes subsystems, and only a system a model created takes
datastreams and control streams. A sensor's datastream takes no observations. Everything
else that would create, replace, update or delete is refused with 405 naming the method;
the Create/Replace/Delete conformance classes are not claimed. A datastream with every
output switched off is not served, but still takes its model's observations (AT-12).

Every response carries `x-server-instance`; the landing page also sends it as `ETag`.
Waiting mode: 503 with `Retry-After`. Server down: no answer (network failure).

## 5. Declared profile (v4)

`contracts/profile.json`, id `https://deepbluecltd.github.io/barge-monitor/profile/v4`.
Each essential names `system` (uniqueId), `datastream` (outputName), `field`, `type`,
`uom`, `resolution` (`raw`, `PT1M`, `PT1H` or `run`) and `views`. Essentials: bow and
stern `weather` air temperature and apparent wind speed (raw); `summary-1min-bow` and
`summary-1h-bow` air temperature and apparent wind speed; `derived-1min` and `derived-1h`
dew point and bow-minus-stern; `changes.strength`; `clusters.cluster`;
`runs.score_clusters`. Views: `graphs`, `changes`, `clusters`.

The client takes **the resolution of every datastream named in the profile from the
profile**. A datastream the profile does not name (a new model's) is read at its
native resolution.

## 6. The display client's reading plan (FR-29, FR-53, FR-54)

Chips are properties (grouped by definition) of the bow sensor and of every other
system's datastreams, excluding `time`, QC flags, Text and Analysis's run outputs
(`changes`, `clusters`, `correlation`, `runs`: they feed views, not chips). A property
named in the profile is solid; any other is dashed ("optional"). Sensor properties are
plotted from the **bow** sensor.

Periods offered: 1 min (default), 1 h, 6 h, day, week, 4 weeks. With 24 hours of history
pre-loaded (FR-15), week and 4 weeks show only what there is.

| period | sensor property reads | derived property reads |
|---|---|---|
| 1 min (default), 1 h | bow `weather` (raw: causes S) | `derived-1min` |
| 6 h, day | `summary-1min-bow` | `derived-1min` |
| week, 4 weeks | `summary-1h-bow` | `derived-1h` |

A property found only in a datastream not named in the profile is read from that
datastream for the period, at its native resolution. Live data: once per simulated
second, poll each datastream in use from the last time received.

Changing the selected fields, the period or the algorithm sends one K to Analysis's
`clustering` control stream; the cluster view and the change marks follow the latest run.

## 7. What a model is written against

A model reaches the data server only by HTTP, through FastAPI, as the display client does
(§4). In the browser each model runs in its own worker and makes its requests with `fetch`,
carried by the relay. In CPython (tests, an ordinary ASGI server) and in the stand-in the
models share a process with the server and make the same requests of the same application.

A model is written against a small library, `backend/models/csmodel.py`, which makes those
requests:

```python
class Api:  # every method is async; each is one or more HTTP requests
    async def create_system(self, body) -> str             # POST /systems/models/subsystems; returns the system id
    async def create_datastream(self, system_id, body) -> str    # body: name, outputName, schema (SWE DataRecord); returns a key
    async def create_controlstream(self, system_id, body) -> str
    async def find(self, system_uid, output_name) -> str | None  # another system's datastream, as a key
    async def read(self, key, t0, t1, fields=None) -> dict       # GET observations: {"t": ndarray, field: ndarray}
    async def publish(self, key, cols, replace=False) -> int     # POST (or PUT) observations
    async def commands(self, key) -> list[dict]              # GET commands?statusCode=PENDING
    async def command_status(self, cmd_id, status, message="") -> None
    async def score(self, kind, payload) -> dict             # the demonstrator's referee; models never see the manifest
    def now(self) -> float
    def tap(self, dst, summary, content) -> None             # models → scilibs and back (capture only)

class Model:
    id = "new-model-1"; label = "New model 1"; interval = 60.0   # simulated seconds between steps
    async def setup(self, api): ...
    async def step(self, api, t0, t1): ...               # process (t0, t1]
    async def on_command(self, api, cmd): ...            # optional
```

A **key** is `system:outputName`. It outlives server restarts; the public identifier behind
it (which changes with the schema or the offering) is looked up again when the server
answers 404 or a new instance answers. A 503 or no answer means try again at the next step.

A model looks for commands on its control stream on the simulation clock: Analysis every
simulated second, the others at each step. While the clock stands still the shell lets a
viewer's click through: it tells each model worker how many commands are pending
(`pending_commands` in the back end's tick), and a model with one waiting looks at once.

## 8. Workers and the page

| worker | runs | started by |
|---|---|---|
| `backend.worker.ts` | Pyodide: world, store, adapter, server, FastAPI | page, if WebAssembly |
| `model.worker.ts` ×3 (+ one per empty slot used) | Pyodide: one model each; its requests go through the relay | page, Python mode |
| `standin.worker.ts` | TypeScript: world continuation, store adapter, server, core models | page, without WebAssembly or `?backend=standin` |
| `sw.js` | the relay (no logic) | page |

Page ↔ back-end worker (both back ends): page sends `start`, `connect` (port for the
relay), `model-connect {model}` (a port on which a model says which phase it is in, for
the shell only), `control {action, arg}`; worker posts `progress {stage, detail, pct}`,
`tick {messages, clock, server, pending_commands}` every 100 ms, `state {…control state…}`,
`relay-failed {chain, path, method, model}`.

Page ↔ model worker: page sends `start {pyodideUrl, pyZipUrl, model, apiUrl, code?}` and
`clock {state, pending}` on every tick; worker posts `tap {messages}` (models ↔ scientific
libraries), `progress {…}`, `status {model, phase, detail}`, `stdout`, `stderr`.

Control actions: `play`, `pause`, `rate` (0.25, 0.5, 1), `restart-server`, `down`, `up`,
`field {name, on}`, `profile-lie`, `capture`, `state`.

Control state (`state`): `{server: running|waiting|down, instance, progress, fields:
[{name, label, kind, inputs, extra, essential, type, on_next_start, published_next_start,
published_now}], pending, lie_about_profile, clock, store: {bytes, files, records},
models: [{id, label, phase, datastreams}], capture_counts, backend: python|standin}`.

URL parameters: `?backend=python|standin`, `?seed=N`, `?sketch=off`. Without `backend`,
the page starts the stand-in (FR-06b). `PYTHON_BY_DEFAULT` in `web/src/shell/runtime.ts`
makes Python the default wherever WebAssembly runs.

## 9. Drawing the traffic (the demonstrator shell)

* Each datastream the display client uses is polled as often as it can change: raw records
  every simulated second (FR-63), 1-minute means every minute, hourly means every hour,
  Analysis's runs every minute (every second while a command's run is awaited).
* A selection change (fields, period, algorithm) is answered at once, playing or paused.
  The chains of requests it causes are marked; their icons wear a **gold ring** ("caused by
  your click" in the key) and set off at once, ahead of any queue on their lines.
* Other icons queue per line and direction; a line that falls more than 6 simulated
  seconds behind is relieved rather than left to lag further.

## 10. The shell's own panels

* **Overview** (the detail panel's opening state, FR-69a): `web/src/detail/Overview.tsx`
  holds the three lists (adopted, written, not here).
* **Failure demos** (FR-79a..c): `web/src/shell/demos.ts` holds each scenario as control
  actions and the words of its banner. Put everything back sets every field to its default
  (on unless it is an extra), clears the misconfigured-server switch and starts the server.
