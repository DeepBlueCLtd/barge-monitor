// Declared constants of the stand-in back end (docs/v4-interfaces.md). The
// Python back end declares the same values; one that differs is a bug.

/** The CSV dialect's epoch, 1994-01-01T00:00:00Z; `T_HS94` counts half-seconds from it (§5). */
export const LOGGER_EPOCH_UNIX = 757382400;
export const KNOT = 0.514444; // m/s
export const SENSORS = ['bow', 'stern'] as const;
export type Sensor = (typeof SENSORS)[number];
export const PREFIX: Record<Sensor, string> = { bow: 'BOW', stern: 'STN' };

// --- replay (§4, §8) -----------------------------------------------------------------------
export const RATES = [0.1, 0.5, 1, 10, 100];
/** A failing model is skipped by models_ready after this many real seconds (§8). */
export const MODELS_READY_SKIP_S = 10;

// --- server (§9) -----------------------------------------------------------------------------
/** OpenSensorHub's default page size; a larger `limit` is not refused (§9.1). */
export const DEFAULT_LIMIT = 100;
/** Real seconds a sender's command POST is held before it is answered (§9.1). */
export const COMMAND_HOLD_S = 5;
/** Real seconds a server start takes, during which connections are refused (§9.1). */
export const START_S = 1;
/** Rows per captured bulk write (FR-67). */
export const BULK_ROWS = 1000;

export const SOSA = 'http://www.w3.org/ns/sosa/';
export const URN = 'urn:x-barge:';
export const DEF = 'https://deepbluecltd.github.io/barge-monitor/def/';
export const PROFILE_URI = 'https://deepbluecltd.github.io/barge-monitor/profile/v4.6';

export const UID = {
  barge: 'urn:x-barge:platform:barge',
  sensor: (s: string) => `urn:x-barge:sensor:${s}`,
  co2: (s: string) => `urn:x-barge:sensor:${s}:co2`,
  importer: 'urn:x-barge:importer',
  replay: 'urn:x-barge:replay',
  models: 'urn:x-barge:process:models',
  model: (m: string) => `urn:x-barge:process:${m}`,
  restricted: (m: string) => `urn:x-barge:process:${m}:restricted`,
  workspace: (u: string) => `urn:x-barge:workspace:${u}`,
};
