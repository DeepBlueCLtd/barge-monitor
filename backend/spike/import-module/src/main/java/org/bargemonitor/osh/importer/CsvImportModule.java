package org.bargemonitor.osh.importer;

import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Flow.Subscriber;
import java.util.concurrent.Flow.Subscription;
import org.sensorhub.api.command.CommandEvent;
import org.sensorhub.api.command.CommandStatus;
import org.sensorhub.api.common.SensorHubException;
import org.sensorhub.api.data.DataEvent;
import org.sensorhub.api.data.IObsData;
import org.sensorhub.api.data.ObsData;
import org.sensorhub.api.database.IObsSystemDatabase;
import org.sensorhub.api.datastore.obs.ObsFilter;
import org.sensorhub.api.module.IModule;
import org.sensorhub.api.module.ModuleEvent.ModuleState;
import org.sensorhub.impl.module.AbstractModule;
import org.sensorhub.impl.system.CommandStreamTransactionHandler;
import org.sensorhub.impl.system.DataStreamTransactionHandler;
import org.sensorhub.impl.system.SystemDatabaseTransactionHandler;
import org.sensorhub.impl.system.SystemTransactionHandler;
import org.sensorhub.impl.system.wrapper.SystemWrapper;
import org.vast.sensorML.SMLHelper;
import org.vast.swe.SWEConstants;
import org.vast.swe.SWEHelper;
import org.vast.util.TimeExtent;
import net.opengis.swe.v20.DataBlock;
import net.opengis.swe.v20.DataComponent;


/**
 * Spike CSV importer running inside OpenSensorHub (S-IMPORT, SRD FR-20 to FR-21).
 *
 * <p>It is a plain OSH module (AbstractModule) that writes straight into the database the
 * Connected Systems service exposes, through the same transaction handlers that service
 * uses for HTTP POSTs ({@link SystemDatabaseTransactionHandler}), so that systems,
 * datastreams and observations it creates are ordinary CS API resources. Rows bypass HTTP
 * and, in "direct" mode, the event bus: each row becomes one {@code IObsStore.add()}.</p>
 *
 * <p>It registers one system with:
 * <ul>
 * <li>an archive catalogue datastream ({@code catalogue}, FR-20b),</li>
 * <li>an {@code import} control stream taking a file name (FR-20b), whose commands are
 *   received in-process, and</li>
 * <li>one datastream per imported file (FR-21), 1 time field + 8 Quantity fields.</li>
 * </ul></p>
 */
public class CsvImportModule extends AbstractModule<CsvImportConfig>
{
    static final String CATALOGUE = "catalogue";
    static final String IMPORT = "import";
    static final String[][] FIELDS = {
        // name, label, uom, definition
        {"airTemp", "Air Temperature", "Cel", SWEHelper.getPropertyUri("AirTemperature")},
        {"relHumidity", "Relative Humidity", "%", SWEHelper.getPropertyUri("RelativeHumidity")},
        {"airPressure", "Air Pressure", "hPa", SWEHelper.getPropertyUri("AtmosphericPressure")},
        {"windSpeed", "Wind Speed", "m/s", SWEHelper.getPropertyUri("WindSpeed")},
        {"windDir", "Wind Direction", "deg", SWEHelper.getPropertyUri("WindDirection")},
        {"waterTemp", "Water Temperature", "Cel", SWEHelper.getPropertyUri("WaterTemperature")},
        {"salinity", "Salinity", "[ppth]", SWEHelper.getPropertyUri("Salinity")},
        {"co2", "CO2 Concentration", "[ppm]", SWEHelper.getPropertyUri("CO2Concentration")},
    };
    static final double MISSING = -9999;

    IObsSystemDatabase db;
    SystemDatabaseTransactionHandler txHandler;
    SystemTransactionHandler sysHandler;
    DataStreamTransactionHandler catalogueHandler;
    CommandStreamTransactionHandler importHandler;
    Subscription cmdSubscription;
    ExecutorService worker;
    final Map<String, Object> lastResult = new LinkedHashMap<>();


    @Override
    protected void doStart() throws SensorHubException
    {
        worker = Executors.newSingleThreadExecutor(r -> new Thread(r, "csv-importer"));

        // the database is another module: wait for it on the worker thread, not here
        worker.submit(() -> {
            try
            {
                setup();
                for (var f: config.importOnStart)
                    importFile(f, -1, null);
            }
            catch (Throwable e)
            {
                reportError("Importer setup failed", e);
            }
        });
    }


    void setup() throws Exception
    {
        var dbModule = getParentHub().getModuleRegistry().getModuleById(config.databaseID);
        ((IModule<?>)dbModule).waitForState(ModuleState.STARTED, 60000);
        db = (IObsSystemDatabase)dbModule;
        txHandler = new SystemDatabaseTransactionHandler(getParentHub().getEventBus(), db);

        // system (returned unchanged if it already exists, e.g. after a restart)
        var sml = new SMLHelper();
        var sys = sml.createPhysicalSystem()
            .uniqueID(config.systemUID)
            .name("CSV importer")
            .description("Imports scientists' CSV files into this server (spike S-IMPORT)")
            .build();
        sysHandler = txHandler.addSystemOrReturnExisting(new SystemWrapper(sys));

        // archive catalogue datastream (FR-20b)
        var swe = new SWEHelper();
        var catRec = swe.createRecord()
            .name(CATALOGUE)
            .label("Archive catalogue")
            .addField("time", swe.createTime().asSamplingTimeIsoUTC())
            .addField("fileName", swe.createText().label("File name"))
            .addField("fileSize", swe.createCount().label("Size (bytes)"))
            .addField("modified", swe.createTime().withIso8601Format().refFrame(SWEConstants.TIME_REF_UTC)
                .definition(SWEHelper.getPropertyUri("ModificationTime")).label("Modified"))
            .addField("sha256", swe.createText().label("Content hash"))
            .addField("spanBegin", swe.createTime().withIso8601Format().refFrame(SWEConstants.TIME_REF_UTC)
                .definition(SWEHelper.getPropertyUri("FirstRecordTime")).label("First record"))
            .addField("spanEnd", swe.createTime().withIso8601Format().refFrame(SWEConstants.TIME_REF_UTC)
                .definition(SWEHelper.getPropertyUri("LastRecordTime")).label("Last record"))
            .addField("recordCount", swe.createCount().label("Records"))
            .addField("status", swe.createCategory().label("Status")
                .addAllowedValues("not imported", "importing", "imported", "changed since import", "superseded"))
            .addField("percent", swe.createCount().label("Progress (%)"))
            .build();
        catalogueHandler = sysHandler.addOrUpdateDataStream(CATALOGUE, catRec, swe.newTextEncoding());

        // import control stream (FR-20b): receive its commands in process
        var params = swe.createRecord()
            .name(IMPORT)
            .label("Import a file")
            .addField("fileName", swe.createText().label("File name"))
            .build();
        importHandler = sysHandler.addOrUpdateCommandStream(IMPORT, params, swe.newTextEncoding());
        importHandler.connectCommandReceiver(new Subscriber<CommandEvent>() {
            public void onSubscribe(Subscription s) { cmdSubscription = s; s.request(Long.MAX_VALUE); }
            public void onNext(CommandEvent e) { onImportCommand(e); }
            public void onError(Throwable t) { getLogger().error("Command stream error", t); }
            public void onComplete() { }
        });

        // first catalogue pass (FR-20c, cut down): read the catalogue back from the store
        // (latest observation per file wins) and publish only for files whose state changed
        var known = new java.util.HashMap<String, DataBlock>();
        db.getObservationStore().select(new ObsFilter.Builder()
                .withDataStreams(catalogueHandler.getDataStreamKey().getInternalID()).build())
            .sorted(java.util.Comparator.comparing(IObsData::getPhenomenonTime))
            .forEach(o -> known.put(o.getResult().getStringValue(1), o.getResult()));
        var folder = new File(config.dataFolder);
        var files = folder.listFiles((d, n) -> n.endsWith(".csv"));
        if (files != null)
            for (var f: files)
            {
                var last = known.get(f.getName());
                if (last == null)
                    publishCatalogue(f, null, "not imported", 0, null, null, 0);
                else if ("imported".equals(last.getStringValue(8))
                    && (last.getLongValue(2) != f.length() || (long)(last.getDoubleValue(3) * 1000) != f.lastModified()))
                    publishCatalogue(f, null, "changed since import", 0, null, null, 0);
                // a file left 'importing' by a crash would be re-queued here in a real importer
            }

        reportStatus("Ready, catalogue published");
        getLogger().info("Importer ready: system {}, catalogue {}, import control stream {}",
            sysHandler.getSystemKey().getInternalID(),
            catalogueHandler.getDataStreamKey().getInternalID(),
            importHandler.getCommandStreamKey().getInternalID());
    }


    void onImportCommand(CommandEvent e)
    {
        var cmd = e.getCommand();
        var fileName = cmd.getParams().getStringValue(0);
        getLogger().info("Import command {} for {}", e.getCorrelationID(), fileName);
        // answer at once, then do the work on the worker thread
        importHandler.sendStatus(e.getCorrelationID(), CommandStatus.accepted(cmd.getID()));
        worker.submit(() -> importFile(fileName, e.getCorrelationID(), cmd.getID()));
    }


    void importFile(String fileName, long correlationID, org.sensorhub.api.common.BigId cmdID)
    {
        try
        {
            var f = new File(config.dataFolder, fileName);
            if (!f.isFile() || f.getName().contains("/"))
                throw new IllegalArgumentException("No such file in the data folder: " + fileName);

            var sha = sha256(f);
            publishCatalogue(f, sha, "importing", 0, null, null, 0);

            // one datastream per file version (FR-21, FR-21a): name from file name + hash
            var outputName = "file_" + f.getName().replaceAll("[^A-Za-z0-9]", "_") + "_" + sha.substring(0, 8);
            var swe = new SWEHelper();
            var rb = swe.createRecord()
                .name(outputName)
                .label("Imported " + f.getName())
                .addField("time", swe.createTime().asSamplingTimeIsoUTC());
            for (var fd: FIELDS)
                rb.addField(fd[0], swe.createQuantity().label(fd[1]).uom(fd[2]).definition(fd[3]));
            DataComponent rec = rb.build();
            var dsHandler = sysHandler.addOrUpdateDataStream(outputName, rec, swe.newTextEncoding());
            var dsId = dsHandler.getDataStreamKey().getInternalID();
            var obsStore = db.getObservationStore();
            boolean direct = !"event".equals(config.writeMode);

            long totalLines = Math.max(1, f.length() / 75); // estimate, for progress only
            var rt = Runtime.getRuntime();
            System.gc();
            long heapBefore = rt.totalMemory() - rt.freeMemory();
            long maxHeapUsed = heapBefore;
            long t0 = System.nanoTime();
            long count = 0, refused = 0;
            Instant first = null, last = null;
            var batch = new ArrayList<DataBlock>(config.batchSize);
            int lastPct = -1;

            try (var reader = Files.newBufferedReader(f.toPath(), StandardCharsets.UTF_8))
            {
                reader.readLine(); // header (units in the column headings)
                String line;
                while ((line = reader.readLine()) != null)
                {
                    var cols = line.split(";", -1);
                    if (cols.length != FIELDS.length + 1) { refused++; continue; }
                    var ts = parseTime(cols[0]);
                    var data = rec.createDataBlock();
                    data.setDoubleValue(0, ts.getEpochSecond() + ts.getNano() / 1e9);
                    for (int i = 1; i < cols.length; i++)
                    {
                        double v = Double.parseDouble(cols[i]);
                        data.setDoubleValue(i, v == MISSING ? Double.NaN : v);
                    }
                    if (first == null) first = ts;
                    last = ts;

                    if (direct)
                    {
                        obsStore.add(new ObsData.Builder()
                            .withDataStream(dsId)
                            .withFoi(IObsData.NO_FOI)
                            .withPhenomenonTime(ts)
                            .withResult(data)
                            .build());
                    }
                    else
                    {
                        batch.add(data);
                        if (batch.size() >= config.batchSize)
                            flushEvents(dsHandler, batch);
                    }
                    count++;

                    if (config.commitEvery > 0 && count % config.commitEvery == 0)
                        db.commit();
                    if (count % 10000 == 0)
                    {
                        maxHeapUsed = Math.max(maxHeapUsed, rt.totalMemory() - rt.freeMemory());
                        int pct = (int)Math.min(99, 100 * count / totalLines);
                        if (pct / 10 != lastPct / 10)
                        {
                            lastPct = pct;
                            publishCatalogue(f, sha, "importing", pct, null, null, count);
                            if (cmdID != null)
                                importHandler.sendStatus(correlationID, CommandStatus.progress(cmdID, pct, "importing", null));
                        }
                    }
                }
            }
            if (!batch.isEmpty())
                flushEvents(dsHandler, batch);
            long tWrite = System.nanoTime();
            db.commit();
            long tEnd = System.nanoTime();

            double secs = (tEnd - t0) / 1e9;
            publishCatalogue(f, sha, "imported", 100, first, last, count);
            if (cmdID != null)
                importHandler.sendStatus(correlationID, CommandStatus.completed(cmdID, TimeExtent.endNow(Instant.ofEpochMilli(t0 / 1000000))));

            synchronized (lastResult)
            {
                lastResult.clear();
                lastResult.put("file", f.getName());
                lastResult.put("datastreamID", dsId.toString());
                lastResult.put("outputName", outputName);
                lastResult.put("writeMode", config.writeMode);
                lastResult.put("rows", count);
                lastResult.put("refused", refused);
                lastResult.put("seconds", secs);
                lastResult.put("commitSeconds", (tEnd - tWrite) / 1e9);
                lastResult.put("rowsPerSecond", count / secs);
                lastResult.put("heapUsedBeforeMB", heapBefore / 1048576);
                lastResult.put("heapUsedMaxSampledMB", maxHeapUsed / 1048576);
                lastResult.put("first", String.valueOf(first));
                lastResult.put("last", String.valueOf(last));
            }
            getLogger().info("IMPORT RESULT {}", lastResult);
            reportStatus("Imported " + f.getName() + ": " + count + " rows in " + String.format("%.1f", secs) + " s");
        }
        catch (Throwable e)
        {
            getLogger().error("Import of {} failed", fileName, e);
            if (cmdID != null)
                importHandler.sendStatus(correlationID, CommandStatus.failed(cmdID, String.valueOf(e.getMessage())));
        }
    }


    void flushEvents(DataStreamTransactionHandler dsHandler, ArrayList<DataBlock> batch)
    {
        var info = dsHandler.getDataStreamInfo();
        dsHandler.addObs(new DataEvent(System.currentTimeMillis(),
            info.getSystemID().getUniqueID(), info.getOutputName(),
            batch.toArray(new DataBlock[0])));
        batch.clear();
    }


    void publishCatalogue(File f, String sha, String status, int pct, Instant begin, Instant end, long count)
    {
        var data = catalogueHandler.getDataStreamInfo().getRecordStructure().createDataBlock();
        int i = 0;
        data.setDoubleValue(i++, System.currentTimeMillis() / 1000.0);
        data.setStringValue(i++, f.getName());
        data.setLongValue(i++, f.length());
        data.setDoubleValue(i++, f.lastModified() / 1000.0);
        data.setStringValue(i++, sha == null ? "" : sha);
        data.setDoubleValue(i++, begin == null ? Double.NaN : begin.toEpochMilli() / 1000.0);
        data.setDoubleValue(i++, end == null ? Double.NaN : end.toEpochMilli() / 1000.0);
        data.setLongValue(i++, count);
        data.setStringValue(i++, status);
        data.setIntValue(i++, pct);
        catalogueHandler.addObs(data);
    }


    /** The CSV's awkward time format: dd/MM/yyyy HH:mm:ss, UTC. Parsed by hand, it is hot. */
    static Instant parseTime(String s)
    {
        int d = Integer.parseInt(s, 0, 2, 10);
        int mo = Integer.parseInt(s, 3, 5, 10);
        int y = Integer.parseInt(s, 6, 10, 10);
        int h = Integer.parseInt(s, 11, 13, 10);
        int mi = Integer.parseInt(s, 14, 16, 10);
        int se = Integer.parseInt(s, 17, 19, 10);
        return LocalDateTime.of(y, mo, d, h, mi, se).toInstant(ZoneOffset.UTC);
    }


    static String sha256(File f) throws Exception
    {
        var md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = Files.newInputStream(f.toPath()))
        {
            var buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0)
                md.update(buf, 0, n);
        }
        return HexFormat.of().formatHex(md.digest());
    }


    @Override
    protected void doStop() throws SensorHubException
    {
        if (cmdSubscription != null)
            cmdSubscription.cancel();
        if (worker != null)
            worker.shutdownNow();
    }
}
