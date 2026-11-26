# New model 1: an example new model (FR-36). Edit it, then press Run.
#
# 1. Write it: Python, using the scientific libraries, reading observations
#    from the data server. Read Data cleanse's output, never the sensors'
#    datastreams (read_cleaned does that). A new model cannot read CO₂ unless
#    the owner grants it.
# 2. Register it: outputs() creates its datastream for each imported dataset,
#    using ordinary resource creation. Nothing else changes. The runner then
#    calls process() for each hour of the dataset, oldest first.
# 3. See it: restart the display client. The new field appears as a chip,
#    drawn by its schema type alone.
import numpy as np

from csmodel import Model, quantity, record, text, time_field


class WindChill(Model):
    id = "new-model-1"
    label = "New model 1"
    description = "Example: wind chill at the bow, every minute."
    window = 3600.0  # seconds of data per call to process(), aligned to the dataset's start

    async def outputs(self, api, ds):
        await api.create_datastream(self.system, {
            "name": f"Wind chill · {ds['id']}", "outputName": f"wind-chill__{ds['id']}",
            "schema": record("Wind chill", [
                time_field("time", "Start of the minute"), text("run_id", "Run"),
                quantity("wind_chill", "Wind chill", "Cel")])})
        return True

    async def process(self, api, ds, t0, t1, run):
        cols = await self.read_cleaned(api, ds["id"], "bow", t0, t1, run.source,
                                       ["air_temperature", "apparent_wind_speed"])
        minute = np.floor((cols["t"] - ds["start"]) / 60.0) * 60.0 + ds["start"]
        starts = np.unique(minute)
        if not len(starts):
            return
        T = np.array([np.nanmean(cols["air_temperature"][minute == m]) for m in starts])
        v = np.array([np.nanmean(cols["apparent_wind_speed"][minute == m]) for m in starts]) * 3.6  # km/h
        api.tap("scilibs", "numpy: wind chill", {"minutes": int(len(starts))})
        wc = 13.12 + 0.6215 * T - 11.37 * v ** 0.16 + 0.3965 * T * v ** 0.16
        out = f"{self.uid}|wind-chill__{ds['id']}"  # a datastream is named by its system and output name
        await api.publish_many(out, {"t": starts, "run_id": np.array([run.id] * len(starts), dtype=object),
                                          "wind_chill": np.round(wc, 2)})


MODEL = WindChill
