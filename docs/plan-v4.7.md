# Implementation plan: SRD Version 4.7

**Status:** proposed, 2026-11-26. It replaces `plan-v4.6.md`. That plan was carried out
once on the branch `claude/loving-curie-lkx8d3`, then withdrawn after the owner's review,
because the software had drifted too far from `main` in one long branch. What that build
did, its known problems and the review requests are recorded in
`docs/software-changes-v4.6-branch.md`. Its code is at commit **`8157eef`**.

**Starting point:** `main`, whose software is still Version 4.1 with the 4.2 redraw
(`91489be`):
- a live world, and a simulation clock with a speed control;
- the fixed-width logger and the store adapter;
- models that poll for commands;
- `409` on re-creation, and `PUT` to replace results;
- an instance header, and `503` while starting.

The requirement is SRD 4.7, and the contract is `docs/v4-interfaces.md` (4.7).

## 1. How this attempt differs

- **Small pull requests to `main`.** Each phase is one to three PRs, each merged with CI
  green and its PR preview checked by the owner before the next starts. There is no
  long-lived branch.
- **Reuse, checked.** Whole files from `8157eef` are reused where they still fit 4.7
  (§4). Each reused file is read against the 4.7 contract before it is copied, and its
  tests come with it.
- **Two components fewer than 4.6.** There is no replay controller (ADR 0009) and no access
  gateway (ADR 0010). Freeze is gone.
- **Startup first.** The relay and the loading steps are made robust (§13.7) before any
  feature depends on them. The preview is tested on its published path, including with an
  older Service Worker installed. This is where the first build failed in front of the
  owner.

## 2. The size of the gap

| Area | Today (4.1/4.2) | 4.7 | Size | Reuse from `8157eef` |
|---|---|---|---|---|
| Source of data | A live world feeds a fixed-width logger | A **CSV data folder** built at build time: four missions, with CO₂ | L | `backend/barge/datafolder.py`, `scripts/build_data_folder.py`, `test_datafolder.py`: nearly as is |
| Reading the data | The store adapter answers `S` queries | A **CSV importer** module: catalogue, `import`, bulk write, datastreams per dataset | L | `dialect.py`, `importer.py`, `qc.py`, `standin/{csv,importer}.ts` |
| Time | `SimClock` with a speed control | **The display client's own replay clock**; drawing in real time | M | Little: 4.6 put replay on the server |
| Models | Poll for commands; follow the live clock | **Process each dataset on import**; pushed commands; `runs__{ds}` progress | M | Window processing in `backend/models/*`; the runner is new |
| Server behaviour | 4.1 extras | **Behaves as a stock OpenSensorHub**, with D-193..D-199 | M | `api.py`, `standin/api.ts`, `store`, `swe`, `ucum` |
| Security | None | Authentication; roles; **restricted resources listed and refused with 403**; workspaces; service accounts; `/api-internal` | M | `accounts.*`; the permission checks move from the gateway into the stand-ins |
| Display client | Live handshake, text readouts | Login, lock, **Dataset selector popup**, own replay, per-dataset fields and degraded mode, **Favourites popup**, charts | L | Much of `web/src/client/*`, reworked for the clock and popups |
| Shell | 4.2 | New cards and flows, detail panels, failure demos, disabled controls that say why; no Freeze | M | `demos.ts`, detail panels, less replay and gateway |
| Adoption opening | None | `?hand-made`, two rows of five, "a range of subsystem components" | S | `opening.ts`, `OpeningPanel.tsx`, `layout-opening.json`, reworked |
| Contracts and tests | 4.1 masters | Masters, a server-neutral suite, AT-01..AT-70 | M | `contracts/*`, `contract_suite/suite.py`, `standin-check.mjs`, AT-32 tooling, without replay and gateway |

## 3. Phases

Each phase ends with its acceptance tests passing in both back ends, unless marked.

### Phase 0: with the OpenSensorHub team (in parallel, never blocking)

The owner takes interfaces §14 to the OpenSensorHub team:
- hiding restricted resources from discovery;
- inherited denies, or how to maintain an allow-list;
- refusing `PUT` and `DELETE`;
- private workspaces, and refusing subsystems under others' systems;
- the internal endpoint for receivers;
- `WWW-Authenticate`.

Each answer updates §14, FR-06c and both stand-ins (PR-06).

### Phase 1: contracts and the suite

- Masters in `contracts/` for 4.7: OpenAPI of what we need; the profile template without
  replay essentials (FR-40); SWE records for weather, CO₂, the catalogue and `runs`; control
  streams for `import` and each model; data of interest. Regenerate the TypeScript types.
- The server-neutral contract suite (PR-04), with credentials and `403` checks; no replay or
  gateway checks.
- README to 4.7.

### Phase 2: the data folder

- Bring over the generator and its reproducibility gate (AT-28) from `8157eef`. Retire
  `logger.py`, `adapter.py`, `history.py` and `build_history.py`.

### Phase 3: startup and the relay, made robust (FR-125a, NFR-10a)

- Named loading steps; use an existing Service Worker at once; `skipWaiting` and
  `clients.claim`; a stall message after 10 s naming the step.
- Disabled controls say why.
- A Playwright test on the published sub-path (`/barge-monitor/pr/<n>/demo/`), on a first
  load and a reload with an older `sw.js` installed (AT-68).
- This lands before the back-end work, so that every later PR preview starts reliably.

### Phase 4: the stand-ins behave as OpenSensorHub

- Server behaviour of interfaces §9.1, with D-193..D-199.
- Push subscriptions as a streaming fetch, on `/api-internal` for service accounts (§9.2).
- Authentication, accounts, roles, the allow-list, `403` for restricted resources (§9.3).
  The relay drops `WWW-Authenticate`.
- `csmodel.py` and `csmodel.ts`.
- Tests: the contract suite in both back ends; AT-11, AT-29, AT-38, AT-39, AT-49.

### Phase 5: the CSV importer

- The importer module, the catalogue, `import` and `rescan`, supersede and change detection,
  QC on import, and the silent import of Mission A.
- Reset instance.
- Tests: AT-01, AT-03, AT-04, AT-40 to AT-43, AT-54.

### Phase 6: models on import

- The runner of interfaces §10.2: find datasets in the catalogue, declare, process whole
  datasets, publish `runs__{ds}` progress, new runs on settings commands.
- Restricted subsystems for CO₂-derived outputs (FR-112), and FR-112a by `sender` lookup.
- Tests: AT-13 to AT-16, AT-34, AT-56, AT-57, AT-61.

### Phase 7: the display client

- Login, lock and a generic refusal (C5).
- The **Dataset selector popup** (FR-103, FR-127).
- The **own replay clock** and the replay bar (§8.6), polling up to the replay time, and
  "results being prepared" (FR-35b).
- Fields and degraded mode per dataset; datastreams answering `403` are left out (FR-118).
- Charts.
- The **Favourites popup** (§8.5), including compare on elapsed time.
- Tests: AT-07, AT-09, AT-19, AT-33, AT-36, AT-37, AT-44 to AT-53, AT-55, AT-58 to AT-60,
  AT-69, AT-70.

### Phase 8: the shell

- Cards, flows, status, the god's-eye note, detail panels and every failure demo of FR-79a.
- Tests: AT-18, AT-20 to AT-23, AT-25, AT-26, AT-31.

### Phase 9: the adoption opening

- `?hand-made`, two rows of five, the 4.7 wording, the merge, and hand-over into the robust
  startup of Phase 3.
- Tests: AT-62 to AT-67.

### Phase 10: hardening

- Python in a real browser (Pyodide), Playwright end to end in both back ends.
- Startup budgets (NFR-10).
- **AT-32 re-run without the gateway**, against OpenSensorHub configured as §14 allows, with
  the differences reported.
- AT-02 and AT-05.

## 4. Order

```
Phase 0 (OpenSensorHub team) ─────────── in parallel, updates §14 when it answers
Phase 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10
```

| After | Claims shown |
|---|---|
| Phase 5 | C1 |
| Phase 6 | C3 |
| Phase 7 | C2, C4, C5, C6 (the relaxed form) |

## 5. Risks

| Risk | Likelihood | Effect | Mitigation |
|---|---|---|---|
| OpenSensorHub cannot hide restricted resources | High | C6 stays the relaxed claim: names visible, data refused | The owner with the OpenSensorHub team; stated in SRD §15 |
| The allow-list must grow at every import | High | A missed entry exposes CO₂ or hides weather data | Generate it from the systems' unique ids at import; a contract-suite check after each import |
| `DELETE` and others' workspaces not refused by configuration | Medium | FR-28a and AT-52 fail on a real server | Phase 0; AT-32 reports it |
| Startup stalls on the relay | Medium | The owner sees a dead page (as in the first build) | Phase 3 first, with a published-path test |
| Processing every dataset on import is slow in Pyodide | Medium | "Results being prepared" for a long time | Measure in Phase 6; process the open dataset first |
| A long branch drifts again | Medium | Another withdrawal | One phase per PR to `main`, previews checked |
