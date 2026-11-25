# Finding: the CSV importer as an OpenSensorHub module (S-IMPORT, FR-20a, §15)

**Date:** 2026-11-25 · **Server:** OpenSensorHub `osh-core` 2.0.4, built from source at
commit `75bb094`, configured as in `backend/spike/osh-config.json` plus one module · **Where:**
one cloud VM (4 vCPU Xeon 2.1 GHz, 15 GB, OpenJDK 21), client and server on the same host
· **How:** the module in `backend/spike/import-module/`; the record of the runs is
`backend/spike/import-results.json`.

## Summary

**Yes.** A module written against OpenSensorHub's own Java extension interface imported a
CSV file of **500,000 rows** (1 Hz, a time and 8 Quantity fields) into the server's own
store in **1.6 to 2.4 seconds: about 300,000 rows a second** (205,995 to 316,766 over 11
runs). Loading over HTTP, as in the 2026-11-23 spike, managed about 450 a second; the same
file would take about 18 minutes that way. The module is roughly **650 times faster**.

The imported data are ordinary Connected Systems resources: `GET /systems` lists the
importer, `GET /datastreams` lists a datastream per file with the right time span, and
`/datastreams/{id}/observations?phenomenonTime=…` returned every row with values identical
to the CSV (all 500,000 paged out; three windows checked value by value). They survived a
clean restart and a `kill -9` straight after an import.

FR-20b is feasible as written: the module registers an **`import` control stream**, receives
its commands in process, answers the HTTP `POST` in 21 ms with ACCEPTED, reports progress
and COMPLETED (or FAILED with a reason), and publishes an **archive catalogue** datastream.

The writing goes through internal classes of `osh-core`, not a published, versioned API
(see Limits).

## What was done

1. Cloned `osh-core` at `75bb094` and built it with its Gradle wrapper (one retry after
   Maven Central rate-limited the build). No addon repository was needed.
2. Wrote `CsvImportModule`, a plain `AbstractModule` (not a sensor driver), about 430 lines
   of Java, compiled against the installed jars and dropped into `lib/`. Its configuration
   names the same database module the Connected Systems service writes to.
3. Generated two "awkward" CSV files of 500,000 rows each (`dd/MM/yyyy HH:mm:ss`, `;`,
   units in the headings, about 1 % `-9999` written as NaN), 38 MB each.
4. Imported at start-up into an empty store, five times in the bulk mode and three times
   through the event bus, once committing every 10,000 rows, once with a 128 MB heap; and
   imported the second file on demand by a Connected Systems command.
5. Checked everything over HTTP with `verify_import.py`, after the import, after a clean
   restart, and after `kill -9` and restart.

### Which extension point

Source reading and the runs agree: the useful API is the **transaction-handler layer of
`sensorhub-core`** (`org.sensorhub.impl.system`), the same classes the Connected Systems
service calls for its own POSTs:

- `SystemDatabaseTransactionHandler(eventBus, db)` → `addSystemOrReturnExisting(...)`
  (idempotent across restarts) → `SystemTransactionHandler.addOrUpdateDataStream(...)` and
  `addOrUpdateCommandStream(...)`. The handler publishes the system and datastream events,
  so the resources are visible at once.
- Rows: either `db.getObservationStore().add(ObsData)` per row (**bulk path**, no event per
  row), or `DataStreamTransactionHandler.addObs(DataEvent)` with 1,000 records per event
  (also publishes them on the event bus, for live subscribers). Then
  `IObsSystemDatabase.commit()`.
- The database is found with `getParentHub().getModuleRegistry().getModuleById(databaseID)`.

A sensor driver (`AbstractSensorModule`) would also work but stamps observations through
the event bus and needs the driver registry to route its outputs to a database; the plain
module is simpler and writes exactly where the service reads.

## Measurements

500,000 rows each; `-Xmx512m` unless stated. Full table in `import-results.json`.

| Run | Write path | Seconds | Rows/s | Heap used (max sampled) | Process RSS (max) |
|---|---|---|---|---|---|
| Fresh store, 5 runs | `IObsStore.add` | 1.60 to 2.03 | 246,490 to 312,991 | 118 to 161 MB | 291 to 358 MB |
| Second file, by `import` command, store already holding 500,000 | `IObsStore.add` | 1.58 | 316,766 | 133 MB | n/a |
| Fresh store, 3 runs | `DataEvent` × 1,000 rows | 1.59 to 1.66 | 301,460 to 315,305 | 134 to 145 MB | 320 to 340 MB |
| Commit every 10,000 rows | `IObsStore.add` | 1.82 | 274,333 | 131 MB | 317 MB |
| 128 MB heap | `IObsStore.add` | 2.43 | 205,995 | 80 MB | 235 MB |

- **Final commit:** under 10 ms; the MVStore writes in the background during the import.
- **Store size:** 55 MB per 500,000 observations, about 110 bytes each (the CSV is 38 MB).
- **Memory** does not grow with the file: rows are streamed, and a 128 MB heap still worked.
- **Reading back over HTTP:** one day (86,400 observations) in about 2.4 s; all 500,000 in
  about 18 s.
- The times include reading and parsing the CSV and the SHA-256 of the file.

## On-demand import and the catalogue (FR-20b, FR-20c)

**The `import` control stream works, and better than commands did in the earlier spike.**
The module attaches itself as the control stream's command receiver
(`CommandStreamTransactionHandler.connectCommandReceiver`), in process, so the push delivery
that troubled FR-27 is not a problem here: the receiver is the server.

- `POST /controlstreams/{import}/commands` with `{"parameters":{"fileName":"…"}}` answered
  **200, ACCEPTED, in 21 ms**: the module acknowledges at once and imports on its own thread.
- Progress is reported as EXECUTING with `percentCompletion` 11 … 91 at
  `/controlstreams/{id}/status`; then COMPLETED, and the command's `currentStatus` reads
  COMPLETED (in the 2026-11-23 spike, an HTTP-reported status did not update it).
- An unknown file gives FAILED with the message "No such file in the data folder".

**The catalogue datastream works.** One observation per file at start (`not imported`),
then `importing` with a percentage, then `imported` with hash, time span and record count.
At start the module reads the catalogue back from the store (latest observation per file)
and publishes only for files whose state changed, so the catalogue stays append-only across
restarts (13 observations before and after a restart). The file-size and modified-date
comparison for `changed since import` is in the code; superseding (FR-21a) was not built.

## Consequences for FR-20a and the fallback

- **FR-20a holds.** Bulk import inside the server is about 300,000 rows a second, so three
  days of two 1 Hz sensors take seconds, not 20 minutes. The fallback of §15 (an importer
  outside the server, over HTTP) is not needed for speed.
- **The importer is Java**, compiled against `osh-core`, and is deployed as a jar in the
  server's `lib/` plus one entry in its configuration. It has to be rebuilt and retested for
  each OpenSensorHub version it is deployed with.
- **Progress needs no extra design:** the command status (percentage) and the catalogue
  (`importing` with a percentage) already carry it, so the display client can follow an
  import with the polling it already does.
- Requirements text: FR-20a's "about 450 a second" stays as the reason; the open question
  in §15 can be closed with this finding.

## Limits of this spike

- **Internal API.** `SystemDatabaseTransactionHandler` and its siblings are public classes in
  `org.sensorhub.impl.*`, not the `org.sensorhub.api` interfaces; nothing promises they stay
  the same between versions. The Connected Systems service depends on them too, which makes
  sudden change less likely, but upgrades need a test.
- **One layout, synthetic data.** A generated file with one column layout; the client's real
  files (FR-19), CO₂ separation (FR-21c), supersession (FR-21a) and `rescan` (FR-20c) were
  not built. Parsing real "awkward" files may cost more than this file's.
- **No live subscribers.** In event mode nobody was subscribed to the data topic. With
  WebSocket or MQTT clients watching, each event would also be serialised to them; the bulk
  path (`IObsStore.add`) avoids this, and imported history does not need to be pushed live.
- **No concurrent load.** Imports were not measured while clients were reading, and two
  imports at once were not tried (the module runs one at a time).
- **One machine, one store.** The H2 MVStore with the spike's settings (no compression, no
  location index); RSS was sampled once a second. A `kill -9` during an import (as opposed to
  after it) was not tried; source reading suggests the rows written since the last MVStore
  commit would be lost and the catalogue would be left at `importing`.
- **Access control off**, as in the earlier spike. Whether the importer's writes respect
  per-system permissions (FR-21c's service account) belongs to the authentication spike.
- **Observed differences**, recorded not investigated: an observation page is capped at
  10,000 whatever `limit` asks (paging by `offset` returns everything, contrary to the
  earlier spike's "oversize limit not refused" note, which saw fewer rows); UCUM codes are
  checked strictly (`[psu]` refused; `[ppth]` and `[ppm]` accepted); in the plain JSON form,
  extra Time fields defined as phenomenon time are left out of `result`, so the catalogue's
  times use their own definitions.
