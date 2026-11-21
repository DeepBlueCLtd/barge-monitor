# Version 4 interfaces (implementation contract)

The fixed points that the Python back end, the JavaScript stand-in and the front end
are built against. SRD Version 4 (`srd-barge.md`) is the requirement; this file is the
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
| models → server | I | create system / datastream / control stream, read, publish, command status, score |
| server → models | I | observations (columns), commands, acknowledgements |
| models → scilibs | I | a call (numpy, pandas, scipy, scikit-learn) |
| scilibs → models | I | its result |
| fastapi → server | I | parsed request |
| server → fastapi | I | response |
| client → fastapi | Q, K | HTTP request (K = POST to `/controlstreams/{id}/commands`) |
| fastapi → client | D, P, O, H | HTTP response (H = any status ≥ 400, and 503) |

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
  model?: string;     // for models ↔ server/scilibs: which model (data-cleanse, model-a, …)
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
| `model-a` | `urn:x-barge:process:model-a` | Model A | sosa:System | Process | models |
| `model-b` | `urn:x-barge:process:model-b` | Model B | sosa:System | Process | models |

`data-cleanse`, `model-a`, `model-b` (and any new model) are **created by the models
themselves** (FR-28) as subsystems of `models`. The server creates only `barge`, `bow`,
`stern` and `models`.

Datastreams (identifier `{system}-{outputName}-{hash6}`; the hash is of the published
field names, so a schema change gives a new id, FR-51):

| system | outputName | fields (after `time`) | resolution |
|---|---|---|---|
| bow, stern | `weather` | 7 quantities, each followed by `<name>_qc` (Category, QARTOD); `precipitation_type` (Category, extra) | raw, 1 s |
| data-cleanse | `cleaned-bow`, `cleaned-stern` | 7 quantities (cleaned; removed values are null), `precipitation_type` | 1 s, kept for 24 h |
| model-a | `summary-1min-bow`, `summary-1min-stern` | 7 quantity means, `readings_removed` (Count, extra), `precipitation_type` (most frequent, extra) | 1 min |
| model-a | `summary-1h-bow`, `summary-1h-stern` | as above | 1 h |
| model-a | `derived-1min`, `derived-1h` | `dew_point`, `bow_minus_stern` (air temperature, bow minus stern), `pressure_tendency_3h` (extra) | 1 min, 1 h |
| model-b | `changes` | `run_id`, `scale` (minutes/hours), `strength` | latest run only |
| model-b | `clusters` | `run_id`, `cluster` (Category c1…c8) | latest run only |
| model-b | `correlation` | `run_id`, `fields`, `matrix` | latest run only |
| model-b | `runs` | `run_id`, `command_id`, `algorithm`, `fields`, `period`, `window_start`, `window_end`, `records`, `clusters`, `score_changes`, `score_clusters`, `scored_against`, `illustrative` (Boolean) | one per run |

Field definitions are `https://deepbluecltd.github.io/barge-monitor/def/<name>`. A summary
mean or a cleaned value has **the same definition as the raw quantity** it comes from, so
a client groups fields into properties by definition.

Quantities and units: `air_temperature` Cel, `apparent_wind_speed` m/s,
`relative_humidity` %, `pressure` hPa, `apparent_wind_direction` deg (angular),
`solar_irradiance` W/m2, `water_temperature` Cel.

Control streams (one per model, created by the model): `data-cleanse` `settings`
(`spike_threshold` Quantity 1–10); `model-a` `settings` (`tendency_hours` Quantity 1–6);
`model-b` `clustering`:

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
system's datastreams, excluding `time`, QC flags, Text and Model B's run outputs
(`changes`, `clusters`, `correlation`, `runs`: they feed views, not chips). A property
named in the profile is solid; any other is dashed ("optional"). Sensor properties are
plotted from the **bow** sensor.

| period | sensor property reads | derived property reads |
|---|---|---|
| 1 min (default), 1 h | bow `weather` (raw: causes S) | `derived-1min` |
| 6 h, day | `summary-1min-bow` | `derived-1min` |
| week, 4 weeks | `summary-1h-bow` | `derived-1h` |

A property found only in a datastream not named in the profile is read from that
datastream for the period, at its native resolution. Live data: once per simulated
second, poll each datastream in use from the last time received.

Changing the selected fields, the period or the algorithm sends one K to Model B's
`clustering` control stream; the cluster view and the change marks follow the latest run.

## 7. Model interface (models ↔ data server, inside the back end)

Models never use HTTP or FastAPI. Each model runs in its own worker and calls the data
server's internal interface over a MessagePort (Python back end) or directly (CPython
tests, stand-in). Python API (`backend/models/csmodel.py`):

```python
class Api:  # every method is async
    async def create_system(self, body) -> str            # under "models"; returns id
    async def create_datastream(self, system_id, body) -> str   # body: name, outputName, schema (SWE DataRecord)
    async def create_controlstream(self, system_id, body) -> str
    async def find(self, system_uid, output_name) -> str | None # a datastream id
    async def read(self, ds_id, t0, t1, fields=None) -> dict    # {"t": ndarray, field: ndarray | list}
    async def publish(self, ds_id, cols, replace=False) -> int
    async def commands(self, cs_id) -> list[dict]          # pending commands
    async def command_status(self, cmd_id, status, message="") -> None
    async def score(self, kind, payload) -> dict           # the demonstrator's referee; models never see the manifest
    def now(self) -> float
    def tap(self, dst, summary, content) -> None           # models → scilibs and back

class Model:
    id = "model-c"; label = "Model C"; interval = 60.0   # simulated seconds between steps
    async def setup(self, api): ...
    async def step(self, api, t0, t1): ...               # process (t0, t1]
    async def on_command(self, api, cmd): ...            # optional
```

Wire format over the MessagePort: request `{id, model, op, args, quiet}`, reply
`{id, ok, result | error, status}`; numeric columns travel as `["f8", Uint8Array]`, string
columns as `["s", [..]]`. `status` is `waiting` (503) or `down` when the server cannot
answer; the model retries on its next step. `quiet` is true while a model catches up on
history at startup: those calls are counted, not drawn.

## 8. Workers and the page

| worker | runs | started by |
|---|---|---|
| `backend.worker.ts` | Pyodide: world, store, adapter, server, FastAPI | page, if WebAssembly |
| `model.worker.ts` ×3 (+ one per empty slot used) | Pyodide: one model each | page, Python mode |
| `standin.worker.ts` | TypeScript: world continuation, store adapter, server, core models | page, without WebAssembly or `?backend=standin` |
| `sw.js` | the relay (no logic) | page |

Page ↔ back-end worker (both back ends): page sends `start`, `connect` (port for the
relay), `model-connect {model}` (port for a model), `control {action, arg}`; worker
posts `progress {stage, detail, pct}`, `tick {messages, clock, server}` every 100 ms,
`state {…control state…}`, `relay-failed {chain, path, method}`.

Page ↔ model worker: page sends `start {pyodideUrl, pyZipUrl, model, code?}` with the
model port, and `clock {state}` on every tick; worker posts `tap {messages}`,
`progress {…}`, `status {model, phase, detail}`, `stdout`, `stderr`.

Control actions: `play`, `pause`, `rate` (0.25, 0.5, 1), `restart-server`, `down`, `up`,
`field {name, on}`, `profile-lie`, `capture`, `state`.

Control state (`state`): `{server: running|waiting|down, instance, progress, fields:
[{name, label, kind, inputs, extra, essential, type, on_next_start, published_next_start,
published_now}], pending, lie_about_profile, clock, store: {bytes, files, records},
models: [{id, label, phase, datastreams}], capture_counts, backend: python|standin}`.

URL parameters: `?backend=python|standin`, `?seed=N`, `?sketch=off`.
