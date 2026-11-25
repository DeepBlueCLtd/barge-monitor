#!/bin/bash
# Compile the importer against an installed OpenSensorHub and drop the jar into its lib/.
#   build.sh <osh-core>/build/install/osh-core
set -e
OSH=${1:?path to build/install/osh-core}
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$(mktemp -d)
javac -nowarn --release 17 -d "$OUT" -cp "$OSH/lib/*" $(find "$HERE/src" -name '*.java')
jar cf "$OSH/lib/barge-csv-importer.jar" -C "$OUT" .
rm -rf "$OUT"
echo "installed $OSH/lib/barge-csv-importer.jar"
