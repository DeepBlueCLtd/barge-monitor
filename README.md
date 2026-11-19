# barge-monitor
Weather monitoring on a cyclic excursion: a system and architecture
demonstrator that runs whole in one browser tab.

**Working demonstrator:** https://deepbluecltd.github.io/barge-monitor/demo/ ·
**Requirements:** https://deepbluecltd.github.io/barge-monitor/

Everything is fictional: the canal, its places and the weather.

## Layout

| Path | What |
|---|---|
| `srd-barge.md` | Software Requirements Document |
| `contracts/openapi.json` | Master for every shape crossing the seam (OpenAPI 3.1 + JSON Schema, including the CoverageJSON subset) |
| `backend/barge/` | Python backend: world generator, boat, sensors, logger stand-in, store adapter, EDR server (plain ASGI), analysis, scoring |
| `backend/contract_suite/` | Contract tests run both in CPython under uvicorn and in the browser through the Service Worker (AT-02) |
| `backend/tests/` | pytest: acceptance tests AT-01, AT-04..AT-07 (scaled), FR checks |
| `web/` | TypeScript/React display, Service Worker, the two Pyodide workers, e2e tests |
| `docs/decisions-log.md` | Questions met while building V1, options, and decisions taken |
| `docs/adr/`, `docs/findings/` | Decision records and measured findings |

## Run it locally

```sh
# Python tests (CPython 3.13)
pip install -r backend/requirements-dev.txt
(cd backend && python -m pytest -q)

# The demonstrator
cd web
npm ci
npm run pyodide      # fetch Pyodide 0.29.5 and packages into .cache/ (once)
npm run build        # generates TS types from the master and packs the Python
npm run site         # assembles ../dist-site/{demo,pyodide}
npm run serve        # http://localhost:8080/demo/
npm run e2e          # Playwright end-to-end tests
```

The backend also runs under an ordinary ASGI server:
`cd backend && uvicorn --factory barge.edr:app_factory`.

## Previews

Every pull request gets a persistent preview at
`https://deepbluecltd.github.io/barge-monitor/pr/<number>/` (documents) and
`…/pr/<number>/demo/` (demonstrator), linked from a comment on the PR (see
`.github/workflows/pages.yml`). Build the documents locally with
`scripts/build-site.sh` (needs pandoc).
