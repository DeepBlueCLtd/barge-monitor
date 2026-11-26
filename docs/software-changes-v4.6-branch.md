# Software changes made on `claude/loving-curie-lkx8d3` (withdrawn)

**Status:** record only. This branch implemented SRD 4.6 on top of `main` (`91489be`, the 4.1/4.2 code).
The product owner withdrew the software after review, on 2026-11-26, because it had drifted too far
from the baseline. The software was reverted on this branch, and only the documentation was kept.
The changes are to be made again on a new branch, using this record, the SRD, `docs/plan-v4.6.md`,
`docs/v4-interfaces.md` and `docs/decisions-log.md`.

**Where the withdrawn code is:** commit **`8157eef`** on this branch (the last commit before the
revert). To look at it or reuse parts:
`git show 8157eef:<path>`, or `git checkout 8157eef -- <path>`.

**Size:** 162 software files changed against `main`, with 20,783 lines added and 9,456 removed.
The appendix lists every file.

---

## 1. What was built, by plan phase

### Phase 0: spikes against stock OpenSensorHub 2.0.4
- **S-IMPORT:** bulk import as a server module is feasible, at about 300,000 rows/s, through internal
  classes that need a retest on each upgrade. See `docs/findings/FINDING-2026-11-25-opensensorhub-bulk-import.md`.
  The code was in `backend/spike/import-module/`.
- **S-AUTH:** OpenSensorHub refuses restricted resources with 403 and does not hide them, and denies are not
  inherited. That led to an access gateway (D-150..D-153). See
  `docs/findings/FINDING-2026-11-25-opensensorhub-auth.md`. The code was in `backend/spike/osh_auth_spike.py`.

### Phase 1: contract and masters
- `contracts/profile.json` became a **template**: `{dataset}` in a datastream, with `scope` either `dataset` or `fixed`.
  It came with `profile.schema.json` and the new `contracts/schemas/data-of-interest.json`.
- `contracts/openapi.json` was regenerated with the `searchMembers` parameter and request content types (D-193, D-194).
- The shared contract suite (`backend/contract_suite/suite.py`) checks `need` (12) and `standin`
  (8). It ran against the Python back end, the TypeScript stand-in and stock OpenSensorHub (AT-32).

### Phase 2: the data folder
- `backend/barge/datafolder.py` and `scripts/build_data_folder.py` (`--check` for byte-identical rebuilds,
  AT-28) generate four missions in the awkward logger dialect:
  - **Mission A**, **Mission B**, a re-export of **Mission B**, and **Mission C** without one column;
  - the dialect: `;` separators, decimal comma, half-seconds since 1994, knots, tenths of °C, `-9999` and `VRB`, CRLF;
  - CO₂ in ppm, following engine load.
- It replaced `scripts/build_history.py` and the 4.1 logger store.

### Phases 3–8: back ends, importer, replay, client, access, CO₂
Two back ends, both passing the same contract suite:
- **Python** (`backend/barge/*`), run under CPython and in Pyodide:
  - `dialect.py` and `importer.py` (the CSV importer, with a `catalogue` datastream and an `import` control stream);
  - `qc.py` (QC flags; CO₂ 250–5000 ppm with a 60 ppm spike test, D-144);
  - `replay.py` (the replay controller: `replay` control stream, `state` with `models_ready`, `log`);
  - `accounts.py` and `gateway.py` (Basic authentication, roles, hiding restricted resources);
  - `ucum.py`; `api.py` (the Connected Systems stand-in); `runtime.py`; `bridge.py` (the Pyodide bridge).
- **TypeScript stand-in** (`web/src/standin/*`, `web/src/workers/standin.worker.ts`): the same
  components, plus `standin-check.mjs` (111 checks).
- **Models** (`backend/models/*`, `web/src/standin/models/*`): Data cleanse, Summaries and Analysis.
  They register over HTTP, process whole windows aligned to the dataset's start (D-126, D-129), and
  declare `max_rate`. Each model ran as its own service account (`svc-*`).
- **Relay** (`web/public/sw.js`, `web/src/push.ts`): a Service Worker. Pushed commands travel as a
  streaming fetch of NDJSON (FR-02a).
- **Display client** (`web/src/client/*`, rewritten):
  - login with a generic refusal; credentials held in memory only; lock on idle or by button;
  - a paced handshake against the profile template, repeated in full after each import;
  - a dataset picker with import progress, load and rescan;
  - a replay bar and polling once a second;
  - four ECharts views, with fields per dataset and degraded mode;
  - data of interest kept in a server-side workspace;
  - clustering, with the selection sent as a `doi`.
- **CO₂ restricted per role:** owner, friend and analyst accounts; a role change takes effect at the next
  request (D-151).

### Phase 9: shell
- **Shell parts:** a status box, a top-bar replay mirror, Freeze, and a control panel:
  - capture;
  - field toggles;
  - the misconfigured-server switch;
  - Reset instance with a confirmation;
  - a stand-in of OpenSensorHub's administration for `set-role`.
- **Panels and demos:** a detail panel for each component, and 12 failure demos (`web/src/shell/demos.ts`).
- **Logging:** the message strip redacts credentials.

### Phase 9a: the opening (`?hand-made`)
- `web/src/shell/opening.ts`, `layout-opening.json` and `web/src/detail/OpeningPanel.tsx`:
  - the data server drawn as subsystem cards, in a back-end band of two rows;
  - a switch: Build it ourselves / Adopt OpenSensorHub;
  - the cards merge into the server card on Adopt;
  - the "written by us either way" list.
- `scripts/site.html` linked to `demo/?hand-made` as "Start from “before”".

### Phase 10: hardening
- **Python in a real browser:** the Python back end ran in Pyodide in headless Chromium. Playwright
  passed 21/21 in each mode (`E2E_BACKEND=python`, `web/e2e/backend.ts`). Fixes along the way: model
  workers given `JsNull`, status reports without an `id`, the clustering `doi.dataset` shape, and the
  names of Analysis's run range.
- **Restart handling (D-185, D-186):** after a restart, Python answers only the models for up to about 11 s.
- **Startup times** (budget 30 s):

  | Back end | Server running | Models ready |
  |---|---|---|
  | Python | about 7 s | about 10–11 s |
  | Stand-in | about 0.4 s | about 1.2 s |

- **AT-32** against stock OpenSensorHub 2.0.4: 12/12 `need` and 8/8 `standin` checks, after
  D-193..D-200. The tooling was `backend/independent/at32_osh.py`, `osh_server.py`, `osh_gateway.py` and
  `at32_delete_probe.py`.
- **AT-05:** OSHConnect-Python browses the server (`backend/independent/oshconnect_browse.py`).
- **CI and Pages:** the `python`, `web` and `independent-clients` jobs (`.github/workflows/ci.yml`); `pages.yml`
  builds the data folder; `web/scripts/assemble-site.mjs` accepts `--no-pyodide`.

## 2. Decisions taken while implementing

All of these are in `docs/decisions-log.md`, which is kept. The ones that shape the software most:

| Range | Subject |
|---|---|
| D-115..D-128 | The SRD 4.6 interview: opening, replay, import, profile template, charts |
| D-129..D-149 | The two back ends: window edges, catalogue folding, edge answers, CO₂ QC |
| D-150..D-153 | After S-AUTH: the access gateway, role changes at once, sender lookup, removing `WWW-Authenticate` |
| D-160..D-173 | Display client and shell: profile-claim check, pacing, control promises |
| D-180..D-186 | Python mode in the browser; restart hold |
| D-190..D-201 | AT-32: the gateway against OpenSensorHub; contract changes D-193..D-200, approved and taken |
| D-210 | The misconfigured-server demo drops a fixed essential and is refused |

## 3. Known problems with the withdrawn code

- **Startup can stall in the deployed preview** at "registering the seam relay (Service Worker)", with the
  server stuck at Starting. All control-bar buttons then stay disabled. Seen in Brave on Windows; not reproduced or fixed.
- Disabled buttons do not say why.
- After a restart, the shell briefly shows "Running" while the client sees the server as unreachable.
- A user's own model without a control stream may stay unlisted after a restart.
- The stand-ins accept `"NaN"` in a Count field, which OpenSensorHub refuses.
- The UCUM check covers a table of common units only.
- AT-32 needs OpenSensorHub built from source, so it is not in CI.
- AT-04 was measured on one day of data, not three. AT-16 was checked under CPython only. AT-37 cannot test
  100×.

## 4. Requested in review, not implemented

These came after the owner viewed the preview on 2026-11-26. A rework was started and stopped before
any of it was merged. Carry them into the new branch and into the SRD.

1. **Opening wording:** the data server is "a range of subsystem components to develop", among
   them those shown, not "eight subsystems".
2. **Remove the access gateway for now.** Clients talk to OpenSensorHub directly. Restricted resources are
   **listed and refused with 403**, as stock OpenSensorHub does. FR-93 is relaxed until the owner and the
   OpenSensorHub team agree on hiding them in discovery. Note: on the delete probe, stock
   OpenSensorHub *allowed* the owner and users to delete; refusing replace and delete then has to be
   configured in OpenSensorHub.
3. **Replay in the display client:** no replay controller on the server. Models process each dataset
   as soon as it is imported, and each client keeps its own play/pause/rate/seek clock.
4. **Remove Freeze/Unfreeze**; Play and Pause cover it.
5. **Adopt bug:** after Adopt, the demonstrator appeared already running with the controls disabled. See the
   Service Worker stall in §3.
6. **Dataset selector as a popup:**
   - a header button shows the current dataset;
   - the popup has the file list, statuses, Import, Load and Rescan;
   - import progress stays visible on the button.
7. **Data of interest as a "Favourites" popup:**
   - a star icon button opens it;
   - it shows the current data window, to save with a label, and the saved list.

## 5. Advice for the re-implementation

- Start from `main`. Apply the SRD, plus §4 above, in small PRs, with CI green on each.
- Reuse whole files from `8157eef` where they still fit. The data-folder generator, CSV dialect, QC,
  importer and contract suite are the most self-contained. Check each one against §4 before copying.
- Decide §4 items 2 and 3 first. They remove two components and change the contract, the models and
  the client.

## Appendix: every software file changed against `main`

Status is relative to `main` at `91489be`. The code is at commit `8157eef` on this branch.


### `(root)`

| Change | File |
|---|---|
| modified | `.gitignore` |
| modified | `README.md` |

### `.github`

| Change | File |
|---|---|
| modified | `.github/workflows/ci.yml` |
| modified | `.github/workflows/pages.yml` |

### `backend/barge`

| Change | File |
|---|---|
| added | `backend/barge/accounts.py` |
| deleted | `backend/barge/adapter.py` |
| modified | `backend/barge/api.py` |
| modified | `backend/barge/asgi.py` |
| modified | `backend/barge/bridge.py` |
| modified | `backend/barge/clock.py` |
| modified | `backend/barge/config.py` |
| added | `backend/barge/datafolder.py` |
| added | `backend/barge/dialect.py` |
| modified | `backend/barge/fields.py` |
| added | `backend/barge/folder.py` |
| added | `backend/barge/gateway.py` |
| deleted | `backend/barge/history.py` |
| added | `backend/barge/importer.py` |
| modified | `backend/barge/local_models.py` |
| deleted | `backend/barge/logger.py` |
| added | `backend/barge/qc.py` |
| deleted | `backend/barge/registry.py` |
| added | `backend/barge/replay.py` |
| modified | `backend/barge/runtime.py` |
| deleted | `backend/barge/sensors.py` |
| added | `backend/barge/serve.py` |
| deleted | `backend/barge/server.py` |
| added | `backend/barge/store.py` |
| modified | `backend/barge/swe.py` |
| modified | `backend/barge/tap.py` |
| added | `backend/barge/times.py` |
| added | `backend/barge/ucum.py` |

### `backend/contract_suite`

| Change | File |
|---|---|
| modified | `backend/contract_suite/suite.py` |

### `backend/independent`

| Change | File |
|---|---|
| added | `backend/independent/at32-delete-results.json` |
| added | `backend/independent/at32-osh-results.json` |
| added | `backend/independent/at32_delete_probe.py` |
| added | `backend/independent/at32_osh.py` |
| added | `backend/independent/osh_gateway.py` |
| added | `backend/independent/osh_server.py` |
| modified | `backend/independent/oshconnect_browse.py` |

### `backend/models`

| Change | File |
|---|---|
| modified | `backend/models/analysis.py` |
| modified | `backend/models/csmodel.py` |
| modified | `backend/models/data_cleanse.py` |
| modified | `backend/models/example_new_model.py` |
| modified | `backend/models/summaries.py` |

### `backend/spike`

| Change | File |
|---|---|
| modified | `backend/spike/README.md` |
| added | `backend/spike/auth-results.json` |
| added | `backend/spike/import-module/README.md` |
| added | `backend/spike/import-module/build.sh` |
| added | `backend/spike/import-module/gen_csv.py` |
| added | `backend/spike/import-module/importer-module.json` |
| added | `backend/spike/import-module/src/main/java/org/bargemonitor/osh/importer/CsvImportConfig.java` |
| added | `backend/spike/import-module/src/main/java/org/bargemonitor/osh/importer/CsvImportModule.java` |
| added | `backend/spike/import-module/verify_import.py` |
| added | `backend/spike/import-results.json` |
| added | `backend/spike/osh-config-auth.json` |
| added | `backend/spike/osh_auth_spike.py` |

### `backend/tests`

| Change | File |
|---|---|
| modified | `backend/tests/conftest.py` |
| modified | `backend/tests/helpers.py` |
| added | `backend/tests/second_dialect.py` |
| deleted | `backend/tests/second_store.py` |
| deleted | `backend/tests/test_acceptance.py` |
| added | `backend/tests/test_bridge.py` |
| modified | `backend/tests/test_contract_standin.py` |
| modified | `backend/tests/test_contract_uvicorn.py` |
| added | `backend/tests/test_control_args.py` |
| added | `backend/tests/test_datafolder.py` |
| added | `backend/tests/test_import.py` |
| added | `backend/tests/test_models.py` |
| modified | `backend/tests/test_ports.py` |
| added | `backend/tests/test_replay.py` |
| added | `backend/tests/test_server.py` |
| deleted | `backend/tests/test_store.py` |

### `contracts`

| Change | File |
|---|---|
| modified | `contracts/openapi.json` |
| modified | `contracts/profile.json` |
| modified | `contracts/profile.schema.json` |
| added | `contracts/schemas/data-of-interest.json` |

### `scripts`

| Change | File |
|---|---|
| added | `scripts/build_data_folder.py` |
| deleted | `scripts/build_history.py` |
| modified | `scripts/export_openapi.py` |
| modified | `scripts/site.html` |

### `web`

| Change | File |
|---|---|
| modified | `web/package.json` |
| modified | `web/playwright.config.ts` |

### `web/e2e`

| Change | File |
|---|---|
| added | `web/e2e/backend.ts` |
| modified | `web/e2e/demonstrator.spec.ts` |
| added | `web/e2e/opening.spec.ts` |

### `web/public`

| Change | File |
|---|---|
| modified | `web/public/sw.js` |

### `web/scripts`

| Change | File |
|---|---|
| modified | `web/scripts/assemble-site.mjs` |
| added | `web/scripts/standin-check.mjs` |
| modified | `web/scripts/standin-server.mjs` |

### `web/src/client`

| Change | File |
|---|---|
| modified | `web/src/client/DisplayClient.tsx` |
| added | `web/src/client/discovery.ts` |
| added | `web/src/client/fields.ts` |
| deleted | `web/src/client/handshake.ts` |
| modified | `web/src/client/http.ts` |
| modified | `web/src/client/plan.ts` |
| modified | `web/src/client/session.ts` |
| modified | `web/src/client/views/PanelGrid.tsx` |
| modified | `web/src/client/views/chart.tsx` |
| modified | `web/src/client/views/views.tsx` |

### `web/src/config.ts`

| Change | File |
|---|---|
| modified | `web/src/config.ts` |

### `web/src/detail`

| Change | File |
|---|---|
| added | `web/src/detail/BackEndDetails.tsx` |
| modified | `web/src/detail/ClientDetail.tsx` |
| modified | `web/src/detail/ComponentDetail.tsx` |
| modified | `web/src/detail/DetailPanel.tsx` |
| modified | `web/src/detail/MessageStrip.tsx` |
| modified | `web/src/detail/ModelActivity.tsx` |
| modified | `web/src/detail/ModelsDetail.tsx` |
| added | `web/src/detail/OpeningPanel.tsx` |
| modified | `web/src/detail/Overview.tsx` |
| modified | `web/src/detail/ServerDetail.tsx` |

### `web/src/main.tsx`

| Change | File |
|---|---|
| modified | `web/src/main.tsx` |

### `web/src/push.ts`

| Change | File |
|---|---|
| added | `web/src/push.ts` |

### `web/src/shell`

| Change | File |
|---|---|
| modified | `web/src/shell/App.tsx` |
| modified | `web/src/shell/ControlPanel.tsx` |
| modified | `web/src/shell/Demos.tsx` |
| modified | `web/src/shell/Flowchart.tsx` |
| modified | `web/src/shell/StatusBox.tsx` |
| deleted | `web/src/shell/clock.ts` |
| modified | `web/src/shell/components.ts` |
| added | `web/src/shell/demoAccounts.ts` |
| modified | `web/src/shell/demos.ts` |
| added | `web/src/shell/drawclock.ts` |
| modified | `web/src/shell/geometry.ts` |
| added | `web/src/shell/layout-opening.json` |
| modified | `web/src/shell/layout.json` |
| modified | `web/src/shell/messages.ts` |
| added | `web/src/shell/opening.ts` |
| modified | `web/src/shell/palette.ts` |
| modified | `web/src/shell/reveal.ts` |
| modified | `web/src/shell/runtime.ts` |

### `web/src/standin`

| Change | File |
|---|---|
| added | `web/src/standin/accounts.ts` |
| deleted | `web/src/standin/adapter.ts` |
| modified | `web/src/standin/api.ts` |
| modified | `web/src/standin/constants.ts` |
| added | `web/src/standin/csv.ts` |
| modified | `web/src/standin/fields.ts` |
| added | `web/src/standin/folder.ts` |
| added | `web/src/standin/gateway.ts` |
| added | `web/src/standin/importer.ts` |
| modified | `web/src/standin/index.ts` |
| modified | `web/src/standin/models/analysis.ts` |
| modified | `web/src/standin/models/csmodel.ts` |
| modified | `web/src/standin/models/dataCleanse.ts` |
| added | `web/src/standin/models/runner.ts` |
| modified | `web/src/standin/models/summaries.ts` |
| deleted | `web/src/standin/platform.ts` |
| deleted | `web/src/standin/registry.ts` |
| added | `web/src/standin/replay.ts` |
| modified | `web/src/standin/runtime.ts` |
| modified | `web/src/standin/server.ts` |
| deleted | `web/src/standin/sha1.ts` |
| modified | `web/src/standin/store.ts` |
| added | `web/src/standin/stream.ts` |
| modified | `web/src/standin/swe.ts` |
| modified | `web/src/standin/tap.ts` |
| modified | `web/src/standin/time.ts` |
| added | `web/src/standin/ucum.ts` |

### `web/src/styles.css`

| Change | File |
|---|---|
| modified | `web/src/styles.css` |

### `web/src/workers`

| Change | File |
|---|---|
| modified | `web/src/workers/backend.worker.ts` |
| modified | `web/src/workers/model.worker.ts` |
| modified | `web/src/workers/standin.worker.ts` |
