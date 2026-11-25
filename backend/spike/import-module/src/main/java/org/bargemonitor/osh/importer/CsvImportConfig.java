package org.bargemonitor.osh.importer;

import org.sensorhub.api.module.ModuleConfig;


/**
 * Configuration of the spike CSV importer (S-IMPORT). Loaded from OpenSensorHub's
 * config.json like any other module: {"objClass": "...CsvImportConfig", "moduleClass":
 * "...CsvImportModule", ...}.
 */
public class CsvImportConfig extends ModuleConfig
{
    /** Module ID of the IObsSystemDatabase to write into (the same one the CS API service writes to). */
    public String databaseID;

    /** Folder holding the CSV files (read only: FR-17a). */
    public String dataFolder;

    /** Unique ID of the importer system. */
    public String systemUID = "urn:barge-monitor:importer";

    /** Files to import as soon as the module starts (empty: only on command). */
    public String[] importOnStart = new String[0];

    /**
     * How rows reach the store:
     * "direct" - IObsStore.add(obs) per row, no event bus traffic (bulk path);
     * "event"  - DataStreamTransactionHandler.addObs(DataEvent) with batchSize records
     *            per event: publishes an ObsEvent per batch, then stores each record.
     */
    public String writeMode = "direct";

    /** Rows per DataEvent in "event" mode; also the progress/commit interval. */
    public int batchSize = 1000;

    /** Commit the MVStore every this many rows (0: only at the end). */
    public int commitEvery = 0;
}
