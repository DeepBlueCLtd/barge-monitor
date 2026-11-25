# CSV importer as an OpenSensorHub module (spike S-IMPORT)

A minimal importer that runs **inside** OpenSensorHub and writes CSV rows straight into
the database the Connected Systems service exposes. Findings:
`docs/findings/FINDING-2026-11-25-opensensorhub-bulk-import.md`; measurements:
`backend/spike/import-results.json`.

It is spike code: one fixed column layout, no FR-21a supersession, no CO₂ separation.

## What it is

- `CsvImportModule` extends OSH's `AbstractModule` (the plain module extension point;
  not a sensor driver). In `doStart()` it waits for the database module named by
  `databaseID`, then uses `SystemDatabaseTransactionHandler`, the same class the
  Connected Systems service uses for HTTP POSTs, to create:
  - the system `urn:barge-monitor:importer`;
  - the `catalogue` datastream (FR-20b), one observation per file and status change;
  - the `import` control stream (FR-20b), parameter `fileName`, whose commands it
    receives in process through `CommandStreamTransactionHandler.connectCommandReceiver`;
  - one datastream per imported file version (`file_<name>_<sha256[0:8]>`, FR-21): a time
    field and 8 Quantity fields.
- Rows are written with `IObsStore.add(obs)` (`writeMode: direct`), or as one `DataEvent`
  of `batchSize` records through `DataStreamTransactionHandler.addObs` (`writeMode:
  event`), which also publishes the observations on the event bus. Then `db.commit()`.
- `gen_csv.py` makes the test file: 1 Hz, `dd/MM/yyyy HH:mm:ss`, `;`, units in headings,
  `-9999` for about 1 % of values (written as NaN).
- `verify_import.py` checks the import through the HTTP API (paged by `offset`: the server
  caps a page at 10,000).

## Building it into OpenSensorHub

1. Build OpenSensorHub as in `backend/spike/README.md` (`osh-core` 2.0.4, commit `75bb094`,
   `./gradlew installDist -x test -x javadoc`).
2. Compile this module against the installed jars and put it in `lib/`:

       backend/spike/import-module/build.sh <osh-core>/build/install/osh-core

   (Plain `javac` against `lib/*`; no Gradle project is needed for a spike. A real module
   would be a Gradle subproject of an `osh-addons`-style build with an OSGi manifest.)
3. Append `importer-module.json` to the server configuration (e.g. a copy of
   `backend/spike/osh-config.json`), with `dataFolder` set and `databaseID` equal to the
   `id` of the `MVObsSystemDatabase` module that the Connected Systems service's
   `databaseID` also names. Put files in `importOnStart` to import them at start-up.
4. Start OpenSensorHub as usual (`java -Xmx512m -cp "lib/*" org.sensorhub.impl.SensorHub
   config.json db`).

## Using it

    python gen_csv.py data/barge_2025-01.csv 500000
    # on demand, through the Connected Systems API:
    curl -X POST -H 'Content-Type: application/json' \
         -d '{"parameters":{"fileName":"barge_2025-01.csv"}}' \
         http://localhost:8181/sensorhub/api/controlstreams/<import id>/commands
    # progress and outcome:
    curl http://localhost:8181/sensorhub/api/controlstreams/<import id>/status
    python verify_import.py http://localhost:8181/sensorhub/api data/barge_2025-01.csv file_barge_2025_01
