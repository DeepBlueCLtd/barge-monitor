# barge-monitor

A system and architecture demonstrator that runs whole in one browser tab (SRD Version 4.6).
Recorded barge missions sit in a data folder as CSV files in an awkward logger dialect. An
OGC API – Connected Systems data server (OpenSensorHub in the developed system; an
in-browser stand-in here) imports them, replays them through a **replay controller**, and
hides restricted sources behind an **access gateway**. A self-configuring display client
and models that run in their own workers talk to it over the same HTTP interface. Every
component and every real message is on screen.

The demonstrator **opens "before"** (`?hand-made`): the data server drawn as the
subsystems we would have to build. One click adopts OpenSensorHub and the demonstrator
comes alive. **Failure demos** in the top bar take the server down, remove a source,
misconfigure the server, change a user's role and more, and say what to watch for.

**Demonstrator:** https://deepbluecltd.github.io/barge-monitor/demo/ ·
**Requirements:** https://deepbluecltd.github.io/barge-monitor/

Everything is fictional: the canal, its places, the weather and the dates (2031).

Demo accounts: `owner` / `demo-owner` (sees CO₂), `friend` / `demo-friend`,
`analyst` / `demo-analyst` (weather only). Roles can be changed in the control panel
("OpenSensorHub administration (stand-in)").

## Layout

| Path | What |
|---|---|
| `srd-barge.md` | Software Requirements Document, Version 4.6 |
| `docs/plan-v4.6.md` | The implementation plan, phases 0–10 |
| `docs/v4-interfaces.md` | The implementation contract: components, flows, letters, resources, profile, replay, import, gateway, worker protocols |
| `contracts/` | Masters for the seam: `openapi.json`, `profile.json` (a template per dataset) and its JSON Schema, data-of-interest schema |
| `backend/barge/` | Python back end: data folder generator, CSV dialect and importer, QC, replay controller, access gateway, accounts, the data server's stand-in (FastAPI), referee scoring, message tap |
| `backend/models/` | The models (Data cleanse, Summaries, Analysis, empty slots), written against `csmodel.py` |
| `backend/contract_suite/` | One contract suite, run against the Python back end and the TypeScript stand-in |
| `backend/tests/` | pytest acceptance tests |
| `backend/independent/` | AT-05: OSHConnect-Python browses the server |
| `backend/spike/` | The OpenSensorHub spikes (bulk import, authentication) |
| `web/` | TypeScript and React: the shell (opening, flowchart, detail panels, control panel, failure demos), the display client (ECharts), the Service Worker relay, the TypeScript stand-in (`src/standin/`), the Pyodide workers, Playwright tests |
| `scripts/build_data_folder.py` | The data folder: four missions (A, B, B re-exported, C without one column), reproducible byte for byte (`--check`) |
| `docs/decisions-log.md`, `docs/adr/`, `docs/findings/` | Decisions taken while implementing, decision records, measured findings |

## Run it locally

```sh
pip install -r backend/requirements-dev.txt
(cd backend && python -m pytest -q)            # Python tests and the contract suite
python scripts/build_data_folder.py            # the data folder, into web/public/data/folder
cd web
npm ci
npm run pyodide                                # Pyodide and packages into ../.cache (once)
npm run build
npm run site                                   # assembles ../dist-site (add --no-pyodide to skip Python)
npm run serve                                  # http://localhost:8080/demo/
node scripts/standin-check.mjs                 # the contract suite against the stand-in
npm run e2e                                    # Playwright tests
```

`?backend=python` runs the Python back end and models in Pyodide; `?backend=standin` (the
default) the TypeScript stand-in, which starts in seconds. `?hand-made` opens on "before".

## Decisions of note

* ADR 0005: OpenSensorHub is the data server; the demonstrator keeps stand-ins.
* ADR 0006: replay is a controller on the server, driven by commands.
* ADR 0007: the CSV importer is a server module.
* ADR 0008: an access gateway hides what a user may not see.

## Previews

Every pull request gets persistent previews at
`https://deepbluecltd.github.io/barge-monitor/pr/<number>/` (documents) and
`…/pr/<number>/demo/` (demonstrator), linked from a comment on the PR.
