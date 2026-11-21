# Model C: an example new model (FR-36). Edit it, then press Run.
#
# 1. Write it: Python, using the scientific libraries, reading observations
#    from the data server. Read Data cleanse's or Model A's output, never the
#    raw datastreams.
# 2. Register it: setup() creates a process system and a datastream, using
#    ordinary resource creation. Nothing else changes.
# 3. See it: restart the display client. The new field appears as a chip,
#    drawn by its schema type alone.
import numpy as np

from csmodel import Model, quantity, record, time_field


class WindChill(Model):
    id = "model-c"
    label = "Model C"
    description = "Example: wind chill at the bow, every minute."
    interval = 60.0  # simulated seconds between steps
    catch_up_chunk = 86400.0
    start_from = "history"

    async def setup(self, api):
        await super().setup(api)  # creates the process system under Models
        self.source = await api.find("urn:x-barge:process:model-a", "summary-1min-bow")
        self.out = await api.create_datastream(self.system, {
            "name": "Wind chill", "outputName": "wind-chill",
            "schema": record("Wind chill", [
                time_field("time", "Start of the minute"),
                quantity("wind_chill", "Wind chill", "Cel")])})

    async def step(self, api, t0, t1):
        cols = await api.read(self.source, t0, t1, ["air_temperature", "apparent_wind_speed"])
        if not len(cols["t"]):
            return t0
        T = np.asarray(cols["air_temperature"], dtype=float)
        v = np.asarray(cols["apparent_wind_speed"], dtype=float) * 3.6  # km/h
        api.tap("scilibs", "numpy: wind chill", {"rows": int(len(T))})
        wc = 13.12 + 0.6215 * T - 11.37 * v ** 0.16 + 0.3965 * T * v ** 0.16
        await api.publish(self.out, {"t": cols["t"], "wind_chill": np.round(wc, 2)})
        return float(cols["t"][-1]) + 60.0


MODEL = WindChill
