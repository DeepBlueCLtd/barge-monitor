# Version 4.6 interfaces (implementation contract)

These are the fixed points that the Python back end, the JavaScript stand-in, the models
and the front end are built against. SRD Version 4.6 (`srd-barge.md`) is the requirement;
this file is the design that meets it. Where the two disagree, the SRD wins and this file
is wrong. `docs/plan-v4.6.md` gives the order of work.

Names in `code` are normative. Both back ends implement every section that says "the
server", except where a section says otherwise.

## 1. Component identifiers

Every captured message names its sender and receiver with one of these ids (SRD §3):

| id | Component | Zone | Value-add |
|---|---|---|---|
| `folder` | Data folder | Legacy | |
| `importer` | CSV importer | New build · back end | |
| `replay` | Replay controller | New build · back end | |
| `server` | Data server (OpenSensorHub; a stand-in here) | Third-party libraries | |
| `models` | Models | New build · back end | ★ |
| `scilibs` | Scientific libraries | Third-party libraries | |
| `client` | Display client | New build · front end | ★ |
| `gateway` | Access gateway (§9.5) | New build · back end | |

In the adoption opening only (§12), eight more ids stand in for `server`:

`sub-webapi`, `sub-registry`, `sub-obsstore`, `sub-query`, `sub-commands`,
`sub-accounts`, `sub-permissions`, `sub-admin`.

No message is ever captured with these eight ids.

The relay is not a component, and nothing is captured to or from it (FR-03). The referee
is scaffolding: its traffic is captured as `models ↔ server` with the letter `I`.

## 2. Flows and letters (SRD §3.1, §5)

| src → dst | Letters | What |
|---|---|---|
| importer → folder | S | `list` (the folder) or `read <file>` |
| folder → importer | L | the listing (name, size, modified), or the first three CSV rows and a row count |
| importer → server | I | `bulk write`, one message per 1,000 rows (FR-67), with `rows written n/N`; and each catalogue observation |
| server → importer | K | a pushed `import` command |
| client → server | Q, K | an HTTP request (K is a `POST` to `/controlstreams/{id}/commands`) |
| server → client | D, P, O, H | an HTTP response (H is any status ≥ 400, including 401) |
| server → replay | K | a pushed `replay` command |
| replay → server | Q, O | registration (Q); state, log and command status (O) |
| server → models | D, O, H, K | an HTTP response; a pushed command (K) |
| models → server | Q, O, I | a request (Q); publishing (O); the referee (I) |
| models → scilibs, scilibs → models | I | a call and its result |
| client → gateway → server, models → gateway → server | Q, K | every request from the display client and the models passes the gateway (§9.5); each hop is captured |
| server → gateway → client, server → gateway → models | D, P, O, H, K | responses and pushes come back through it |

The rows above that read `client → server`, `server → client`, `models → server` and
`server → models` are drawn as two hops each, through `gateway`. The importer and the replay
controller are modules inside the server, so they do not pass the gateway.

The importer and the replay controller run inside the back-end worker. Their traffic is
captured where §2 says, even though no HTTP is involved (FR-65: "inside the server").

**Who sends a request** is told to the capture by request headers:
- `x-tap-model: <model id>` for a model;
- `x-tap-quiet: 1` for work the shell counts but does not draw: models registering and
  catching up at startup, and the silent import of Mission A;
- `x-tap-chain: <chain>` from the display client.

None of these headers decides anything in the server.

## 3. Captured message

```ts
interface Captured {
  id: number | string;
  t: number;            // REAL seconds (Date.now()/1000) when captured; drawing is in real time (FR-78)
  replay_t?: number;    // the replay time then, as Unix seconds, when a dataset is loaded (for the strip only)
  src: ComponentId; dst: ComponentId;
  letter: 'Q'|'D'|'O'|'K'|'P'|'H'|'S'|'L'|'I';
  summary: string;      // one line
  content: string;      // the message, at most 4,000 characters, with credentials redacted (§9.4)
  failed?: boolean;     // a request that got no answer (server down, starting or frozen past its timeout)
  push?: boolean;       // a command delivered on a push subscription (drawn "push")
  chain?: string|null;
  hop?: number;
  model?: string;
}
```

## 4. Time

- **Replay time** is absolute UTC, as written in the CSV files. Each dataset has its own
  span (§6). The replay controller holds the replay time and the current dataset (§8).
- **Real time** paces the replay clock (`rate` replay seconds per real second) and the
  drawing. The shell has no speed control (FR-78).
- The `SimClock` of 4.1 is withdrawn, together with `CLOCK_RATES`, `RATES`,
  `DEFAULT_RATE`, `HOP_S` in simulated seconds, and `simClock` in the page. One hop takes
  `HOP_MS = 900` real milliseconds; a handshake hop takes `HANDSHAKE_HOP_MS = 350`.
- **Rates** offered: `0.1, 0.5, 1, 10, 100` (FR-86). Each is capped by the lowest
  `max_rate` declared by an active model (§10.3).
- **Freeze** (FR-92) is set by the page on the back-end worker, with the control
  `freeze {on}`. While frozen:
  - the replay clock does not advance;
  - every request and every push is queued in the back-end worker, unanswered, and
    released in order on unfreeze;
  - the drawing holds its icons where they are.

  Freeze is not captured. A queued request keeps its relay timeout suspended: the relay
  asks with `x-relay-hold-ok: 1`, and the back-end worker sends `{held: true}` while it
  holds one, which resets the relay's timer.

## 5. The data folder and its CSV dialect (FR-15, FR-17)

**Location.** At build time `scripts/build_data_folder.py` writes
`web/public/data/folder/` and `.cache/data/` (for CI).

| File | Span (UTC) | Notes |
|---|---|---|
| `MISSION_A_20310407.csv` | 2031-04-07T00:00:00Z, +24 h | Imported silently at startup (FR-15) |
| `MISSION_B_20310414.csv` | 2031-04-14T00:00:00Z, +24 h | |
| `MISSION_B_20310414_REEXPORT.csv` | 2031-04-14T06:00:00Z, +24 h | Overlaps B by 18 h; about 0.1 % of the readings in the overlap differ (re-calibration) |
| `MISSION_C_20310421.csv` | 2031-04-21T00:00:00Z, +12 h | No `STN_AWS` column (stern wind speed) |
| `manifest.json` | | One entry per file: the seed, the generator version, the span, the ground truth for the referee (FR-12), sha256 |
| `index.json` | | The folder listing that the browser reads in place of a directory: name, size, modified date (fixed per file at build time, ISO), sha256 |

All four files come from one world (seed 1) generated across 21 days. Each mission is a
window of it. A file's modified date is the end of its span plus 2 hours, so dates are
reproducible.

**The dialect** is deliberately awkward (FR-17):
- Lines 1–3 are a comment block starting `#`: logger id, export tool version, and
  `#MISSION=<name>`.
- Line 4 is the header. Fields are separated by `;`, and the **decimal separator is a
  comma**.
- Column 1 is `T_HS94`: **half-seconds since 1994-01-01T00:00:00Z**, as an integer.
- The other columns have the sensor prefix `BOW_` or `STN_`, a code, and the unit in
  brackets. Values are in the units the brackets name.

  | Code | Field | Bracketed unit, and how it is written |
  |---|---|---|
  | `AT` | `air_temperature` | `[dC]`: tenths of a degree Celsius, integer |
  | `RH` | `relative_humidity` | `[%]` |
  | `PR` | `pressure` | `[hPa]`, one decimal place, comma separator |
  | `AWS` | `apparent_wind_speed` | `[kn]`: **knots**, one decimal place |
  | `AWD` | `apparent_wind_direction` | `[deg]`; `VRB` when variable |
  | `SR` | `solar_irradiance` | `[W/m2]` |
  | `WT` | `water_temperature` | `[dC]` |
  | `CO2` | `co2` | `[ppm]`, integer |

- **Missing** values are written `-9999`, or `////` for text. A missing column means the
  field is absent from that dataset (FR-21).
- Rows are in time order, at 1 Hz, with no blank lines. The line ending is CRLF.

**Second dialect** (AT-03, tests only): `backend/tests/second_dialect.py` writes the same
data with `,` separators, `.` decimals, ISO-8601 times, °C, m/s, and missing values as
empty fields. Only the importer may change to read it.

**CO₂ (FR-09a).** Per sensor, in ppm. The baseline is 415 ± 8 (slow drift). The engine
adds load × 180 ppm, where load is 1 under way, 0.35 in a lock, and 0.05 at a wharf
(`World.boat(t)` gives the kind of each period). The stern sits nearer the motor, so its
gain is 1.25. Noise has σ 6 ppm, and there are occasional spikes. QC is computed on
import, like every other field, with a range of 250–5000 ppm and a 60 ppm spike test
(D-144); both back ends use these values.

## 6. Datasets and names

- **Dataset id**: `<slug>-<h8>`. The slug is the file name without `.csv`, lower case,
  with every run of non-alphanumerics replaced by `-`. `h8` is the first 8 hex characters
  of the file's sha256. Example: `mission-a-20310407-3fa9c0d2`.
- **Output names** use `__` between the output and the dataset, because SWE Common
  names cannot contain spaces or `·` (decision D-122). On screen they are shown as
  `weather · mission-a…`.

| System (uniqueId) | outputName pattern | What |
|---|---|---|
| `urn:x-barge:sensor:bow`, `…:stern` | `weather__{ds}` | The 7 quantities (6 in Mission C's stern), each with its `<name>_qc` |
| `urn:x-barge:sensor:bow:co2`, `…:stern:co2` | `co2__{ds}` | `co2` (ppm) and `co2_qc` (**restricted**) |
| `urn:x-barge:process:data-cleanse` | `cleaned-bow__{ds}`, `cleaned-stern__{ds}` | |
| `urn:x-barge:process:data-cleanse:restricted` | `cleaned-co2-bow__{ds}`, `cleaned-co2-stern__{ds}` | **Restricted** |
| `urn:x-barge:process:summaries` | `summary-1min-{bow,stern}__{ds}`, `summary-1h-{bow,stern}__{ds}`, `derived-1min__{ds}`, `derived-1h__{ds}` | Minimum, mean and maximum per quantity (FR-29): `<f>_min`, `<f>`, `<f>_max` |
| `urn:x-barge:process:summaries:restricted` | `summary-1min-co2-{bow,stern}__{ds}`, `summary-1h-co2-{bow,stern}__{ds}` | **Restricted** |
| `urn:x-barge:process:analysis` | `runs__{ds}`, `changes__{ds}`, `clusters__{ds}`, `correlation__{ds}` | Appended, keyed by `run_id` (FR-28a) |
| `urn:x-barge:process:analysis:restricted` | the same four | Runs whose selection includes CO₂ (FR-112). **Restricted** |
| `urn:x-barge:importer` | `catalogue` | §7 |
| `urn:x-barge:replay` | `state`, `log` | §8 |
| `urn:x-barge:workspace:{user}` | `data-of-interest` | §11 |

`correlation` carries `matrix` as **Text** (JSON), because OpenSensorHub refused an array
of implicit size (finding of 2026-11-23). It is recorded as a gap.

Field definitions are `https://deepbluecltd.github.io/barge-monitor/def/<name>`. A
summary or cleaned value has the definition of its raw quantity (unchanged from 4.1).
Quantity units: `air_temperature` Cel, `apparent_wind_speed` m/s (converted from knots on
import), `relative_humidity` %, `pressure` hPa, `apparent_wind_direction` deg,
`solar_irradiance` W/m2, `water_temperature` Cel, `co2` ppm.

**Systems** (top level, with subsystems under them):

| uniqueId | label | type / assetType | parent | created by |
|---|---|---|---|---|
| `urn:x-barge:platform:barge` | Collection platform | sosa:Platform / Platform | | server config |
| `urn:x-barge:sensor:bow`, `…:stern` | Bow sensor, Stern sensor | sosa:Sensor / Equipment | barge | server config |
| `urn:x-barge:sensor:bow:co2`, `…:stern:co2` | Bow CO₂ analyser, Stern CO₂ analyser | sosa:Sensor / Equipment | the sensor | server config; **restricted** |
| `urn:x-barge:importer` | CSV importer | sosa:System / Equipment | | the importer |
| `urn:x-barge:replay` | Replay controller | sosa:System / Simulation | | the replay controller |
| `urn:x-barge:process:models` | Models | sosa:System / Process | | server config |
| `urn:x-barge:process:{model}` | the model's label | sosa:System / Process | models | the model |
| `urn:x-barge:process:{model}:restricted` | `{label}, restricted outputs` | sosa:System / Process | that model | the model; **restricted** |
| `urn:x-barge:workspace:{user}` | `Workspace of {user}` | sosa:System / Other | | server config (one per account) |

Identifiers are **opaque**, assigned by the server: 4 base-32 characters (`040g`), like
OpenSensorHub. Nobody may rely on them. Clients find everything by uniqueId and
outputName.

## 7. CSV importer (FR-20 to FR-22, FR-109, FR-110)

Its system is `urn:x-barge:importer`. It is created at server start, under the
importer's service account.

**`catalogue` datastream.** One observation per file per change of status. Fields:
`time`, `file` (Text), `size` (Count, bytes), `modified` (Time), `sha256` (Text),
`dataset` (Text, empty until imported), `start` and `end` (Time, once read), `records`
(Count), `status` (Category: `not-imported`, `importing`, `imported`, `changed`,
`superseded`), `pct` (Count, 0–100). The latest observation for a file is its current
status. Readers ask with `resultTime=latest` per file, or read the whole datastream and
fold it.

**`import` control stream.** Parameters, all present on every command (FR-27):
- `action`: Category, `import` or `rescan`;
- `file`: Text; empty for `rescan`.

The receiver validates and reports:
- `REJECTED` for an unknown file, or one already importing;
- `ACCEPTED`, then `EXECUTING` with `pct` in `message` every 10 %, then `COMPLETED`
  (or `FAILED`).

**Import:**
1. Read the file through the folder, parse the dialect (§5), and map the columns.
2. Compute the QC flags (QARTOD range and spike checks, as in 4.1).
3. Create the dataset's datastreams under the sensors and CO₂ analysers. This is done
   inside the server, under the importer's service account.
4. Write the rows **in bulk** into the store.

A file whose name matches an imported one but whose size, date or sha256 differ is
imported as a new dataset. The earlier one becomes `superseded` (FR-21a), and its
datastreams stay.

**At server start** the importer lists the folder and publishes `not-imported`,
`imported` or `changed` for every file. Then, **once per page load only**, it imports
`MISSION_A_…csv` with `x-tap-quiet` (silent, FR-15). After Reset instance this silent
import does not run until the page is reloaded.

**Speed.** The importer panel shows `rows/s` for the last import. In the stand-in it must
beat 50,000 rows/s, so that 24 h imports in under 4 s.

## 8. Replay controller (FR-84 to FR-89, FR-91)

Its system is `urn:x-barge:replay` (Simulation). It is created at server start, under
its own service account, and subscribes to its control stream before it declares itself
ready.

**`replay` control stream.** Parameters, every one present on every command:

| Parameter | Type | Bounds |
|---|---|---|
| `action` | Category | `load`, `play`, `pause`, `seek` |
| `dataset` | Text | a dataset id; must be imported, for `load` |
| `rate` | Quantity | one of `0.1, 0.5, 1, 10, 100`; at most `max_rate` |
| `position` | Time | ISO, within the current dataset's span (`seek`) |

The client always sends all four, filling the unchanged ones from the latest `state`.

The receiver validates every command:
- a rate above the bound is `REJECTED` with the message `rate 100 exceeds 10, the
  highest Analysis sustains` (FR-86, AT-35);
- `load` of a dataset that is not imported is `REJECTED`, naming it.

**`state` datastream.** One observation once per real second while playing, and one on
every change. Fields:

| Field | Type |
|---|---|
| `time` | Time: the replay time |
| `dataset` | Text |
| `start`, `end` | Time |
| `position` | Time: equal to `time` |
| `rate` | Quantity |
| `max_rate` | Quantity |
| `max_rate_model` | Text |
| `playing` | Boolean |
| `at_end` | Boolean |
| `run` | Text: the current replay run id |
| `models_ready` | Boolean: every model under Models has created its datastreams for `dataset` |

`time` is the replay time, so `resultTime=latest` gives the current state.
`phenomenonTime` is the replay time too, which makes the state of a dataset readable by
time.

**`log` datastream.** Every command applied: `time` (the replay time it took effect),
`command_id`, `action`, `dataset`, `rate`, `position`, `run`, `sender`.

**Replay runs.** A run id is `r-<dataset id>-<n>`. A new run starts on `load` of a
dataset, and on every `seek` (FR-87). Models tag their results with it (§10).

**Models ready.** After a `load`, the controller lists `/systems/{models}/subsystems` and
`/datastreams` (Q, drawn) once per real second until every model system has at least one
datastream whose output name ends `__{dataset}`. It then publishes the state with
`models_ready: true`. A model that is failing is skipped after 10 real seconds, and named
in the log. The display client starts the handshake that follows an import (FR-44) only
once `models_ready` is true for the new dataset, so its profile check never races the
models.

**At the end** of the dataset the controller pauses, sets `at_end`, and publishes the
state (FR-88).

**At startup**, before the first login, the controller loads Mission A and is paused at
its start (FR-77). This load is quiet.

## 9. The server: behaviour both stand-ins must have (FR-06c, PR-05, PR-06)

### 9.1 Behaving as a stock OpenSensorHub

- Identifiers are opaque (§6).
- `POST` creating something that already exists (same uniqueId, or same outputName
  under the same system) answers `201` with the **existing** `Location`. A different
  schema under an existing outputName makes a new datastream, with a new id (FR-51).
- **One observation per `POST`.** An array body is refused with `400`.
- A missing value is the string `"NaN"`. JSON `null` in a Quantity is refused with `400`.
- `PUT` and `DELETE` on observations, systems and datastreams answer `405`.
- The format is chosen with `f=application/swe+json`. The `Accept` header is
  **ignored**: the default is `application/json` observation resources. Paging is by
  `limit` and `offset`, with no `next` link in SWE JSON. A `limit` over the maximum is
  **not refused**.
- A refusal is an **HTML page** (`text/html`), with the status line in `<title>`. No
  client may rely on its body.
- There is **no instance identifier** and no `503`. While starting, and while down, the
  back-end worker answers nothing (`{down: true}`), and the relay returns a network
  failure. A start takes about one real second, during which connections are refused.
- Command status is posted to `/controlstreams/{csId}/status` with
  `{"command@id": "...", "statusCode": "...", "message": "..."}`. Status codes:
  `ACCEPTED`, `EXECUTING`, `COMPLETED`, `FAILED`, `REJECTED`.
- **Sending a command:** `POST /controlstreams/{csId}/commands` with
  `{"parameters": {...}}`.
  - **With no subscriber**, the command is dropped. The answer is `202` after 5 s, and the
    command is not listed afterwards.
  - **With a subscriber**, the command is pushed at once. The answer is `200` after
    **about 5 s**, with `currentStatus: PENDING` (FR-27). The sender never waits for
    this answer: it does not await the response before updating its display (AT-39).
- The profile is at `GET /profile.json`, beside the API (FR-41). It is **not** linked from
  the landing page.

### 9.2 Push subscriptions (FR-02a)

**Subscribing.** `GET /controlstreams/{csId}/commands?subscribe=1`, with the
`Authorization` header. The answer is `200` with `content-type: application/x-ndjson`
and a body that **never ends**: one command JSON per line, as
`{"id", "parameters", "issueTime", "sender"?}`.
- `sender` is present only if S-AUTH shows that OpenSensorHub provides it (§14).
- The subscription ends when the server stops, restarts or goes down. The receiver then
  resubscribes once the server answers again (FR-48, AT-38).

**`PushChannel`** (`web/src/push.ts`, and `csmodel.py`'s `subscribe`) wraps this in an
interface shaped like WebSocket: `onopen`, `onmessage({data})`, `onclose`, `close()`.

**Port protocol.** The back-end worker answers a subscription with
`{status, headers, stream: true}`, then `{chunk: <bytes>}` per command, and `{end: true}`
when the subscription stops. `sw.js` turns this into a `ReadableStream` response. In
CPython the same endpoint is a FastAPI `StreamingResponse`.

**Capture.** The push is captured as `server → <receiver>` with `K` and `push: true`, at
the moment it is written to the stream.

### 9.3 Authentication (FR-93, FR-97 to FR-102)

- Every request and every push subscription carries
  `Authorization: Basic base64(user:password)`. Without valid credentials the answer is
  **`401`** (an HTML page) with **no `WWW-Authenticate` header**, so the browser never
  shows a native login dialog. That header is to be confirmed against OpenSensorHub
  (§14).
- `/profile.json` also needs credentials.
- Accounts, as the server's configuration (`backend/barge/accounts.py` and
  `web/src/standin/accounts.ts`; identical, and labelled demo credentials, PR-07):

| Account | Password | Role / kind |
|---|---|---|
| `owner` | `demo-owner` | Owner |
| `friend` | `demo-friend` | Viewer (weather only) |
| `analyst` | `demo-analyst` | Viewer with emissions (for tests) |
| `svc-importer`, `svc-replay`, `svc-data-cleanse`, `svc-summaries`, `svc-analysis` | `svc-demo` | service: create and append only under their own systems (and the importer under the sensors' datastreams); read everything, CO₂ included |
| `svc-new-model-1`, `svc-new-model-2` | `svc-demo` | service: as above, but **no CO₂** unless the owner grants it (FR-113) |

- **Permissions**, checked per system and inherited by its subsystems, datastreams and
  control streams:
  - **read**: every role reads every unrestricted system, plus its own workspace.
    Owner, Viewer with emissions, and the core service accounts also read restricted
    systems;
  - **command**: every user may send commands to the importer, the replay controller and
    every model's unrestricted control stream;
  - **create and append**: a user only under `workspace:{self}`; a service account only
    under its own systems.
- A system the account may not read is **absent** (FR-93): it is left out of every
  listing (`/systems`, `/systems/{id}/subsystems`, `/datastreams`,
  `/systems/{id}/datastreams`, `/controlstreams`, `/collections/*/items`), and answers
  **404** to every path under it.
- **Role changes** (FR-116): the stand-in keeps a per-account `epoch`. Raising it (the
  admin stub, §13.5) makes every request with the old credentials answer `401` until the
  next login. Whether that matches OpenSensorHub is for S-AUTH (§14).
- The importer, the replay controller and the core models in CPython and in the stand-in
  authenticate as their service accounts.

### 9.5 The access gateway (S-AUTH finding of 2026-11-25; decision D-150)

A stock OpenSensorHub **cannot hide** a system: a denied system answers 403 and its
datastreams, observations and streams stay readable, and denies are not inherited. With
access control on, it also closes every command subscription at once. So the restriction
of FR-93 is done by an **access gateway**, written for this system, that sits in front of
the data server. It is drawn as a component of its own (`gateway`), never hidden inside
the stand-in.

**The gateway:**
- **Credentials.** It authenticates every request against the delivered accounts, and
  forwards the request with the same credentials. Without valid credentials it answers
  `401` itself, and it **strips** OpenSensorHub's `WWW-Authenticate: basic`, so that the
  browser never shows its own login dialog.
- **Filtering.** It removes restricted resources from every listing, matching them by
  unique-id prefix:
  - `urn:x-barge:sensor:*:co2`;
  - `urn:x-barge:process:*:restricted`;
  - other users' `urn:x-barge:workspace:*`.

  It also removes their datastreams and control streams, and answers `404` to every path
  under them.
- **Writes.** It enforces "create and append only under your own systems".
- **Push subscriptions.** It forwards them to the server's internal receiver endpoint,
  for service accounts only. That endpoint has access control off and is not reachable
  from outside.
- **Roles.** It reads the delivered user-to-role assignment on **every request**, so a
  role change takes effect at once (FR-116; there is no session to end). The `epoch` of
  §9.3 is withdrawn.

**The server (both stand-ins)** behaves as OpenSensorHub would behind the gateway: it
authenticates Basic credentials, and applies no permission per system. It keeps the
`WWW-Authenticate: basic` header on its 401.

**FR-112a.** A pushed command carries `sender`, the user id, as OpenSensorHub's does. The
receiving model looks up that user's role in the same delivered assignment
(`accounts.py`, `accounts.ts`), and rejects a command naming CO₂ if the role lacks
emissions.

### 9.4 Redaction (FR-16a)

Every captured `content` replaces the value of `Authorization` with `****`, and any JSON
member named `password` with `"****"`. The tap does this once, centrally, in
`tap.py` and `tap.ts`. AT-53 searches every captured message for each demo password.

## 10. Models

### 10.1 What a model is written against (`csmodel.py`, `csmodel.ts`)

```python
class Api:  # every method is async; each is one or more HTTP requests with the model's credentials
    async def find_system(self, uid) -> str | None            # by uniqueId, through discovery
    async def create_system(self, body, parent_uid=None) -> str  # POST /systems or /systems/{parent}/subsystems; 201 = success
    async def create_datastream(self, system_id, body) -> str  # returns a key "system_uid|outputName"
    async def create_controlstream(self, system_id, body) -> str
    async def find(self, system_uid, output_name) -> str | None
    async def read(self, key, t0, t1, fields=None) -> dict    # f=application/swe+json, paged by offset; "NaN" → nan
    async def latest(self, key) -> dict | None                # resultTime=latest
    async def publish(self, key, row: dict) -> None           # ONE observation per POST; nan → "NaN"
    async def publish_many(self, key, cols: dict) -> int      # loops publish(); counts
    async def subscribe(self, cs_key, on_command) -> None     # push stream (§9.2); resubscribes after unreachability
    async def command_status(self, cs_key, cmd_id, status, message="") -> None
    async def replay_state(self) -> dict                      # latest of urn:x-barge:replay|state
    async def score(self, kind, payload) -> dict              # the referee (scaffolding)
```

```python
class Model:
    id, label, description
    max_rate: float             # the highest replay rate it sustains (FR-37a)
    window: float = 60.0        # replay seconds per processing window, aligned to the dataset's start
    async def setup(self, api)                    # register; subscribe; THEN declare ready
    async def process(self, api, ds, t0, t1, run) # one window (t0, t1] of dataset ds, under replay run `run`
    async def on_command(self, api, cmd) -> str   # validate; raise Rejected("…bound…") to report REJECTED
```

### 10.2 The runner

The runner reads the replay `state` once per real second (drawn, like every other
request), and runs on what it finds:
- **On a new dataset**, it first creates all of the model's datastreams for that dataset,
  including the restricted ones it may publish. This is what the replay controller waits
  for (`models_ready`, §8).
- **Current dataset.** It follows `state.dataset`. On a new dataset or run, it continues
  from where it got to for that dataset if the run is the same, and otherwise starts the
  dataset's windows again from the run's position (FR-87).
- **Up to the replay time.** It processes whole windows only, up to `state.time`: every
  window `(t0, t1]` with `t1 ≤ replay time`. This is what makes outputs identical at any
  rate (FR-35, AT-34).
- **Results.** Every output observation carries `run` (and Analysis's `run_id`). Nothing
  is replaced (FR-28a). A reader takes the **latest run** for the dataset (FR-35).
- **Ready.** A model publishes `ready` (its `phase`, for the shell) only after its
  subscription is open (AT-38).
- **Declared rates:**

  | Model | `max_rate` |
  |---|---|
  | Data cleanse | 100 |
  | Summaries | 100 |
  | Analysis | 10 |

  The replay controller reads them from each model system's `max_rate` property
  (SensorML `characteristics`, read at registration).
- **Order.** Data cleanse reads `weather__{ds}` (and `co2__{ds}`). Every other model reads
  only Data cleanse's outputs (AT-15).

### 10.3 Commands to models

| Model | Control stream | Parameters (all present) |
|---|---|---|
| Data cleanse | `settings` | `spike_threshold` (Quantity 1–10) |
| Summaries | `settings` | `tendency_hours` (Quantity 1–6) |
| Analysis | `clustering` | the table below |

Analysis's `clustering` parameters:

| Parameter | Type | Bounds |
|---|---|---|
| `algorithm` | Category | A, B, C |
| `doi` | Text | an unsaved data of interest, as JSON (§11): its `dataset`, `start`, `end`, `resolution` and `sources` |
| `clusters` | Count | 2–8 |
| `sensitivity` | Quantity | 1–10 |

The receiver validates every bound, and answers `REJECTED` naming it (FR-27).

**CO₂ in a command (FR-112, FR-112a).** If `doi.sources` names a CO₂ field:
- the run is published under `analysis:restricted`;
- if the sender is not allowed CO₂, the command is `REJECTED` with "a requested source is
  not available". How the receiver knows the sender is decided by S-AUTH (§14).

## 11. Data of interest (FR-94 to FR-96a, FR-104 to FR-108)

The master is `contracts/schemas/data-of-interest.json`:

```json
{ "version": 1, "label": "…", "note": "…",
  "dataset": {"file": "…", "size": 0, "modified": "…", "sha256": "…"},
  "start": "…Z", "end": "…Z", "resolution": "PT1S|PT1M|PT1H", "aggregation": "as-stored",
  "sources": [{"system": "urn:…", "output": "weather", "fields": ["air_temperature"]}],
  "run": "r-…", "created": {"at": "…Z", "by": "owner"} }
```

- `sources[].output` is the output name **without** `__{ds}`. The dataset id is found
  again from `dataset.sha256` when the record is opened, so a re-import restores it
  (FR-96).
- **Saving** appends an observation to `urn:x-barge:workspace:{user}|data-of-interest`
  with fields `time` (save time), `doi_id` (Text), `action` (`save` or `remove`) and
  `record` (Text, the JSON). The list is folded from these.
- **Resolution** maps to datastreams: `PT1S` reads `cleaned-*` (or `weather`); `PT1M`
  reads `summary-1min-*`; `PT1H` reads `summary-1h-*`. Any other resolution is refused,
  naming these three (FR-94a).

## 12. The adoption opening (SRD §9.8)

- **The flag.** `?hand-made` is read once, by `web/src/shell/opening.ts`.
- **Layout.** `layout-opening.json` holds two rows for the back-end band:
  - row 1: `importer`, `replay`, `models`, `sub-webapi`, `sub-registry`, `sub-obsstore`;
  - row 2: `sub-query`, `sub-commands`, `sub-accounts`, `sub-permissions`, `sub-admin`.

  The third-party zone holds `scilibs` only. The other zones are shifted down by one card
  row.
- **Lines** (FR-120a) are drawn from `OPENING_FLOWS` in `opening.ts`, without letters.
- **Before Adopt:**
  - `runtime.start()` is **not called**: no worker starts and the relay is not
    registered (FR-122);
  - the top bar renders only the title;
  - the status reads "Opening";
  - the banner is not rendered.
- **Adopt** animates the eight cards to the `server` card's position over 1.5 s, with
  `prefers-reduced-motion` honoured. It then swaps to the normal layout, calls
  `runtime.start()`, and shows the controls.

## 13. Workers, the page and controls

### 13.1 Workers

| Worker | Runs | Started by |
|---|---|---|
| `backend.worker.ts` | Pyodide: the importer, the replay controller, the data server stand-in, the folder | the page, `?backend=python` |
| `model.worker.ts` ×3, plus one per empty slot used | Pyodide: one model each; its requests go through the relay with its service credentials | the page, Python mode |
| `standin.worker.ts` | TypeScript: everything the back-end worker runs, plus the core models | the page, by default |
| `sw.js` | the relay; forwards requests and streams; no logic (§9.2) | the page |

### 13.2 Messages between the page and the back-end worker

The page sends:
- `start {folderUrl, ...}`;
- `connect`, with a port for the relay;
- `model-connect {model}`;
- `control {action, arg}`.

The worker posts:
- `progress {stage, detail, pct}`;
- `tick {messages, server, replay}` every 100 ms;
- `state {…}`;
- `relay-failed {…}`.

`replay` in the tick is the latest replay state, for the shell's status only. The
display client reads the state over HTTP.

### 13.3 Control actions

`restart-server`, `down`, `up`, `field {name, on}`, `profile-lie`, `capture`,
`freeze {on}`, `reset-instance`, `set-role {user, role}`, `state`.

There is no `play`, `pause` or `rate`: replay is controlled only by commands (C4).

### 13.4 Control state

```
{ server, fields, pending, lie_about_profile,
  folder: [{file, size, modified, status, dataset, pct}],
  datasets: [{id, file, start, end, superseded}],
  replay, models: [{id, label, phase, detail, max_rate, datastreams}],
  accounts: [{user, role}], capture_counts, backend, frozen, import_rate }
```

### 13.5 Admin stub (FR-115)

The admin stub is the `set-role {user, role}` control action, offered in the control
panel as "OpenSensorHub administration (stand-in)". It raises the account's `epoch`
(§9.3).

### 13.6 URL parameters

`?backend=python|standin`, `?sketch=off` and `?hand-made`. `?seed` is withdrawn: the data
folder is fixed.

## 14. Waiting on the spikes

| Item | Interim in both stand-ins | Decided by |
|---|---|---|
| Restricted resources absent from listings, and 404 | **Decided: the access gateway** (§9.5); OpenSensorHub cannot do it | S-AUTH, question 1 |
| `sender` on a pushed command (FR-112a) | **Decided: present as the user id**; the receiver looks the role up | S-AUTH, question 4 |
| Role change: at once, or at the next login (FR-116) | **Decided: at once**, on the next request | S-AUTH, question 7 |
| `401` with or without `WWW-Authenticate` | **Decided:** the server sends it, and the gateway strips it | S-AUTH, question 6 |
| Bulk import inside the server | **Decided: feasible**, at about 300,000 rows/s (finding of 2026-11-25) | S-IMPORT |

When a spike reports, this table, FR-06c and both stand-ins are brought into line with
OpenSensorHub. **OpenSensorHub is the reference** (PR-06).
