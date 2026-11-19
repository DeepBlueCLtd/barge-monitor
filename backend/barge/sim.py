"""The simulated system: world, clock, sensors, logger and the adapter's view.

``Simulation.tick()`` brings the logger up to the clock. The EDR server is
handed the simulation so that each request first ticks, then reads the store
as it stands (FR-18).
"""
from __future__ import annotations

from . import config as C
from .adapter import StoreAdapter
from .clock import SimClock
from .logger import Logger
from .sensors import Sensors
from .truth import World
from .world import generate


class Simulation:
    def __init__(self, seed: int = 1, clock=None, warm_start: float = C.WARM_START_S):
        self.seed = seed
        self.manifest = generate(seed)
        self.world = World(self.manifest)
        self.clock = clock if clock is not None else SimClock(start=warm_start)
        self.logger = Logger()
        self.sensors = Sensors(self.world, self.logger)
        self.adapter = StoreAdapter(self.logger)
        self.tick()

    def tick(self) -> int:
        """Sample every second up to the clock's now. Returns records per sensor."""
        return self.sensors.sample_until(self.clock.now() + 1)

    def now(self) -> float:
        return self.sensors.next_t - 1
