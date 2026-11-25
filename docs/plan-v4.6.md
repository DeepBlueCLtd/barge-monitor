# Implementation plan: SRD Version 4.6

**Status:** proposed, 2026-11-25. It revises the 4.5 plan with the decisions taken when
4.6 was reviewed (§2).

**Starting point:** `main` at `91489be`. It implements Version 4.1 with the Version 4.2
redraw (D-109, D-110). It still has:
- a live world, and a simulation clock with a speed control;
- the fixed-width logger and the store adapter;
- models that **poll** for commands;
- `409` on re-creation, and `PUT` to replace results;
- an instance header, and `503` while starting.

None of Versions 4.3 to 4.6 is built. This plan covers them all at once.

## 1. The size of the gap

| Area | Today (4.1/4.2) | 4.6 | Size |
|---|---|---|---|
| Source of data | A live world feeds the sensors, which write the fixed-width logger, generated or pre-built (D-34) | A **CSV data folder** built at build time: four files, with CO₂ columns, read-only | L |
| Reading the data | The store adapter and its index answer `S` queries at read time | A **CSV importer**: catalogue, `import` command, bulk write, datastreams per dataset | L |
| Time | `SimClock` with a speed control; drawing runs on simulated time | A **replay controller** (a Connected Systems system) with the replay clock and the current dataset; drawing runs in real time; Freeze | L |
| Commands | Models poll for `statusCode=PENDING` | **Pushed** to subscribed receivers as a stream through the relay; the sender never waits; the receiver validates | M |
| Server behaviour | The 4.1 extras: instance id, `503`, `409`, `PUT`, readable ids | **Behaves as a stock OpenSensorHub** (FR-06c), in both stand-ins | M |
| Results | Replaced by `PUT` | **Appended** under a `run_id`, per dataset; the latest run is shown | M |
| Display client | Handshake, field chips and presets over a live clock; text readouts (D-53) | Login, lock, dataset picker, replay bar, fields and degraded mode per dataset, **data of interest**, **charts** | L |
| Security | None | **Authentication** on every request and push; **roles**; restricted CO₂ resources **hidden**; a workspace per user; service accounts | L |
| Shell | World zone, speed control, 4.2 flows and failure demos | Four zones; new components and flows; credentials redacted; the god's-eye note; eight new failure demos; Reset instance | M |
| **Adoption opening** | None | `?hand-made`: eight subsystems, then Adopt, then hand-over | M |
| Contracts and tests | The 4.1 masters; a contract suite tied to the stand-in's ids (0 of 15 against OpenSensorHub) | Masters of what we need; a **server-neutral** suite with credentials; AT-40 to AT-66 | M |

Roughly 60–70 % of the back end and 40 % of the front end will be rewritten. These stay
as they are:
- the relay and the worker hosting;
- the flowchart, the message drawing and the seeded hand-drawn outlines;
- the views grid and the model editor;
- the referee and the value-add reveal;
- the world and weather generator, which moves to build time.

## 2. Decisions settled in review

| # | Question | Decision | Where in the SRD |
|---|---|---|---|
| 1 | Ticks after Adopt | Every subsystem is ticked; what is unproven goes in §15 and the ADR, not on screen | FR-124, §16 |
| 2 | Wording of "Build it ourselves" | Kept as it is | FR-123 |
| 3 | A pointer to the costs | None: the opening shows savings only | §16 |
| 4 | What runs before Adopt | **Nothing.** The back end starts at hand-over | FR-122, FR-125 |
| 5 | Flows in the opening | Each flow goes to the subsystem it belongs to, plus the lines between subsystems | FR-120a |
| 6 | Stand-in banner during the opening | Hidden until hand-over | FR-122 |
| 7 | Counts on screen | None: "covers all of these" | FR-124 |
| 8 | What hand-over must match | Everything but the detail panel | FR-125, AT-65 |
| 9 | The wait after Adopt | Hand-over at once, then the usual loading progress | FR-125 |
| 10 | Layout of the opening | The back-end band in two rows (six and five), cards at normal size | FR-120 |
| 11 | How push travels | A **streaming fetch** through the relay, shaped like a WebSocket | FR-02, FR-02a |
| 12 | FR-112a (the receiver checks the sender's role) | Kept; **the authentication spike decides** the mechanism | FR-112a |
| 13 | Datasets imported after the handshake | A **full handshake** after each import | FR-44 |
| 14 | Mission A at startup | Imported **silently on every load**, not drawn | FR-15 |
| 15 | Profile shape | A **template**, with a `{dataset}` placeholder | FR-40a |
| 16 | FR-116 (when a role change takes effect) | **The authentication spike decides**; the stand-in follows it | FR-116 |
| 17 | Runs on returning to a dataset | The **latest run** | FR-35 |
| 18 | Charts | **Charts**; D-53 is superseded, because slow laptops are not a target | FR-80 |

**Still open, with their costs:**
- **Decision 13.** A full handshake grows with each dataset imported, and it is drawn one
  request at a time. It will get slower on screen as datasets accumulate. A handshake
  scoped to the dataset is the alternative, recorded in SRD §15.
- **Decision 4.** In Python mode the viewer waits for Pyodide after Adopt.
- **Decisions 12 and 16** rest on the authentication spike. Until it reports, Phase 8
  builds FR-112a behind an interface that can take either mechanism.
- **Decision 1.** The opening shows Permissions and bulk import as covered while both
  spikes are still open. Stakeholders who hear about the spikes elsewhere may challenge
  that.

## 3. Phases

Each phase ends with its acceptance tests passing in both back ends, unless marked, and is
one or two pull requests. Phases 0 and 1 run in parallel. Phase 9a needs no back end and
can start at any time.

### Phase 0: spikes and decisions, outside the browser

- **S-AUTH**, the riskiest item. Run it against OpenSensorHub 2.0.4 with its security
  module on, by extending `backend/spike/osh_spike.py`. It must answer:
  - SRD §15's six questions;
  - how credentials reach a WebSocket;
  - **how a receiver learns the sender's role (FR-112a)**;
  - **whether a role change takes effect at once or at the next login (FR-116)**.

  Record the finding and amend ADR 0005. **Phase 8 waits for it.**
- **S-IMPORT.** Can a Java module bulk-write about 500,000 observations, and how fast? It
  gates C1's claim, not the demonstrator: the stand-in writes inside itself either way.
- **Recording decisions.** Done: the duplicated D-89 to D-96 are now D-107 to D-114, and
  the decisions of §2 are D-115 onwards (D-121 supersedes D-53).

### Phase 1: documents and contracts

- **Interfaces document.** Rewrite `docs/v4-interfaces.md` for 4.6:
  - component ids: `folder`, `importer`, `replay`, `server`, `models`, `scilibs` and
    `client`, plus the eight subsystem ids used only in the opening;
  - flows and letters;
  - names per dataset, and the restricted subsystems;
  - service accounts;
  - the push stream (FR-02a);
  - the worker protocols.
- **Masters** in `contracts/`:
  - the OpenAPI document of what we need;
  - the profile as a template (FR-40a);
  - SWE records for weather, CO₂, the catalogue, the replay state, the replay log and runs;
  - control-stream schemas for `import`, `replay` and each model;
  - the data-of-interest JSON Schema.

  Regenerate the TypeScript types from them.
- **README** to 4.6.
- **A server-neutral contract suite (PR-04).** It finds resources by unique id and output
  name and carries credentials. Run it once against a stock OpenSensorHub.

### Phase 2: the data folder, in CPython

- `scripts/build_data_folder.py` replaces `build_history.py`. It reuses `world.py`,
  `truth.py` and `sensors.py` to write:
  - **Mission A**;
  - **Mission B**;
  - **Mission B re-export**;
  - **Mission C**, without the stern's wind speed.
- The CSV is awkward, and CO₂ is in ppm, following engine load.
- One manifest per file, and seeded randomness throughout. The reproducibility gate
  (AT-28) runs in CI.
- **Retire:**
  - `logger.py`, `adapter.py` and `history.py`;
  - the `S`/`L` read path;
  - `tests/second_store.py`, since AT-03 becomes a second CSV dialect.

### Phase 3: the stand-ins behave as OpenSensorHub, in both back ends

- **Server behaviour:**
  - opaque ids;
  - `201` with the existing `Location`;
  - one observation per `POST`;
  - `"NaN"` for a missing value;
  - `405` for `PUT` and `DELETE`;
  - the format chosen by `f=application/swe+json`;
  - paging by `offset`;
  - refusals as HTML pages;
  - no instance header and no `503`: connections are refused while starting, emulated in
    the relay;
  - command status at `/controlstreams/{id}/status`.
- **The push stream (FR-02a).** A `PushChannel` class with WebSocket's interface, over a
  streaming response through the relay:
  - Freeze holds it;
  - a command with no subscriber is dropped;
  - the sender's `POST` is held for about five seconds.
- **Credentials plumbing now.** Every request and every push subscription carries
  credentials; without them the answer is `401`. A single demo account is enough at this
  stage.
- **`csmodel.py` and `csmodel.ts`:**
  - subscribe, then declare ready;
  - send every parameter;
  - the receiver validates and answers `REJECTED`;
  - accept `201`;
  - append under a `run_id`;
  - resubscribe after any unreachability.
- **The client's `http.ts`:**
  - drop `InstanceChanged` and the wait on `503`;
  - after unreachability, repeat the handshake.
- **Tests:** the contract suite in both back ends; AT-29, AT-38, AT-39, AT-11, and AT-49's
  plumbing.

### Phase 4: the CSV importer and a store per dataset

- **The importer**, a module inside both stand-ins:
  - registers with a `catalogue` datastream and an `import` control stream;
  - `rescan`;
  - change and supersede detection;
  - overlapping files kept separate;
  - the column mapping;
  - QC flags on import.
- **Mission A imported silently** before the server takes requests, without being drawn,
  and noted in the importer's panel. Measure its cost against NFR-10.
- **Capture:** `S`/`L` to and from the folder, and one `I` per 1,000 rows.
- **Reset instance**, with confirmation.
- **Tests:** AT-01, AT-03, AT-04, AT-40 to AT-43, AT-54.

### Phase 5: the replay controller, and the two kinds of time

- **The replay controller:**
  - the `replay` control stream (load, play, pause, seek);
  - the state datastream, once per real second while playing and on every change;
  - the replay log;
  - the rate bound from the slowest model;
  - pause at the end of the dataset;
  - a new run on seek.
- **Clock:** remove `SimClock` as the system clock, and the shell's speed control. Draw
  on real time (FR-78). Freeze in the relay stops the replay clock too.
- **Models:**
  - read up to the replay time of the current dataset;
  - publish per dataset under a `run_id`;
  - declare their highest replay rate;
  - keep the results of other datasets.
- **Client polling:** once per real second, up to the replay time, and nothing while
  paused.
- **Tests:** AT-33 to AT-37, AT-19 (paused and frozen), AT-15, and AT-16 per dataset.

### Phase 6: datasets, data of interest and charts in the display client

- **Dataset picker**: open, import then load, progress, marks, rescan.
- **A full handshake after each completed import (FR-44).** Measure the drawn handshake
  with all four missions imported, and report it.
- **Per dataset:**
  - field list;
  - degraded mode (Mission C);
  - profile templates checked on load (FR-40a);
  - the latest run shown on return.
- **Replay bar** driven by the state datastream; period presets.
- **Data of interest** in the user's workspace:
  - save, list, open, remove;
  - compare on elapsed time;
  - refuse a resolution that does not exist;
  - grey out a record after Reset instance, and restore it on re-import.
- **Analysis takes the current selection** as an unsaved data of interest.
- **Charts** (FR-57 to FR-62) on ECharts, replacing D-53's text readouts.
- **Tests:** AT-07, AT-09, AT-44 to AT-48, AT-60 (the weather part).

### Phase 7: authentication and screen lock (C5)

- **Login screen**; credentials held in memory only.
- **Lock** on idle or on the button: views blanked, credentials discarded, requests
  stopped.
- **A generic refusal** on a failed login.
- **Accounts behind the scenes:**
  - service accounts;
  - per-user workspaces, isolated from each other;
  - credentials redacted in captured messages;
  - the labelled demo accounts.
- **Tests:** AT-19 (before login and while locked), AT-49 to AT-53.

### Phase 8: CO₂ restriction (C6), waiting for S-AUTH

- **CO₂ analyser subsystems**, and `co2 · <dataset id>` datastreams.
- **The three roles**; permissions per system, inherited by datastreams and control
  streams.
- **Hiding:** a restricted resource is absent, and `404` by identifier.
- **Restricted model subsystems**, holding CO₂-derived outputs and their runs-log entries.
- **FR-112a and FR-116**, by whatever mechanism S-AUTH finds.
- **Models in empty slots** get no CO₂ unless granted.
- **An administration stub** standing in for OpenSensorHub's.
- **If OpenSensorHub cannot hide resources**, build the filtering gateway as a component
  of its own, shown in the flowchart. It is never hidden inside the stand-in.
- **Tests:** AT-55 to AT-61, and the CI grep for AT-58.

### Phase 9: the shell, detail panels and failure demos

- **The flowchart's cards and flows:**
  - four zones;
  - the new cards and flows;
  - "push" and "inside the server" labels.
- **The status box and the replay mirror.**
- **The god's-eye note.**
- **Detail panels:** FR-72, FR-91, FR-109 and FR-110.
- **Failure demos:** all of FR-79a.
- **VS-24.**
- **Tests:** AT-18, AT-20 to AT-23, AT-25, AT-26, AT-31.

### Phase 9a: the adoption opening (§9.8), independent of the back end

- **`?hand-made`**, read once at load.
- **A second fixed layout:**
  - eight subsystem cards as equals of the importer, the replay controller and Models;
  - the back-end band in two rows of six and five, with the zones below shifted down;
  - the FR-120a flows as plain lines.
- **Gating before Adopt:**
  - the top-bar controls and the stand-in banner are not rendered;
  - **no worker starts**;
  - capture is off;
  - nothing is gold, and the reveal is disarmed.
- **The opening panel:**
  - the switch;
  - the FR-120 table, with a row highlighted when its card is clicked;
  - "Written by us either way".
- **Adopt:**
  - a merge animation of about 1.5 s, which moves the seeded outlines without redrawing
    them (VS-25); with reduced motion it is immediate;
  - the table reads "covers all of these", every row ticked;
  - hand-over to FR-77's layout; the controls and banner appear; the back end starts with
    its usual progress;
  - the panel keeps the savings until the viewer clicks a component or closes it.
- **Tests:** AT-62 to AT-66. AT-64 is automated with bounding boxes and computed styles,
  with a manual "looks right" check as in D-51.
- It can start now, against the 4.2 cards, with placeholders for the importer and the
  replay controller. It is finished once Phases 4 and 5 add the real cards.

### Phase 10: hardening and delivery

- **Startup budgets** (NFR-10), including the silent import and a start after Adopt.
- **Playwright end to end**, in both back ends, with and without `?hand-made`.
- **AT-32**, against a stock OpenSensorHub with credentials.
- **AT-02 and AT-05**, in CPython.
- **The site ships the data folder.**
- **ADRs:** update ADR 0005, and add ADRs for replay, import and access control.

## 4. Order and dependencies

```
Phase 0 (S-AUTH, S-IMPORT, decisions) ─────────────────────────────┐
Phase 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 (gated on S-AUTH) → 9 → 10
Phase 9a ── any time; finished after 5 ──────────────────────────────┘
```

When each claim can first be shown:

| After | Claims shown |
|---|---|
| Phase 4 | C1 |
| Phase 5 | C4 |
| Phase 6 | C2, C3 |
| Phase 7 | C5 |
| Phase 8 | C6 |

## 5. Risks

| Risk | Likelihood | Effect | Mitigation |
|---|---|---|---|
| OpenSensorHub cannot hide restricted resources | High | C6 needs a gateway, which weakens "as shipped"; the opening's ticked Permissions overstates it | S-AUTH first; a visible gateway component |
| A receiver cannot learn the sender's role | High | FR-112a cannot be built as written | S-AUTH decides; the fallback is a restricted control stream per model |
| A bulk-import module is not feasible | Medium | C1 rests on importing over HTTP | FR-20a's fallback, with progress shown honestly |
| The full handshake grows with each dataset | Medium | Slow on screen after several imports | Measured in Phase 6; a handshake scoped to the dataset as the alternative (SRD §15) |
| Startup time: silent import, Pyodide, a start after Adopt | Medium | NFR-10 missed; a visible wait after Adopt | Measured in Phases 4 and 9a; a pre-imported snapshot if needed |
| Datastreams multiply: datasets × models × runs × restricted | Medium | Slow handshake and panels | The latest run only; measure |
| Three and a half SRD versions at once | High | A long gap before anything can be shown | Each phase ends demonstrable; 9a can be shown early; Phase 8 can slip without blocking C1 to C5 |
