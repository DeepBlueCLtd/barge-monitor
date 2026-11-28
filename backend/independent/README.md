# Independent clients and servers

`oshconnect_browse.py` (AT-05) browses the server with OSHConnect-Python. `at32_osh.py` (AT-32)
runs the contract suite straight against a stock OpenSensorHub configured by `osh_server.py`.

## Building OpenSensorHub for AT-32

AT-32 needs `osh-core` 2.0.4, commit `75bb094`, built from source (Java 17 or later):

    git clone https://github.com/opensensorhub/osh-core
    cd osh-core && git checkout 75bb094
    ./gradlew installDist -x test -x javadoc

Then pass the build to the suite:

    python backend/independent/at32_osh.py --osh <osh-core>/build/install/osh-core --json at32-osh-results.json

The `at32` workflow does the same on demand. The original OpenSensorHub spike (ADR 0005, D-114),
its configuration and its results were removed from the tree; read them at commit `2ddcbb5`
under `backend/spike/`.
