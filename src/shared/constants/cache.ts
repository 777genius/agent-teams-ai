/**
 * Cache-related constants.
 */

/**
 * Maximum number of session details retained in the in-memory LRU cache.
 *
 * Users regularly juggle dozens of sessions — the previous cap of 5 caused
 * constant re-parsing of large JSONL files on every session switch. Raised
 * now that the per-entry footprint is bounded (the raw `messages` array is
 * stripped before caching; see `stripSessionDetailMessages`).
 */
export const MAX_CACHE_SESSIONS = 20;

/** Cache TTL in minutes */
export const CACHE_TTL_MINUTES = 5;

/** Cleanup interval in minutes */
export const CACHE_CLEANUP_INTERVAL_MINUTES = 5;
