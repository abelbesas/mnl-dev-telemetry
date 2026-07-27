import { z } from "zod";

/**
 * Device-authorization flow contract (spec §4.3, item 1).
 *
 * A headless CLI (`@devpulse/setup`) cannot complete an interactive SSO login,
 * so it uses an OAuth-2.0-device-flow-style handshake:
 *
 *   1. CLI  → POST /api/auth/device/start           → { device_code, user_code, ... }
 *   2. human→ POST /api/auth/device/approve         (enters user_code in the dashboard)
 *   3. CLI  → POST /api/auth/device/token (poll)    → { status: "approved", token }
 *
 * The agent token is minted server-side at approval and handed to the CLI on
 * its next poll. As with every external payload, these schemas live ONLY here
 * in packages/shared and are reused by both the dashboard routes (validation)
 * and the CLI (construction/parsing).
 */

/** Human-entered code shape, e.g. `WDJB-MJHT`. */
export const USER_CODE_REGEX = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

// --- start ----------------------------------------------------------------

/** Response to POST /api/auth/device/start. */
export const deviceStartResponseSchema = z.object({
  /** Secret the CLI polls with; never shown to the human. */
  device_code: z.string().min(16),
  /** Short code the human types into the dashboard to approve. */
  user_code: z.string().regex(USER_CODE_REGEX),
  /** Where the human should go to approve. */
  verification_uri: z.string().url(),
  /** Recommended poll interval, seconds. */
  interval: z.number().int().positive(),
  /** Lifetime of the codes, seconds. */
  expires_in: z.number().int().positive(),
});
export type DeviceStartResponse = z.infer<typeof deviceStartResponseSchema>;

// --- token (poll) ---------------------------------------------------------

export const deviceTokenRequestSchema = z.object({
  device_code: z.string().min(16),
});
export type DeviceTokenRequest = z.infer<typeof deviceTokenRequestSchema>;

export const DEVICE_TOKEN_STATUSES = [
  "pending",
  "approved",
  "denied",
  "expired",
] as const;

/**
 * Response to a poll. `token` is present exactly once, on the first poll after
 * approval; subsequent polls report the grant already claimed via `error`.
 */
export const deviceTokenResponseSchema = z.object({
  status: z.enum(DEVICE_TOKEN_STATUSES),
  token: z.string().optional(),
  token_label: z.string().optional(),
  /** Machine-readable error slug, e.g. `already_claimed`. */
  error: z.string().optional(),
});
export type DeviceTokenResponse = z.infer<typeof deviceTokenResponseSchema>;

// --- approve --------------------------------------------------------------

/**
 * Approval payload. In Phase 4 this route becomes SSO-gated and derives the
 * user from the session; for now the caller supplies the identity so the flow
 * is exercisable without the dashboard UI (spec §4.3: "UI later").
 */
export const deviceApproveRequestSchema = z.object({
  user_code: z.string().regex(USER_CODE_REGEX),
  email: z.string().email(),
  name: z.string().min(1).max(255).optional(),
  /** Optional label for the minted token, e.g. the machine hostname. */
  label: z.string().min(1).max(255).optional(),
});
export type DeviceApproveRequest = z.infer<typeof deviceApproveRequestSchema>;

export const deviceApproveResponseSchema = z.object({
  ok: z.literal(true),
  user_code: z.string(),
});
export type DeviceApproveResponse = z.infer<typeof deviceApproveResponseSchema>;
