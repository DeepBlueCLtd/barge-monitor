// Declared constants of the stand-in back end. Each one mirrors the Python
// reference (backend/barge/config.py, logger.py): PR-06, the Python back end
// is the reference, so a constant that differs here is a stand-in bug.

/** Simulation epoch, 2031-04-07T00:00:00Z (config.SIM_EPOCH_UNIX). */
export const SIM_EPOCH_UNIX = 1933286400;
/** The logger's own epoch, 1994-01-01T00:00:00Z, counted in half-seconds (logger.py, FR-17). */
export const LOGGER_EPOCH_UNIX = 757382400;
export const TICKS_PER_SECOND = 2;
/** One fixed-width record, newline included (logger.py). */
export const REC_LEN = 48;
/** The logger flushes in chunks and holds back part of the last record (FR-17). */
export const FLUSH_HOLDBACK = 17;
export const FILE_PREFIX: Record<string, string> = { bow: 'BOW', stern: 'STN' };
export const SENSOR_OF_PREFIX: Record<string, string> = { BOW: 'bow', STN: 'stern' };
export const PRECIP_CODES = 'NDRS';
export const SENSORS = ['bow', 'stern'] as const;
export type Sensor = (typeof SENSORS)[number];

// --- Clock (FR-77, FR-78) ---------------------------------------------------------
export const CLOCK_RATES = [0.25, 0.5, 1.0];
export const CLOCK_DEFAULT_RATE = 0.5;

// --- Connected Systems server (FR-25, FR-30, FR-47) ---------------------------------
export const DEFAULT_LIMIT = 1000;
export const MAX_LIMIT = 100_000;
export const RETRY_AFTER_S = 2;
export const INDEX_CHUNK_RECORDS = 200_000;

// --- Models (FR-33..FR-37) ------------------------------------------------------------

export const SOSA = 'http://www.w3.org/ns/sosa/';
export const URN = 'urn:x-barge:';
export const DEF = 'https://deepbluecltd.github.io/barge-monitor/def/';
export const PROFILE_URI = 'https://deepbluecltd.github.io/barge-monitor/profile/v4';
