# New model 1: an example new model (FR-36). Edit it, then press Run.
#
# 1. Write it: Python, using the scientific libraries, reading observations from the
#    data server. Read Data cleanse's or Summaries' output, never the sensors' datastreams.
# 2. Register it: setup() creates a process system under Models (ordinary resource
#    creation); datasets() creates its datastream for each dataset. Nothing else changes.
# 3. See it: restart the display client. The new field appears as a chip, drawn by its
#    schema type alone.
#
# It runs under its own service account, svc-new-model-1, which cannot read CO2 (FR-113).
import numpy as np

from csmodel import Model, NotReady, quantity, record, run_field, time_field

SUMMARIES = "urn:x-barge:process:summaries"


class WindChill(Model):
    id = "new-model-1"
    label = "New model 1"
    description = "Example: wind chill at the bow, every minute."
    max_rate = 100.0  # the highest replay rate it sustains
    window = 60.0  # replay seconds per window, aligned to the dataset's start

    async def datasets(self, api, ds):
        self.source = await api.find(SUMMARIES, f"summary-1min-bow__{ds['id']}")
        if self.source is None:
            return False  # Summaries has not created it yet
        self.out = await api.create_datastream(self.system, {
            "name": f"Wind chill · {ds['id']}", "outputName": f"wind-chill__{ds['id']}",
            "schema": record("Wind chill", [time_field("time", "Start of the minute"),
                                            quantity("wind_chill", "Wind chill", "Cel"), run_field()])})
        return True

    async def process(self, api, ds, t0, t1, run):
        cols = await api.read(self.source, t0, t1 - 0.001, ["air_temperature", "apparent_wind_speed", "run"])
        mine = np.array([r == run for r in cols["run"]], dtype=bool)
        if not mine.any():
            raise NotReady("Summaries has not published this minute yet")  # the same window is tried again
        T = np.asarray(cols["air_temperature"], dtype=float)[mine]
        v = np.asarray(cols["apparent_wind_speed"], dtype=float)[mine] * 3.6  # km/h
        api.tap("scilibs", "numpy: wind chill", {"rows": int(len(T))})
        wc = 13.12 + 0.6215 * T - 11.37 * v ** 0.16 + 0.3965 * T * v ** 0.16
        for t, w in zip(cols["t"][mine], np.round(wc, 2)):
            await api.publish(self.out, {"t": float(t), "wind_chill": float(w), "run": run})


MODEL = WindChill
