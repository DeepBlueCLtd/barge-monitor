# Implementation plan: SRD Version 4.5

**Status:** proposed, 2026-11-25. **Starting point:** `main` at `91489be`, which
implements Version 4.1 with the Version 4.2 redraw (D-91, D-92). The code still has a live
world, a simulation clock with a speed control, the fixed-width logger and store adapter,
models that **poll** for commands, `409` on re-creation, `PUT` to replace results, and an
instance header with `503` while starting. Versions 4.3, 4.4 and 4.5 are not built. This
plan covers all three at once.

## 1. The size of the gap

| Area | Today (4.1/4.2) | 4.5 | Size |
|---|---|---|---|
| Source of data | Live world → sensors → fixed-width logger, generated or pre-built (D-34) | Build-time **CSV data folder**, four files, CO₂ columns, read-only | L |
| Reading the data | Store adapter, index, `S` queries at read time | **CSV importer**: catalogue, `import` command, bulk write, per-dataset datastreams | L |
| Time | `SimClock` with speed control, drawing on simulated time | **Replay controller** (a CS system), replay clock, current dataset; drawing in real time; Freeze | L |
| Commands | Models poll `statusCode=PENDING` | **Pushed** to subscribed receivers; sender never waits; receiver validates | M |
| Server behaviour | 4.1 extras (instance id, 503, 409, PUT, readable ids) | **Behave as stock OpenSensorHub** (FR-06c), in both stand-ins | M |
| Results | Replaced by `PUT` | **Appended** under `run_id`, per dataset | M |
| Display client | Handshake, field chips, presets over a live clock | Login, lock, dataset picker, replay bar, per-dataset fields and degraded mode, **data of interest** | L |
| Security | None | **Authentication** on every request and push; **roles**; **restricted** CO₂ resources **hidden**; per-user workspaces; service accounts | L |
| Shell | World zone, speed control, 4.2 flows and demos | Four zones, new components and flows, redaction, god's-eye note, eight new failure demos, Reset instance | M |
| Contracts and tests | 4.1 masters; contract suite tied to the stand-in's ids (0/15 against OpenSensorHub) | "What we need" masters; **server-neutral** suite with credentials; AT-40 to AT-61 | M |

Roughly 60–70 % of the back end and 40 % of the front end is rewritten. Kept as they are:
the relay, the worker hosting, the flowchart and message drawing, the grid of views, the
model editor, the referee, the value-add reveal, and the world and weather generator
(moved to build time).

## 2. Points in the SRD to settle before or during building

Critical review, ordered by how much they could cost if left until later.

1. **A Service Worker cannot carry a WebSocket.** FR-02 sends pushed commands as a
   WebSocket through the relay, but Service Workers do not intercept WebSocket
   connections. *Proposal:* the push channel is a **streaming `fetch`** through the relay
   (one long response per subscription, one JSON line per command), wrapped in a small
   `PushChannel` class with WebSocket's shape. It is drawn as "push", and FR-02's wording
   changes to "a pushed stream, a WebSocket in a developed system". Freeze (FR-92) holds it
   in the relay like any other response.
2. **Browsers cannot set `Authorization` on a WebSocket.** A developed system must send
   credentials another way (a token in the query or subprotocol, or a session cookie).
   This belongs in the authentication spike, item 4.
3. **FR-112a needs the receiver to know the sender's role.** A command pushed by
   OpenSensorHub probably carries no sender identity. It also breaks the SRD's own rule,
   *restriction by resource, never by field*. *Proposal:* give each model a second control
   stream under its **restricted** subsystem that accepts CO₂ sources; the unrestricted one
   has no CO₂ tokens. A weather-only user cannot find the restricted stream (404), so the
   server enforces it and the model does not need the sender's role. AT-57 still holds.
4. **The stand-in must not get ahead of OpenSensorHub (PR-05, PR-06).** FR-06c and FR-93
   ask the stand-in to **hide** restricted resources, but nobody knows yet whether
   OpenSensorHub can. Building C6 before the authentication spike risks showing a server
   that does not exist. That spike is the riskiest item in 4.5, so it runs first (§3).
5. **New datasets versus discovery only at handshake (FR-44).** Importing Mission B
   creates datastreams after the handshake, and FR-43 rebuilds the field list without a
   full handshake. *Proposal:* a **dataset-scoped discovery** on load (the datastreams
   whose output name ends `· <dataset id>`), allowed by an amended FR-44. Without it, the
   client cannot see a dataset it has just imported.
6. **The handshake grows with datasets.** At one drawn request at a time (FR-42a, D-89),
   four datasets with per-dataset model outputs and restricted subsystems could make the
   drawn handshake run for minutes. Item 5's dataset-scoped discovery fixes this too: the
   handshake covers the systems only, and each dataset's datastreams are found on load.
7. **The declared profile (FR-40) becomes a template.** "For every imported dataset"
   means output names with a `<dataset id>` placeholder. `profile.json` and its schema
   change shape.
8. **"Already imported at startup" (FR-15) versus Reset instance and no persistence.**
   With nothing kept between visits, Mission A has to be imported on every page load.
   *Proposal:* import it **silently before the first frame**, without drawing it, and
   say so in the importer's panel. After Reset instance it is not re-imported until a
   page reload.
9. **FR-116 versus Basic authentication.** With credentials checked on every request, a
   change of role takes effect at once, not "at next login". The logout needs a session the
   server can end. The stand-in can do either; the spike decides which one is honest.
10. **Runs and "returning is immediate" (FR-35, FR-87).** Every seek starts a new run, so
    a dataset has many runs. Which one does the client show on return? *Proposal:* the
    latest run for that dataset.
11. **Charts (D-53).** Still open. This plan assumes **charts** (ECharts is already back
    as a dependency, D-95). A text-only fallback for slow laptops is out of scope unless
    you ask for it.
12. **Smaller points:**
    - Mission C's missing column means its record datastream has fewer fields, not a
      `NaN` column.
    - The archive catalogue is public, so a weather-only user can see that files exist.
      FR-21c says it reveals nothing about CO₂; confirm that file names are not sensitive.
    - AT-58 is enforced by a grep in CI for `co2`, `CO₂` and role names under
      `web/src/client`.

## 3. Phases

Each phase ends with its acceptance tests green in both back ends, unless marked, and is
one or two pull requests. Phases 0 and 1 run in parallel.

### Phase 0: spikes and decisions (outside the browser)

- **S-AUTH** (the riskiest item in 4.5). Run against OpenSensorHub 2.0.4 with its security
  module on, extending `backend/spike/osh_spike.py`. Answer the six questions in SRD §15,
  plus §2 items 2, 3 and 9. Record a finding and amend ADR 0005. **Gates Phase 8.**
- **S-IMPORT.** Can a Java module write about 500,000 observations into the store in bulk,
  and how fast? **Does not gate the demonstrator**: the stand-in writes inside itself
  either way. It gates C1's claim, and FR-20a's fallback is already written.
- **Decisions to record** (D-97 onward, after renumbering D-89 to D-96): items 1, 3, 5, 7,
  8, 10 and 11 of §2.

### Phase 1: documents and contracts

- Rewrite `docs/v4-interfaces.md` for 4.5: component ids (`folder`, `importer`, `replay`,
  `server`, `models`, `scilibs`, `client`), flows and letters, resource and output names
  per dataset, restricted subsystems, service accounts, the push channel, the worker
  protocols.
- Masters in `contracts/`:
  - the OpenAPI document of what we need;
  - the profile as a template (§2 item 7);
  - SWE records for the weather, CO₂, catalogue, replay state, replay log and runs;
  - control-stream schemas for `import`, `replay` and each model;
  - the JSON Schema for data of interest (FR-94).
- Regenerate the TypeScript types (NFR-04).
- Renumber the decision log, and update the README to 4.5.
- **Rewrite the contract suite to be server-neutral (PR-04).** It finds resources by
  unique id and output name, takes credentials, and keeps "what we need" separate from
  "what the stand-in also does". Run it once against a stock OpenSensorHub, which gives
  AT-32's first record.

### Phase 2: the data folder, built in CPython

- `scripts/build_data_folder.py` replaces `build_history.py`. It reuses `world.py`,
  `truth.py` and `sensors.py` to write **Mission A** (24 h), **B** (24 h),
  **B re-export** (overlaps B, a few readings differ) and **C** (12 h, without the stern's
  wind speed).
- The files are awkward CSV (FR-17): an odd time epoch and format, units in the headings,
  coded missing values, and bow and stern as column groups.
- **CO₂ in ppm per sensor**, with a QC flag, rising with engine load (under way versus at
  the wharves and locks) (FR-09a).
- One manifest per file. Every random value comes from a named, seeded stream.
- The reproducibility gate (FR-15a, AT-28) runs in CI.
- Retire `logger.py`, `adapter.py`, `history.py`, the `S`/`L` read path and
  `tests/second_store.py`. AT-03 becomes a second CSV dialect.

### Phase 3: the stand-ins behave as OpenSensorHub (both back ends)

- Opaque identifiers.
- `201` with the existing `Location` on re-creation.
- One observation per `POST`.
- `"NaN"` for missing values.
- `PUT` and `DELETE` answer `405`.
- `f=application/swe+json`, with the `Accept` header ignored.
- Paging by `offset`.
- Refusals as HTML pages.
- No instance header and no `503`: **connections are refused while starting**, emulated
  in the relay.
- Command status at `/controlstreams/{id}/status`.
- **The push channel** (§2 item 1). A command with no subscriber is dropped. The sender's
  `POST` is held for about five seconds.
- **Credentials plumbing now**: every request carries `Authorization`, and anything
  without it is refused with `401`. At this stage there is one fixed demo account, so
  later phases never have to retrofit credentials.
- Update `csmodel.py` and `csmodel.ts`:
  - subscribe, then declare ready;
  - commands carry every parameter;
  - the receiver validates and answers `REJECTED`;
  - `201` counts as success;
  - results are appended with a `run_id`, and `PUT` goes;
  - a period of unreachability leads to a resubscription.
- Update the client's `http.ts`: drop `InstanceChanged` and the `503` wait; when the
  server answers again after unreachability, run the handshake again (FR-48).
- Tests: the contract suite in both back ends, AT-29, AT-38, AT-39, AT-11 and AT-49
  (plumbing only).

### Phase 4: the CSV importer and the per-dataset store

- The importer runs as a module inside both stand-ins:
  - it registers (`assetType` Equipment) with a `catalogue` datastream and an `import`
    control stream;
  - `rescan` lists the folder again;
  - it detects size, date and hash changes and marks *superseded*;
  - it keeps overlapping files apart;
  - it maps each file's columns to the declared fields;
  - QC flags are computed on import.
- Mission A is imported silently at startup (§2 item 8).
- Capture draws `S`/`L` to and from the folder, and one `I` per 1,000 rows (FR-67).
- **Reset instance** (FR-50a) asks for confirmation, then empties the store and restarts
  the server.
- Tests: AT-01, AT-03, AT-04 (three days), AT-40 to AT-43, AT-54.

### Phase 5: the replay controller and the two kinds of time

- The replay controller is a CS system (`assetType` Simulation):
  - the `replay` control stream takes load, play, pause, seek, dataset, rate and position;
  - the state datastream is published once per real second while playing, and on every
    change;
  - the replay log records every command applied;
  - the rate bound is the minimum of the models' declared maximums, and a higher rate is
    rejected naming the bound and the model;
  - it pauses at the end of the dataset;
  - a seek starts a new run.
- Remove `SimClock`'s role as the system clock, and the shell's speed control.
- The flowchart draws on **real time** (FR-78). D-89's paced handshake stays in real time.
- **Freeze** in the relay holds every request and push, and stops the replay clock.
- Models:
  - read up to the replay time for the current dataset;
  - publish per dataset under `run_id`;
  - declare their highest replay rate;
  - keep the outputs of other datasets.
- Client polling: once per real second, from the last time received up to the replay
  time, and nothing while paused.
- Tests: AT-33 to AT-37, AT-19 (paused and frozen), AT-15, AT-16 per dataset.

### Phase 6: the display client's datasets and data of interest

- **Dataset picker** over the catalogue: open, import then load, progress, superseded and
  changed marks, and rescan.
- **Dataset-scoped discovery** on load (§2 item 5).
- The field list is rebuilt for each dataset, and **degraded mode is per dataset**
  (Mission C).
- The replay bar shows the dataset's timeline, and reads its state from the state
  datastream.
- Period presets, ending at "whole dataset".
- **Data of interest**, kept in the per-user workspace system (FR-95):
  - save, list, open, remove;
  - compare on **elapsed time**, at the coarser resolution;
  - a resolution that does not exist is refused, naming those that do;
  - a record is greyed after Reset instance, and restored by re-importing the file.
- Analysis takes an unsaved data of interest in its command (FR-35a).
- Tests: AT-07, AT-09, AT-44 to AT-48, AT-60 (weather part).

### Phase 7: authentication and screen lock (C5)

- A login screen, with nothing shown before login.
- Credentials held in memory only.
- The screen locks after 5 minutes idle or on **Lock**: it blanks every view, discards
  the credentials and stops all requests.
- A refused login is generic: it does not say whether the name or the password was wrong.
- Service accounts for the importer, the replay controller and each model.
- Per-user workspaces: no account can read another user's workspace, and service
  accounts write only under their own systems.
- `Authorization` and passwords are shown as `****` in every captured message (FR-16a).
- The two demo accounts are labelled (FR-102, PR-07).
- Tests: AT-19 (before login and while locked), AT-49 to AT-53.

### Phase 8: CO₂ restriction (C6). Gated on S-AUTH

- **CO₂ analyser subsystems** and `co2 · <dataset id>` datastreams. The importer writes
  CO₂ only there.
- Roles in the stand-ins' configuration: Owner, Viewer with emissions, Viewer.
- Permissions are per system and inherited.
- Restricted resources are **absent** for anyone without permission: left out of every
  listing, and `404` by identifier.
- Each model has a **restricted subsystem** for its CO₂-derived outputs and runs-log
  entries, and a restricted control stream (§2 item 3).
- A role change logs the user out (FR-116).
- A model from an empty slot has no CO₂ access unless the owner grants it.
- An account administration stub stands in for OpenSensorHub's (FR-115). Our own screen
  stays excluded (FR-117).
- If S-AUTH shows that OpenSensorHub cannot hide resources, this phase builds the
  **filtering gateway** fallback instead, drawn as a component of its own. It must not be
  hidden inside the stand-in.
- Tests: AT-55 to AT-61. The CI grep for AT-58.

### Phase 9: the shell, panels and failure demos

- Four zones, with the new cards (Data folder, CSV importer, Replay controller) and flows
  (§3.1).
- Flow labels: "push" and "inside the server".
- The status box: the analyst or "locked", the dataset, the replay time and the rate.
- The replay mirror in the top bar.
- The god's-eye note (FR-68a).
- Detail panels: FR-72, FR-91, FR-109 and FR-110, and the overview's lists.
- Failure demos (FR-79a):
  - existing: server down and up, server restart, missing essential, never-seen fields,
    misconfigured server;
  - new: rate too high, wrong password, the screen locks, an overlapping file, a degraded
    dataset, the friend logs in, the friend asks for CO₂.
- VS-24.
- Tests: AT-18, AT-20 to AT-23, AT-25, AT-26, AT-31.

### Phase 10: hardening and delivery

- Startup budgets for each back end, including the silent import of Mission A (NFR-10).
- Playwright end to end in both back ends.
- Run **AT-32** against a stock OpenSensorHub with credentials, recording each difference
  and its fallback.
- AT-02 and AT-05 under CPython, with credentials.
- The site build ships the data folder.
- Update ADR 0005, and add ADRs for replay, import and access control.

## 4. Order and dependencies

```
Phase 0 (S-AUTH, S-IMPORT, decisions) ─────────────────────────────┐
Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → Phase 7 → Phase 8 → Phase 9 → Phase 10
                                                              (gated on S-AUTH) ┘
```

Phase 9's shell work can follow each phase in step rather than wait. The order is chosen
so that the claims become demonstrable in this order:

- after Phase 4: C1 (import);
- after Phase 5: C4 (replay);
- after Phase 6: C2 and C3 (datasets);
- after Phase 7: C5 (authentication);
- after Phase 8: C6 (restriction).

## 5. Risks

| Risk | Likelihood | Effect | Mitigation |
|---|---|---|---|
| OpenSensorHub cannot hide restricted resources | High | C6 needs a gateway, which weakens "as shipped" | S-AUTH first; the gateway is a visible component, not hidden in the stand-in |
| No sender identity on pushed commands | High | FR-112a is unbuildable as written | A restricted control stream (§2 item 3) |
| A bulk-import module is not feasible | Medium | C1 rests on importing over HTTP (about 20 min for 3 days) | FR-20a's fallback, with progress shown honestly |
| Startup budget with a silent import and Pyodide workers | Medium | NFR-10 missed | Measure in Phase 4; ship a pre-imported store snapshot if needed |
| Datastreams multiplying (datasets × models × runs × restricted) | Medium | Handshake and panels slow down | Dataset-scoped discovery; latest run only |
| Scope: three SRD versions at once | High | Long gap before anything is demonstrable | The phases each end demonstrable; Phase 8 can slip without blocking C1 to C5 |
