"""Declared constants of the demonstrator (SRD Version 3.2).

Bounds, limits and budgets are declared here once. Clients never hold bounds of
their own: they read them from the server's schemas.
"""

GENERATOR_VERSION = "3.2.0"

# --- Declared fictional location (FR-01) ---------------------------------
# Open ocean in the equatorial Atlantic. Used only to place the diurnal cycle
# and to draw the canal for scoring; the barge records no position (FR-10).
ORIGIN_LAT = -1.25
ORIGIN_LON = -24.75

# Simulation epoch: a fictional future date. Simulated time is UTC.
SIM_EPOCH_ISO = "2031-04-07T00:00:00Z"
SIM_EPOCH_UNIX = 1933286400

PREGEN_DAYS = 28  # FR-16: four weeks of history before the viewer arrives
RUN_DAYS = 35  # the timetable is declared beyond the pre-generated history

# --- Clock (FR-52, FR-53) ----------------------------------------------------
# Rate = simulated seconds per real second. The clock starts off (paused).
# The top rate is the fastest at which every icon stays legible; it was set by
# eye on a 1920x1080 display (decision log D-12) and is to be confirmed on the
# target presentation display.
CLOCK_RATES = [0.1, 0.25, 0.5, 1.0, 2.0]
CLOCK_DEFAULT_RATE = 0.5

# --- Boat ------------------------------------------------------------------
SENSOR_SEPARATION_M = 20.0
SPEED_LIMIT_MS = 2.0
CRUISE_SPEED_MS = 1.8
SLOW_SPEED_MS = 0.9

# --- Connected Systems server (FR-25, FR-29, FR-30, FR-44) -------------------
DEFAULT_LIMIT = 1000  # observations per page when no limit is given
MAX_LIMIT = 100_000  # FR-30: a larger page is refused, naming the limit
QUERY_BUDGET_MS = {  # FR-29 declared queries, per page, over four weeks
    "last-hour-each-sensor": 1500,
    "one-parameter-across-a-week": 30000,  # all pages of a week, one sensor
}
RETRY_AFTER_S = 2  # FR-44: Retry-After while the index rebuilds (seconds)
INDEX_CHUNK_RECORDS = 200_000  # records indexed per rebuild step

# --- Analysis bounds (FR-26): published as SWE Common constraints -------------
ANALYSIS_BOUNDS = {
    "window_hours": {"min": 0.25, "max": 168.0, "default": 12.0},
    "clusters": {"min": 2, "max": 8, "default": 4},
    "sensitivity": {"min": 1.0, "max": 10.0, "default": 5.0},
}
