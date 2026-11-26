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

## With access control on (S-AUTH)

The authentication spike (`docs/findings/FINDING-2026-11-25-opensensorhub-auth.md`) runs the
same build with `osh-config-auth.json`: a `BasicSecurityRealm` module with five users and five
roles, HTTP Basic authentication on the HTTP server, the admin UI at `/sensorhub/admin`, and
four Connected Systems endpoints on one database: `/api` (everything, access control on),
`/api-weather` and `/api-weather-ro` (a view excluding `urn:barge:restricted:*`, the second
read-only) and `/api-internal` (access control off, authentication on; the only place a
command receiver can connect). Passwords are in the file in plain text: spike only.

1. Start OpenSensorHub against an **empty** store (delete `spike_auth_h2.dat*` and the `db`
   state directory first), from a working directory holding a copy of the configuration:

       cp backend/spike/osh-config-auth.json run/config.json && cd run
       java -Xmx512m -cp "<osh-core>/build/install/osh-core/lib/*" org.sensorhub.impl.SensorHub config.json db

2. Run the first phase (creates the resources, records their identifiers):

       pip install -r backend/requirements-dev.txt websockets
       python backend/spike/osh_auth_spike.py http://localhost:8181/sensorhub backend/spike/auth-results.json --rundir run

3. Write the deny entries naming the restricted systems into the copy, restart OpenSensorHub,
   run the second phase; then again with `--ancestors` for the third:

       python backend/spike/osh_auth_spike.py --write-deny backend/spike/auth-results.json backend/spike/osh-config-auth.json run/config.json
       # restart OpenSensorHub
       python backend/spike/osh_auth_spike.py http://localhost:8181/sensorhub backend/spike/auth-results.json --after-deny
       python backend/spike/osh_auth_spike.py --write-deny backend/spike/auth-results.json backend/spike/osh-config-auth.json run/config.json --ancestors
       # restart OpenSensorHub
       python backend/spike/osh_auth_spike.py http://localhost:8181/sensorhub backend/spike/auth-results.json --after-deny --ancestors

Everything a request needs is in the `Authorization` header (Basic); there is no session.

## The contract suite against OpenSensorHub (AT-32)

No longer a spike: `backend/independent/at32_osh.py` starts the same build with a configuration
written from the delivered accounts, puts the access gateway in front of it, installs the
platform, runs the importer and replay controller as clients and the core models through the
gateway, then runs `backend/contract_suite/suite.py` unchanged and prints pass or fail per check
(`docs/findings/FINDING-2026-11-26-opensensorhub-contract-suite.md`). Since D-193 to D-196 were
adopted, nothing rewrites requests on the way, and there is no `--proposed` run:

    pip install -r backend/requirements-dev.txt websockets
    python scripts/build_data_folder.py
    python backend/independent/at32_osh.py --osh <osh-core>/build/install/osh-core [--json backend/independent/at32-osh-results.json]

What `DELETE` and `PUT` do on that server (D-200), through the gateway and directly, with the same set-up:

    python backend/independent/at32_delete_probe.py --osh <osh-core>/build/install/osh-core [--json backend/independent/at32-delete-results.json]
