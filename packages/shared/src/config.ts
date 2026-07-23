/**
 * Shared constants — the single source of truth for values that the hooks,
 * MCP server, ingestion API and stitching job must all agree on.
 *
 * These are the defaults referenced by spec §7. Server-side code may still
 * override them from environment variables, but the numbers live here so that
 * every component computes the same thing.
 */

/** Gap (minutes) after which the stitcher closes a task session (spec §4.2). */
export const STITCH_GAP_MINUTES = 45;

/** Default timezone used to clamp sessions to working hours (spec §4.2). */
export const DEFAULT_TZ = "Asia/Manila";

/** Default working-hours window (24h "HH:MM"), used for clamping (spec §4.2). */
export const WORKDAY_START = "09:00";
export const WORKDAY_END = "18:00";

/** Max events accepted in a single ingestion batch. Guards against runaway loops. */
export const MAX_EVENTS_PER_BATCH = 500;

/** Prefix for generated agent tokens, for easy recognition / grepping. */
export const AGENT_TOKEN_PREFIX = "dp_";
