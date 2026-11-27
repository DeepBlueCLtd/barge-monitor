"""Declared constants of the demonstrator (SRD Version 4).

Bounds, limits and budgets are declared here once. Clients never hold bounds of
their own: they read them from the server's schemas.
"""

GENERATOR_VERSION = "4.0.0"

# --- Declared fictional location (FR-01) ---------------------------------
# Open ocean in the equatorial Atlantic. Used only to place the diurnal cycle
# and to draw the canal for scoring; the barge records no position (FR-10).
ORIGIN_LAT = -1.25
ORIGIN_LON = -24.75

# Simulation epoch: a fictional future date. Simulated time is UTC.
SIM_EPOCH_ISO = "2031-04-07T00:00:00Z"
SIM_EPOCH_UNIX = 1933286400

RUN_DAYS = 35  # the data folder's world (world.py) declares its timetable this far

# --- Boat ------------------------------------------------------------------
SENSOR_SEPARATION_M = 20.0
SPEED_LIMIT_MS = 2.0
CRUISE_SPEED_MS = 1.8
SLOW_SPEED_MS = 0.9

# --- Connected Systems server (FR-25, FR-29, FR-30, FR-44) -------------------
DEFAULT_LIMIT = 1000  # observations per page when no limit is given
MAX_LIMIT = 100_000  # FR-30: a larger page is refused, naming the limit
QUERY_BUDGET_MS = {  # FR-31 declared queries over a dataset
    "last-hour-each-sensor": 1500,  # raw records, both sensors
    "one-field-four-weeks-summary": 1000,  # one field from an hourly summary datastream
}
COMMAND_HOLD_S = 5.0  # §9.1: a command's POST is answered after this hold, in real seconds (OpenSensorHub: ~29.5 s unheard)

# --- CSV importer (FR-20 to FR-22, interfaces §7) ---------------------------------
ROWS_PER_MESSAGE = 1000  # one captured bulk-write message per this many rows (FR-67)

# --- Models (FR-33..FR-37) ------------------------------------------------------
