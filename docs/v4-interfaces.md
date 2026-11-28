# Version 4.7 interfaces (implementation contract)

These are the fixed points that the Python back end, the JavaScript stand-in, the models
and the front end are built against. SRD Version 4.7 (`srd-barge.md`) is the requirement;
this file is the design that meets it. Where the two disagree, the SRD wins and this file
is wrong. `docs/plan-v4.7.md` gives the order of work.

**Changes from 4.6 (the owner's review, 2026-11-26; decisions D-220 to D-232):**
- **No replay controller.** Replay is the display client's own (§8). Models process each
  dataset on import (§10.2). The `replay` component, `urn:x-barge:replay`, its control
  stream, `state`, `log`, `models_ready`, `max_rate` and `svc-replay` are withdrawn.
- **No access gateway.** Clients talk to the data server directly (§9.3). Restricted
  resources are listed and refused with `403`, as stock OpenSensorHub does. The `gateway`
  component and §9.5 are withdrawn.
- **No Freeze.** The `freeze` control action, the relay's hold (`x-relay-hold-ok`,
  `{held}`) and `frozen` are withdrawn. *Revised (D-362, 2026-11-28):* the shell's **system
  hold** (§4, §13.2) pauses the whole system again, and slows it; the relay itself is unchanged.
- **Startup names its steps**, and a stall says where (§13.7).
- The opening's back-end band is two rows of five (§12).

Names in `code` are normative. Both back ends implement every section that says "the
server", except where a section says otherwise.

## 1. Component identifiers

Every captured message names its sender and receiver with one of these ids (SRD §3):

| id | Component | Zone | Value-add |
|---|---|---|---|
| `folder` | Data folder | Legacy | |
| `importer` | CSV importer | New build · back end | |
| `server` | Data server (OpenSensorHub; a stand-in here) | Third-party libraries | |
| `models` | Models | New build · back end | ★ |
| `scilibs` | Scientific libraries | Third-party libraries | |
| `client` | Display client | New build · front end | ★ |

In the adoption opening only (§12), these ids stand in for `server`. They are the
subsystems drawn, not a count of what the data server holds (SRD FR-120):

`sub-webapi`, `sub-registry`, `sub-obsstore`, `sub-query`, `sub-commands`,
`sub-accounts`, `sub-permissions`, `sub-admin`.

No message is ever captured with these ids.

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
| server → models | D, O, H, K | an HTTP response; a pushed command (K) |
| models → server | Q, O, I | a request (Q); publishing (O); the referee (I) |
| models → scilibs, scilibs → models | I | a call and its result |

The display client and the models talk to the server directly (4.7: no gateway). The
importer is a module inside the server and runs inside the back-end worker. Their traffic is
captured where §2 says, even though no HTTP is involved (FR-65: "inside the server").

**Who sends a request** is told to the capture by request headers:
- `x-tap-model: <model id>` for a model;
- `x-tap-quiet: 1` for work the shell counts but does not draw: models registering, the
  models' reads and per-row writes while they process a dataset (D-283), and the silent import
  of Mission A. A model's runs-log entries and its calls into the scientific libraries are drawn
  (D-321); the god's-eye note says how many were counted but not drawn;
- `x-tap-chain: <chain>` from the display client.

None of these headers decides anything in the server.

## 3. Captured message

```ts
interface Captured {
  id: number | string;
  t: number;            // REAL seconds (Date.now()/1000) when captured; drawing is in real time (FR-78)
  replay_t?: number;    // the display client's replay time then, as Unix seconds, when a dataset is open (for the strip only)
  src: ComponentId; dst: ComponentId;
  letter: 'Q'|'D'|'O'|'K'|'P'|'H'|'S'|'L'|'I';
  summary: string;      // one line
  content: string;      // the message, at most 4,000 characters, with credentials redacted (§9.4)
  failed?: boolean;     // a request that got no answer (server down or starting)
  push?: boolean;       // a command delivered on a push subscription (drawn "push")
  chain?: string|null;
  hop?: number;
  model?: string;
}
```

## 4. Time

- **Replay time** is absolute UTC, as written in the CSV files. Each dataset has its own
  span (§6). Each **display client** holds its own replay time and current dataset (§8).
  Nothing on the server holds a replay time.
- **Real time** paces each client's replay clock (`rate` replay seconds per real second)
  and the drawing. The shell's drawing speed (D-362) slows only the drawing (and holds the
  system back to match), never a client's replay clock.
- The `SimClock` of 4.1 is withdrawn, together with `CLOCK_RATES`, `DEFAULT_RATE`, `HOP_S`
  in simulated seconds, and `simClock` in the page. One hop takes `HOP_MS = 900` real
  milliseconds; a handshake hop takes `HANDSHAKE_HOP_MS = 350`.
- **Rates** offered: `0.1, 0.5, 1, 10, 100` (FR-86). Nothing bounds them: models do not
  follow replay (§10.2).
- **Freeze** is withdrawn (4.7). Pausing the client stops its polling (FR-63a); the drawing
  of messages already sent finishes in real time.
- **The drawing clock** (`shell/drawclock.ts`, D-302) runs at the drawing speed, `1`, `0.5`
  or `0.25` drawing seconds per real second, and **stops while the system is paused**
  (FR-92, FR-92a; D-362). Every hop's duration and queue (`messages.ts`) is in drawing
  seconds, so icons slow down and hold still with it.
- **The system hold** (D-362; `shell/system.ts`). The shell's **Pause system** sets
  `paused`; slow motion sets `pressure` while the drawing's **lag** (how long the last icon
  queued waits before it sets off, in drawing seconds) is at least `LAG_HOLD_S = HOP_S`,
  until it is down to `LAG_RELEASE_S = HOP_S / 4`. `held = paused || pressure`. Each part
  holds itself, at the relay's entrances, never inside it:

  | Part | While `held` | While `paused` only |
  |---|---|---|
  | Display client (`client/http.ts`) | in slow motion, a request enters the relay only while lag < `LAG_HOLD_S`, one per 50 ms | a request waits before it enters the relay, and an answer already on its way before it is read; the replay clock, the poll and the idle lock stand still |
  | Model worker (`model.worker.ts`) | no step; a request, a subscription and an answer wait | |
  | Stand-in back end | the core models take no step, and their requests and answers wait; the importer stops at its next block or command; a pushed command waits in the server (written and captured when let go) | |
  | Python back end (`runtime.set_held`) | the importer stops at its next block or command (`wait_released`); a pushed command waits in the server before it is written to the stream | |
  | Page (`runtime.ts`) | | messages captured are kept, and drawn on Resume in order; a startup step's stall time does not count |

  A request already inside the relay when Pause is pressed is answered by the server (its
  capture is kept by the page) and the answer waits at its receiver. Nothing is dropped, so
  Resume continues where Pause left off. The relay is not made to hold requests itself: a
  Service Worker may be stopped by the browser while a fetch is held for minutes, and one
  relay serves every tab of the site.

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
| `urn:x-barge:sensor:bow:co2`, `…:stern:co2` | `co2__{ds}` | `co2` (`[ppm]`) and `co2_qc` (**restricted**) |
| `urn:x-barge:process:data-cleanse` | `cleaned-bow__{ds}`, `cleaned-stern__{ds}` | One **block** per hour of the dataset (D-280): `time` (the block's start), `run_id`, `offsets` (Text: a JSON array of seconds from `time`, one per reading), one Text per quantity (a JSON array of its cleaned readings, `null` where removed; the field has its raw quantity's definition) and `removed` (Count) |
| `urn:x-barge:process:data-cleanse:restricted` | `cleaned-co2-bow__{ds}`, `cleaned-co2-stern__{ds}` | **Restricted**; blocks, with `co2` |
| `urn:x-barge:process:summaries` | `summary-1min-{bow,stern}__{ds}`, `summary-1h-{bow,stern}__{ds}`, `derived-1min__{ds}`, `derived-1h__{ds}` | Minimum, mean and maximum per quantity (FR-29): `<f>_min`, `<f>`, `<f>_max`, and `readings_removed`; derived: `dew_point`, `bow_minus_stern`, `pressure_tendency_3h`. Minutes and hours aligned to the dataset's start; each carries `run_id` |
| `urn:x-barge:process:summaries:restricted` | `summary-1min-co2-{bow,stern}__{ds}`, `summary-1h-co2-{bow,stern}__{ds}` | **Restricted** |
| `urn:x-barge:process:{model}` (every model) | `runs__{ds}` | Each run's progress and result on the dataset (§10.2, FR-35b) |
| `urn:x-barge:process:analysis` | `changes__{ds}`, `clusters__{ds}`, `correlation__{ds}` | Appended, keyed by `run_id` (FR-28a): `changes` has `scale` (`minutes`, `hours`) and `strength`; `clusters` has `cluster` (`c1`…`c8`); `correlation` has `fields` and `matrix` |
| `urn:x-barge:process:analysis:restricted` | the same four | Runs whose selection includes CO₂ (FR-112). **Restricted** |
| `urn:x-barge:importer` | `catalogue` | §7 |
| `urn:x-barge:workspace:{user}` | `data-of-interest` | §11 |

`correlation` carries `matrix` as **Text** (JSON), because OpenSensorHub refused an array
of implicit size (finding of 2026-11-23). It is recorded as a gap.

Field definitions are `https://deepbluecltd.github.io/barge-monitor/def/<name>`. A
summary or cleaned value has the definition of its raw quantity (unchanged from 4.1).
Quantity units: `air_temperature` Cel, `apparent_wind_speed` m/s (converted from knots on
import), `relative_humidity` %, `pressure` hPa, `apparent_wind_direction` deg,
`solar_irradiance` W/m2, `water_temperature` Cel, `co2` `[ppm]`. Every `uom.code` is a
UCUM code: parts per million is `[ppm]` in UCUM, and `ppm` is refused (D-195).

**Systems** (top level, with subsystems under them):

| uniqueId | label | type / assetType | parent | created by |
|---|---|---|---|---|
| `urn:x-barge:platform:barge` | Collection platform | sosa:Platform / Platform | | server config |
| `urn:x-barge:sensor:bow`, `…:stern` | Bow sensor, Stern sensor | sosa:Sensor / Equipment | barge | server config |
| `urn:x-barge:sensor:bow:co2`, `…:stern:co2` | Bow CO₂ analyser, Stern CO₂ analyser | sosa:Sensor / Equipment | the sensor | server config; **restricted** |
| `urn:x-barge:importer` | CSV importer | sosa:System / Equipment | | the importer |
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

**`records` is `0` until the file is imported** (D-197): a Count has no missing value in
OpenSensorHub, which refuses both `"NaN"` and `null` there. The status says whether it
counts: it is the dataset's number of rows for `imported`, `changed` and `superseded` (the
statuses that name a dataset), and `0` for `not-imported` and `importing`. A reader never
shows that `0` as a count; the display client reads it as no count at all.

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

## 8. Replay in the display client (FR-84 to FR-90, §8.6)

There is no replay on the server (4.7, D-220). Each display client keeps:

```ts
interface ReplayClock {
  dataset: string | null;   // the client's current dataset id
  start: number; end: number; // its span, Unix seconds, from the catalogue
  time: number;             // the replay time, Unix seconds, within [start, end]
  rate: 0.1 | 0.5 | 1 | 10 | 100;
  playing: boolean;
  atEnd: boolean;
}
```

- **Open** (from the Dataset selector, FR-103) sets `dataset`, `start` and `end`, puts
  `time` at `start`, and pauses. It sends no command. If the file is not imported, the
  client first sends `import` (§7) and opens it when the catalogue says `imported`.
- **Play, pause, rate and seek** change the clock only. While playing, `time` advances by
  `rate` replay seconds per real second. At `end` the clock pauses and sets `atEnd`
  (FR-88). Play at the end starts again from `start`.
- **Reading.** While playing, the client polls each datastream in use once per real second
  for `phenomenonTime` up to `time` (FR-63). While paused it polls nothing (FR-63a). It
  never asks beyond `time` (FR-63b), even though the server holds the whole dataset and
  every model's results for it.
- **Results.** For model outputs, the client shows the dataset's **latest complete run**
  (§10.2). While a model's latest run on the dataset is `processing`, the views that depend
  on it say "results being prepared", with the run's `pct` (FR-35b). It finds this
  generically, from the `runs__{ds}` datastreams it can read; it does not know the models.
- **Default.** After login, the client opens Mission A, paused at its start (FR-77).
  Restart client returns to that (FR-85).
- **Two clients** replaying the same dataset at different rates see the same results up to
  their own times. The server's outputs do not change (AT-70).
- **The shell** mirrors the clock in the status box, read in the page; nothing about it
  crosses the seam. The top bar has no replay control (D-362): the client's replay bar is
  the only one. The shell's **Pause system** holds the clock still without changing
  `playing` (§4, the system hold), and Resume continues from the same `time`.

## 9. The server: behaviour both stand-ins must have (FR-06c, PR-05, PR-06)

### 9.1 Behaving as a stock OpenSensorHub

- Identifiers are opaque (§6).
- **Discovery of every system** is `GET /systems?searchMembers=true` (D-193): every
  system, subsystems included, in either encoding (`f=application/sml+json` gives
  `uniqueId`; GeoJSON gives `properties.uid`). `GET /systems` alone lists the top level;
  `/systems/{id}/subsystems` lists a system's children. **A listing carries no `parent`
  link**; only a single system (`GET /systems/{id}`) links its parent. No client relies on
  parent links: the system tree, where one is needed, is learnt from `/subsystems` (D-192). `GET /collections/all_systems/items` answers `400`, as
  OpenSensorHub does; `/collections` lists `all_systems` with its `items` link to `/systems`.
- **SensorML is sent as `application/sml+json`** (D-194), to `POST /systems` and
  `POST /systems/{id}/subsystems`. A body sent as `application/json` (or without a
  `Content-Type`) is read as GeoJSON: anything but a `Feature` is refused with `400`, as
  OpenSensorHub refuses it.
- **Units are UCUM codes** (D-195). A datastream or control stream whose schema carries a
  `uom.code` that is not UCUM is refused with `400` (OpenSensorHub: "Invalid UCUM code").
- **Clients read a body as JSON whatever its `Content-Type` says** (D-196). OpenSensorHub
  labels the landing page, `/conformance` and `/datastreams/{id}/schema` asked without `f`
  as `Content-Type: auto`; the bodies are JSON. The stand-ins label them `application/json`.
- `POST` creating something that already exists (same uniqueId, or same outputName
  under the same system) answers `201` with the **existing** `Location`. A different
  schema under an existing outputName makes a new datastream, with a new id (FR-51).
- **One observation per `POST`.** An array body is refused with `400`.
- **A SWE JSON record's members come in its schema's order** (D-346). OpenSensorHub reads them in order and
  refuses another (`400`); both `csmodel`s send them in order. The stand-ins still accept any order.
- A missing value is the string `"NaN"`. JSON `null` in a Quantity is refused with `400`.
- `PUT` and `DELETE` on observations, systems and datastreams are **refused with a `4xx`**
  (D-200): the stand-ins answer `405`; OpenSensorHub answers `400` to `PUT` with an empty
  body. Clients rely only on a 4xx. **Open (D-224):** a stock OpenSensorHub **deletes** a
  system or a datastream on `DELETE` (`204`) for an account its permissions allow, and for
  any account on its internal endpoint (tried on 2026-11-26). FR-28a needs the delivered
  OpenSensorHub configured to refuse it; that is to be settled with the OpenSensorHub team
  (§14). The stand-ins refuse `PUT`, `PATCH` and `DELETE` with `405` for every account, as
  the configured server is expected to.
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
  `ACCEPTED`, `EXECUTING`, `COMPLETED`, `FAILED`, `REJECTED`. Listed, each report also
  carries its own `id` and its `reportTime` (real time); readers tell reports apart by `id`
  (D-181).
- **A command's outcome is its latest status report other than `PENDING`** (D-199,
  revising D-164), by `reportTime`, among the reports since the command was sent. When
  the sender's `POST` answers, the server stores a `PENDING` report for the command: in
  OpenSensorHub that is often **after** the receiver's `COMPLETED`, so the latest report
  alone would read `PENDING`. Both stand-ins store it too. The display client, both
  `csmodel`s (`outcome`, `commandOutcome`), the shell and the suite read it this way.
- **Sending a command:** `POST /controlstreams/{csId}/commands` with
  `{"parameters": {...}}`. Commands go to the importer (`import`) and to the models; there
  is no `replay` control stream (4.7).
  - **With no subscriber**, the command is dropped and not listed afterwards. The answer
    is `202` after the hold: **5 s in the stand-ins**, about **29.5 s in OpenSensorHub**
    2.0.4 (AT-32 run of 2026-11-26). The stand-ins keep 5 s; no client waits on either.
  - **With a subscriber**, the command is pushed at once. The answer is `200` after
    **about 5 s**, with `currentStatus: PENDING` (FR-27), and the `PENDING` report is
    stored then. The sender never waits for this answer: it does not await the response
    before updating its display (AT-39).
- The profile is at `GET /profile.json`, beside the API (FR-41). It is **not** linked from
  the landing page.

### 9.2 Push subscriptions (FR-02a)

**Subscribing.** `GET /controlstreams/{csId}/commands?subscribe=1`, with the
`Authorization` header. The answer is `200` with `content-type: application/x-ndjson`
and a body that **never ends**: one command JSON per line, as
`{"id", "parameters", "issueTime", "sender"?}`.
- `sender` is the sending user's id, as OpenSensorHub puts it on a pushed command
  (D-152).
- The subscription ends when the server stops, restarts or goes down. The receiver then
  resubscribes once the server answers again (FR-48, AT-38).

**`PushChannel`** (`web/src/push.ts`, and `csmodel.py`'s `subscribe`) wraps this in an
interface shaped like WebSocket: `onopen`, `onmessage({data})`, `onclose`, `close()`.

- **Where receivers subscribe (D-223).** With access control on, OpenSensorHub closes every
  command subscription on its public endpoint at once (S-AUTH). Receivers (the importer and
  the models) are server-side processes in a developed system, so they subscribe on the
  server's **internal endpoint**, which has access control off and is not reachable from
  outside: `/api-internal` beside `/api`. The stand-ins serve the same path, for service
  accounts only.

**Port protocol.** The back-end worker answers a subscription with
`{status, headers, stream: true}`, then `{chunk: <bytes>}` per command, and `{end: true}`
when the subscription stops. `sw.js` turns this into a `ReadableStream` response. In
CPython the same endpoint is a FastAPI `StreamingResponse`.

**Capture.** The push is captured as `server → <receiver>` with `K` and `push: true`, at
the moment it is written to the stream.

### 9.3 Authentication and permissions (FR-93, FR-97 to FR-102, FR-111 to FR-118)

Clients reach the data server **directly** (4.7, D-221). The stand-ins do what a stock
OpenSensorHub with its security module on does, configured as below. Where that
configuration is not yet proven, §14 says so.

- Every request and every push subscription carries
  `Authorization: Basic base64(user:password)`. Without valid credentials the answer is
  **`401`** (an HTML page) with `WWW-Authenticate: basic`, as OpenSensorHub sends it.
  The browser's native login dialog must never appear (FR-97): the display client always
  sends credentials, and the relay drops the `WWW-Authenticate` header on the way back. In
  a developed system the same is done by configuring OpenSensorHub or its web server (§14,
  D-226).
- `/profile.json` also needs credentials.
- Accounts, as the server's configuration (`backend/barge/accounts.py` and
  `web/src/standin/accounts.ts`; identical, and labelled demo credentials, PR-07):

| Account | Password | Role / kind |
|---|---|---|
| `owner` | `demo-owner` | Owner |
| `friend` | `demo-friend` | Viewer (weather only) |
| `analyst` | `demo-analyst` | Viewer with emissions (for tests) |
| `svc-importer`, `svc-data-cleanse`, `svc-summaries`, `svc-analysis` | `svc-demo` | service: create and append only under their own systems (and the importer under the sensors' datastreams); read everything, CO₂ included |
| `svc-new-model-1`, `svc-new-model-2` | `svc-demo` | service: as above, but **no CO₂** unless the owner grants it (FR-113) |

- **Permissions**, per system. In OpenSensorHub a grant is inherited but a deny is not
  (S-AUTH), so restricting is done with an **allow-list**: each role is granted read on
  every *open* resource by id, and the list is extended as each import and each model
  creates datastreams (D-222). The stand-ins check by resource the same way:
  - **read**: every role reads every unrestricted system, plus its own workspace.
    Owner, Viewer with emissions, and the core service accounts also read restricted
    systems;
  - **command**: every user may send commands to the importer and every model's
    unrestricted control stream;
  - **create and append**: a user only under `workspace:{self}`; a service account only
    under its own systems. Stock OpenSensorHub meets this for top-level creation, but lets
    an account create **subsystems under any system**, and lets any account read another
    user's workspace (S-AUTH). Both are open (§14); the stand-ins refuse them, as the
    configured server is expected to.
- **A system the account may not read is listed and described, and its contents refused (4.7, FR-93;
  D-351: a stream's title may be known, not its contents).** It appears in `/systems`,
  `/systems?searchMembers=true`, `/systems/{id}/subsystems`, `/datastreams`,
  `/systems/{id}/datastreams` and `/controlstreams`, as OpenSensorHub lists it, and the system, its
  datastreams, their schemas, its control streams and their schemas can be read. Its **contents**
  answer **`403`**: its datastreams' observations, and its control streams' commands (sent or listed)
  and status. Another user's workspace is refused whole (its system answers `403` too). The restricted
  systems are matched by unique id:
  - `urn:x-barge:sensor:*:co2`;
  - `urn:x-barge:process:*:restricted`;
  - other users' `urn:x-barge:workspace:*`.
- **The display client offers only what it can read (FR-118).** At the handshake, a
  datastream whose schema or whose observations (`resultTime=latest`) answer `403` is left out
  of the field list, like a datastream it cannot use (D-351). It is not reported as missing, and it never makes a dataset degraded. The
  client has no list of restricted ids.
- **Role changes** take effect **on the next request** (FR-116, D-151): the server reads
  the user-to-role assignment on every request. The admin stub (§13.5) changes it.
- **FR-112a.** A pushed command carries `sender`, the user id. The receiving model looks
  that user's role up in the delivered assignment (`accounts.py`, `accounts.ts`), and
  rejects a command naming CO₂ if the role lacks emissions (D-152).
- The importer and the core models in CPython and in the stand-in authenticate as their
  service accounts.

### 9.4 Redaction (FR-16a)

Every captured `content` replaces the value of `Authorization` with `****`, and any JSON
member named `password` with `"****"`. The tap does this once, centrally, in
`tap.py` and `tap.ts`. AT-53 searches every captured message for each demo password.

## 10. Models

### 10.1 What a model is written against (`csmodel.py`, `csmodel.ts`)

```python
class Api:  # every method is async; each is one or more HTTP requests with the model's credentials
    async def find_system(self, uid) -> str | None            # by uniqueId: GET /systems?searchMembers=true (D-193)
    async def create_system(self, body, parent_uid=None) -> str  # POST /systems or /systems/{parent}/subsystems as
                                                                 # application/sml+json (D-194); 201 = success
    async def create_datastream(self, system_id, body) -> str  # returns a key "system_uid|outputName"
    async def create_controlstream(self, system_id, body) -> str
    async def find(self, system_uid, output_name) -> str | None
    async def read(self, key, t0, t1, fields=None) -> dict    # f=application/swe+json, paged by offset; "NaN" → nan
    async def latest(self, key) -> dict | None                # resultTime=latest
    async def publish(self, key, row: dict) -> None           # ONE observation per POST; nan → "NaN"
    async def publish_many(self, key, cols: dict) -> int      # loops publish(); counts
    async def subscribe(self, cs_key, on_command) -> None     # push stream (§9.2); resubscribes after unreachability
    async def command_status(self, cs_key, cmd_id, status, message="") -> None
    async def all(self, key) -> list[dict]                    # every observation, as records, paged by offset
    async def catalogue(self) -> list[dict]                   # the importer's catalogue, folded per file (§7)
    async def datasets(self) -> list[dict]                    # datasets to process, in import order (§10.2)
    async def score(self, kind, payload) -> dict              # the referee (scaffolding)
    def real(self) -> float                                   # real time for a runs entry, strictly increasing
```

Times are **Unix seconds** in every model (4.7): no simulation epoch.

```python
class Model:
    id, label, description
    window: float | None = 60.0  # seconds of data per processing window, aligned to the dataset's start;
                                 # None: a run's whole data range at once (Analysis)
    uses_co2, restricted_runs    # a restricted subsystem; runs that name CO₂ are logged under it too
    control, defaults, runs_master  # its control stream and runs record (the masters), its default settings
    async def setup(self, api)                    # register: system, restricted subsystem, control stream
    async def declare(self, api, ds) -> bool      # every datastream for dataset ds, runs__{ds} included (calls outputs)
    async def outputs(self, api, ds) -> bool      # the model's own datastreams; False while its inputs are not there
    async def process(self, api, ds, t0, t1, run) # one window [t0, t1) of dataset ds, in run `run` (its id, settings)
    async def finish(self, api, ds, run)          # after the last window: run.result for the complete entry
    def wanted(self, ds, complete) -> dict | None # the settings of a run ds still needs, given its complete runs
    def validate(self, api, cmd)                  # every bound; raise Rejected("…bound…") to report REJECTED
    async def on_command(self, api, cmd) -> dict  # the runs a command asks for: a dataset (or every one), settings
    async def read_cleaned(self, api, ds, source, t0, t1, run_id, names) -> dict  # Data cleanse's readings (D-280)
```

A run is `Run`: its `id`, `settings`, `start`, `end` (exclusive), `source` (Data cleanse's run it reads),
`state` (the model's own) and `result`. The runner calls `step()` again and again; the runner, not the
model, subscribes, finds datasets, plans runs and logs them.

### 10.2 The runner (4.7: process on import)

Models follow **no replay clock and no current dataset** (FR-35, D-220). The runner:

- **Finds datasets** by reading the importer's `catalogue` once per real second. Every
  dataset whose file status is `imported`, `changed` or `superseded` is one to process.
  Processing (this reading included) is **counted, not drawn** (D-283); a command and its
  status reports are drawn.
- **On a dataset not yet processed**, it first **declares** every datastream the model may
  publish for it, restricted ones included, and `runs__{ds}`. It then processes the
  **whole dataset**, in whole windows `[t0, t1)` aligned to the dataset's start
  (D-129), oldest first, and the last, partial window at the dataset's end. Datasets are
  taken in the order they were imported.
- **Runs.** A run id is `<model>-<dataset id>-<n>`. Run 1 is the first processing of a
  dataset. A settings command (§10.3) starts a new run of that model over every imported
  dataset, newest first. Analysis's `clustering` command starts one run on the dataset its
  `doi` names. Numbers carry on from the dataset's runs log, so they are never reused (after
  Reset instance the log is empty, and the next run is 1 again). The command reports
  `ACCEPTED`, then `COMPLETED` once its runs are queued, naming them (D-284); their progress
  is in `runs__{ds}`. Which runs a dataset needs is planned from its runs log: a model wants a
  complete run with its current settings; Analysis wants run 1 only (D-282).
- **Progress (FR-35b).** Each run appends to `runs__{ds}`: `time` (real time), `run_id`,
  `status` (`processing` or `complete`), `done_until` (Time: the end of the last window
  done), `pct` (Count 0–100), and the settings it used. It appends a `processing` entry at
  the start and every 10 %, and a `complete` entry at the end. Analysis's runs also carry
  `start`, `end`, `algorithm`, `resolution`, `records`, `clusters`, `score_changes` and
  `score_clusters` (D-183).
- **Results.** Every output observation carries its `run_id`. Nothing is replaced (FR-28a).
  A reader takes the **latest complete run** for the dataset (FR-35).
- **Determinism (AT-34).** A run's outputs depend only on the dataset and the run's
  settings, never on when it ran, how long it took or what any client was doing.
- **Ready.** A model publishes `ready` (its `phase`, for the shell) only after its
  subscription is open (AT-38).
- **After a server restart** a model registers again and resubscribes. Datastreams and
  results persist across a restart, as in OpenSensorHub. A run cut short by the restart is
  restarted as a new run. The 4.6 restart hold (D-186) is withdrawn (D-228).
- **Order.** Data cleanse reads `weather__{ds}` (and `co2__{ds}`). Every other model reads
  only Data cleanse's outputs (AT-15), and waits until Data cleanse's run on the dataset is
  `complete`. A run reads Data cleanse's latest complete run when it starts; it is not run
  again when Data cleanse runs again (D-282).
- **Windows (D-281).** Data cleanse and Summaries take an hour at a time; Analysis a run's
  whole data range at once; the example new model an hour.
- **Speed (D-280).** Data cleanse's blocks make a day a few hundred observations. Measured
  in Chromium: Mission A's three runs complete about 3 s after the flowchart in the stand-in
  and about 30 s after it in Python (each model first loads its own Pyodide).

### 10.3 Commands to models

| Model | Control stream | Parameters (all present) |
|---|---|---|
| Data cleanse | `settings` | `spike_threshold` (Quantity 1–10); a new run over every dataset |
| Summaries | `settings` | `tendency_hours` (Quantity 1–6); a new run over every dataset |
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
  not available". The receiver looks up the role of the command's `sender` (§9.3).

## 11. Data of interest (FR-94 to FR-96a, FR-104 to FR-108)

The master is `contracts/schemas/data-of-interest.json`:

```json
{ "version": 1, "label": "…", "note": "…",
  "dataset": {"file": "…", "size": 0, "modified": "…", "sha256": "…"},
  "start": "…Z", "end": "…Z", "resolution": "PT1S|PT1M|PT1H", "aggregation": "as-stored",
  "sources": [{"system": "urn:…", "output": "weather", "fields": ["air_temperature"]}],
  "run": "analysis-…-1", "created": {"at": "…Z", "by": "owner"} }
```

- `sources[].output` is the output name **without** `__{ds}`. The dataset id is found
  again from `dataset.sha256` when the record is opened, so a re-import restores it
  (FR-96).
- **Saving** appends an observation to `urn:x-barge:workspace:{user}|data-of-interest`
  with fields `time` (save time), `doi_id` (Text), `action` (`save` or `remove`) and
  `record` (Text, the JSON). The list is folded from these.
- **On screen** these are **Favourites** (SRD §8.5). The record's name stays "data of
  interest".
- **Resolution** maps to datastreams: `PT1S` reads `weather` (Data cleanse's `cleaned-*`
  are blocks, for models, D-280); `PT1M` reads `summary-1min-*`; `PT1H` reads `summary-1h-*`.
  Analysis reads only Data cleanse's output (AT-15): at `PT1M` and `PT1H` it takes the means of
  its readings in intervals aligned to the dataset's start (D-288). Any other resolution is refused,
  naming these three (FR-94a).

## 12. The adoption opening (SRD §9.8)

- **The flag.** `?hand-made` is read once, by `web/src/shell/opening.ts`.
- **Layout.** `layout-opening.json` holds two rows of five for the back-end band, every
  card the size of `importer` and `models` in `layout.json` (D-330):
  - row 1: `models`, `importer`, `sub-obsstore`, `sub-registry`, `sub-webapi`;
  - row 2: `sub-commands`, `sub-accounts`, `sub-query`, `sub-permissions`, `sub-admin`.

  The order within each row is the layout's (D-331): `models` and `importer` lead row 1, in
  the order they have in `layout.json`, so the merge moves neither across the other. The
  third-party zone holds `scilibs` only. The zones below the back end are shifted down by
  one card row, and the back end's label sits at its bottom left.
- **Lines** (FR-120a) are drawn from `OPENING_LINES` (the layout's `lines`) in `opening.ts`,
  without letters or labels; a two-way flow has a head at each end. Besides FR-120a's
  table, `models ↔ scilibs` and `importer ↔ folder` are drawn, as in §3.1.
- **Illustrative traffic** (FR-120a, D-361) is made by `web/src/shell/mocktraffic.ts`, in the
  page: a fixed list of flows (`MOCK_FLOWS`), each a sequence of hops along the opening's
  lines in either direction, with the real letters; a hop's time grows with its line's
  length (0.7 to 2.2 s), the next hop sets off when it arrives, icons on one line keep a gap,
  a flow starts every 1.6 to 2.8 s, at most four at once, chosen at random by weight and
  rarely the same twice running. The flowchart draws them with `Glyph`, as `div.mock-icon`
  (`data-testid="mock-icon"`, `data-mock-letter`) inside an `aria-hidden` layer with no
  pointer events. They never pass through the message bus (`bus`), so `bargeCaptured`,
  `bargeMessages`, the counters and the message strip never see them; no `fetch`, worker or
  Service Worker is involved. `opening.adopt()` calls `mockTraffic.stop()` first: nothing
  new sets off and what is in flight fades out over 0.25 s. With `prefers-reduced-motion`
  none is drawn. While it is drawn the status reads "Opening · illustrative traffic".
- **Wording.** The lead reads: written ourselves, the system is a range of components to
  develop; which of them could be adopted rather than written is not yet decided. No count
  appears (FR-120, FR-124).
- **The table** (FR-123, D-359) has a row for every card of the opening, in the flowchart's
  order (`ROWS` in `opening.ts`); clicking any card highlights its row. After Adopt a column,
  "With OpenSensorHub", ticks the subsystems and says what became of the rest.
- **Open Standards** (FR-123a, D-363, D-364). Below the table, until Adopt, one button,
  `open-standards`. `opening.view` (`'components' | 'standards' | 'opensource'`, a `Store` in `opening.ts`)
  says what the panel shows while the phase is `build`; `showStandards()` and
  `showComponents()` set it and do nothing else: no request, worker, layout or status change,
  and the illustrative traffic runs on. `web/src/detail/StandardsView.tsx` draws the view
  (`data-testid="standards"`, title "Open Standards"): the history (`HISTORY`, an `ol`,
  `standards-history`), the tree (an inline `svg`, `standards-tree`, `role="img"` labelled by
  its `title` and `desc`; each entity a `g` with `data-entity` and `data-part` `p1` or `p2`),
  a sentence relating it to the demonstrator (`standards-here`) and the two buttons,
  `choose-custom` ("Custom Components": `showComponents()`) and `choose-open-source` ("Open Source":
  `showOpenSource()`). `web/src/detail/OpenSourceView.tsx` draws the Open Source view (D-364;
  `data-testid="open-source"`, title "Open Source"): one lead sentence, a short list of facts about
  OpenSensorHub (`OPEN_SOURCE`, `open-source-facts`: who made it, who it was made for, licence, its
  place here; no digits), then one button, `choose-adopt` ("Adopt": `opening.adopt()`). `highlight()` (a card click) and `adopt()` set the view back to
  `components`. A reload starts on `components`. The history's periods and the part numbers
  are the opening's only digits, in this view only.
- **Before Adopt:**
  - `runtime.start()` is **not called**: no worker starts, the relay is not
    registered and nothing is fetched (FR-122);
  - the top bar renders only the title;
  - the status reads "Opening" (with "· illustrative traffic" while that is drawn);
  - the banner is not rendered.
- **Adopt** (D-360) calls `runtime.start()` at once, so the relay, the worker script and, in
  Python, Pyodide and its packages load while the cards merge. The merge is drawn frame by
  frame from one clock (`MERGE_SCHEDULE` in `opening.ts`; `OPENING_MERGE` in `config.ts`)
  over the same React Flow nodes, kept in one order: the opening's lines fade and the
  `server` card appears (0.7 s); each subsystem card in the table's order then travels into
  it, starting 0.42 s after the one before and taking 0.9 s, shrinking about its centre and
  fading as it lands, and `opening.landed` ticks its row; then, over 1.5 s, the other cards
  and the zones move to `layout.json`'s places and the normal arrows, the god's-eye note,
  the key and the status fade in. In all about 6.1 s (`OPENING_MERGE_MS`); with
  `prefers-reduced-motion` the merge is skipped. At its end the phase is `adopted`: the top
  bar shows its controls and the flowchart rescales to the shorter column over 0.5 s.
- **The flowchart stays mounted** from the opening to a started back end (D-360, superseding
  D-332): until the server answers, the status box shows the named startup steps of §13.7,
  the active one's detail, and any stall or failure with what to do; the controls are
  disabled with "Starting: <step>", and the cards open their panels once the server has
  answered. Nothing plays (FR-125a, §13.7).
- **After hand-over** the detail panel keeps the opening panel, with every subsystem ticked
  and no Open Standards button, until a component is clicked, the panel is closed or Overview is pressed
  (FR-125).

## 13. Workers, the page and controls

### 13.1 Workers

| Worker | Runs | Started by |
|---|---|---|
| `backend.worker.ts` | Pyodide: the importer, the data server stand-in, the folder | the page, `?backend=python` |
| `model.worker.ts` ×3, plus one per empty slot used | Pyodide: one model each; its requests go through the relay with its service credentials | the page, Python mode |
| `standin.worker.ts` | TypeScript: everything the back-end worker runs, plus the core models | the page, by default |
| `sw.js` | the relay; forwards requests and streams; no logic (§9.2) | the page |

### 13.2 Messages between the page and the back-end worker

The page sends:
- `start {folderUrl, ...}`;
- `connect`, with a port for the relay;
- `model-connect {model}`;
- `control {action, arg}`;
- `hold {on}` (D-362): the system hold (§4), sent at once after `start` and whenever it
  changes, also to each model worker. It is not a control action: it may arrive before the
  server has started, and is kept until it has.

The worker posts:
- `progress {stage, detail, pct}`;
- `tick {messages, server}` every 100 ms;
- `state {…}`;
- `relay-failed {…}`.

The replay clock is the display client's, in the page (§8); no worker holds it.

### 13.3 Control actions

`restart-server`, `down`, `up`, `field {name, on}`, `profile-lie`, `capture`,
`reset-instance`, `set-role {user, role}`, `state`. Each carries a request `id`, which the
worker's answer echoes (D-167).

There is no `play`, `pause`, `rate` or `freeze`: replay is the display client's (§8), and
Freeze is withdrawn. The system's Pause is the worker message `hold {on}` (§13.2, D-362).

### 13.4 Control state

```
{ server, fields, pending, lie_about_profile,
  folder: [{file, size, modified, status, dataset, pct}],
  datasets: [{id, file, start, end, superseded}],
  models: [{id, label, phase, detail, datastreams, runs: [{dataset, run_id, status, pct}]}],
  accounts: [{user, role}], capture_counts, capture, backend, import_rate, instance }
```

`capture` says whether capture is on (AT-18); `instance` is the shell's own count of server
starts (D-260), shown as "Ready · start n".

### 13.5 Admin stub (FR-115)

The admin stub is the `set-role {user, role}` control action, offered in the control
panel as "OpenSensorHub administration (stand-in)". It changes the delivered
user-to-role assignment, which the server reads on the next request (§9.3).

### 13.6 URL parameters

`?backend=python|standin`, `?sketch=off` and `?hand-made`. `?seed` is withdrawn: the data
folder is fixed. For tests only, `?folder=<relative path>/` points the importer at another
folder of the same site (D-272), and `?idle=<seconds>` shortens the display client's
5-minute idle lock (D-305).

### 13.7 Startup and readiness (FR-125a, NFR-10a)

- **Where.** On a load without the flag, the startup page (the top bar and the steps) is
  shown until the server answers, then the flowchart. After the opening's Adopt the
  flowchart stays, and the steps and any stall are shown in its status box (D-360).
- **Steps.** The loading progress names each step in turn: `relay` (registering the
  Service Worker and waiting until it controls the page), `back end` (the worker and, in
  Python mode, Pyodide), `server` (started and answering), `import` (the silent import of
  Mission A), `models` (each core model ready: registered and subscribed to its commands).
- **Startup ends when each core model is ready** (D-350), not when it has processed Mission A. Processing follows
  (§10.2), and until a dataset's runs are complete the display client says its results are being prepared
  (FR-35b). The startup budget (NFR-10, 30 s in both back ends) is measured to this point, cold and on a reload.
- **The relay.** The page goes on as soon as **this build's** relay controls it: it asks the
  controller for its version, so an older relay left from an earlier deploy (which may not
  forward `api-internal/`) is waited out; the page does not depend on `controllerchange`
  alone. A new `sw.js` calls `skipWaiting()` and `clients.claim()`; because a `skipWaiting()`
  at install is lost if the older relay is still activating, the page also asks a waiting
  relay to `skip-waiting`, every second for a minute (D-354). If no Service Worker controls the page within **10 s**, or
  registration fails (for example, the browser blocks Service Workers), the page says
  which step stalled and what to do (reload; allow the site's storage and Service Workers),
  rather than waiting silently (AT-68).
- **Any step** that takes more than 10 s shows the same kind of message, naming the step.
- **Nothing plays** after startup or Adopt until a user logs in, a dataset is open and Play
  is pressed.
- **Pause system and the drawing speed** (D-362) can act as soon as the top bar's controls
  appear, during startup too; paused, a step's stall time does not count. Pause is disabled
  while a failure demo takes a step ("Wait: a failure demo is taking a step"); a demo
  resumes the system before each step and before "Put everything back".
- **Disabled controls say why** (FR-125a), in a `title` and `aria-describedby`:
  - before startup completes: "Starting: <step>";
  - (until D-362, the replay mirror's "Log in to the display client first" and "Open a
    dataset first": the top bar has no replay control now, and the client's replay bar is
    not shown before login or with no dataset open).

## 14. Open with the OpenSensorHub team (4.7)

The stand-ins behave as the **configured** OpenSensorHub is expected to. Each row is to be
confirmed with the OpenSensorHub team. **OpenSensorHub is the reference** (PR-06): when an
answer comes, this table, FR-06c and both stand-ins are brought into line.

| Item | Stock OpenSensorHub 2.0.4 (findings of 2026-11-25 and 2026-11-26) | Stand-ins now | Wanted |
|---|---|---|---|
| Restricted resources in discovery (FR-93, SRD §15) | Listed; `403` on read | Listed; `403` on read | Not listed (the owner is raising it) |
| Restricting by role | Grants inherit, denies do not; only an allow-list by id restricts | An allow-list, extended at each import (D-222) | Inherited denies, or a maintained allow-list confirmed |
| `DELETE` and `PUT` (FR-28a) | `DELETE` deletes (`204`) for an allowed account | `405` for every account (D-224) | Refused by configuration |
| Push subscriptions with access control on | Closed at once on the public endpoint | Served on `/api-internal`, service accounts only (D-223) | The internal endpoint confirmed for a developed system |
| `WWW-Authenticate` on `401` | `basic` (a browser shows its own dialog) | Sent; the relay drops it (D-226) | Configurable, or dropped by the web server |
| Create only under one's own systems (AT-52) | Top level enforced; subsystems can be created under any system | Enforced | Refused by configuration |
| Another user's workspace (AT-52) | Readable | `403` | Refused |
| The internal endpoint | Any authenticated account reads everything there | Service accounts only | Not reachable from outside the server's host |
| `sender` on a pushed command (FR-112a) | The user id | The user id | Settled (D-152) |
| Role change at once (FR-116) | On the next request | On the next request | Settled (D-151) |
| Bulk import inside the server | Feasible, about 300,000 rows/s (finding of 2026-11-25) | Inside the stand-ins | Settled |
| Restricting by role (D-222, D-348, D-351) | Holds when configured so: descriptions granted whole; contents (observations, commands, status) allowed by id, and every contents form denied for each restricted resource and each system above it; **`useSecureIds`** at start, so ids of different kinds never share strings. AT-32 of 2026-11-27: no restricted observation read, every open one read. Without `useSecureIds` the ids collide, and either restricted contents open (D-348) or open contents close | Descriptions to everyone, contents by role (D-351) | Restriction by resource without an id list to maintain at every import |
| The profile beside the API (FR-41, D-345) | Served only as a static document (`/sensorhub/profile.json`), **without authentication** | At `api/profile.json`, with credentials | Served with credentials beside the API |
| Order of a SWE JSON record's members (D-346) | The schema's order, or `400` | Any order | The stand-ins refuse another order (PR-05) |
