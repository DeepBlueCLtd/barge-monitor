# OpenSensorHub spike (AT-32, ADR 0005)

What a stock OpenSensorHub does with what this system needs of a data server. The findings
are in `docs/findings/FINDING-2026-11-23-opensensorhub-spike.md`; `results.json` is the
record of the run they were written from.

## Running it

1. Build OpenSensorHub from source (Java 17 or later). The spike used `osh-core` 2.0.4,
   commit `75bb094`:

       git clone --depth 1 https://github.com/opensensorhub/osh-core
       cd osh-core && ./gradlew installDist -x test -x javadoc

2. Start it with the spike's configuration, which is the distribution's own with three
   changes: the Connected Systems service is the only service, it accepts resource creation
   (`enableTransactional`), and access control is off.

       cd build/install/osh-core
       java -Xmx512m -cp "lib/*" org.sensorhub.impl.SensorHub <repo>/backend/spike/osh-config.json db

3. Against an **empty** server (delete `spike_obs_h2.dat*` first):

       pip install -r backend/requirements-dev.txt websockets
       python backend/spike/osh_spike.py http://localhost:8181/sensorhub/api backend/spike/results.json

4. Stop OpenSensorHub, start it again, then:

       python backend/spike/osh_spike.py http://localhost:8181/sensorhub/api backend/spike/results.json --after-restart

The script runs the demonstrator's own server in process as the reference, replays its
systems, datastreams, a sample of observations and the clustering control stream into
OpenSensorHub over HTTP, and records each answer beside the reference's. It is not part of
the test suite: it needs a server the CI does not have.
