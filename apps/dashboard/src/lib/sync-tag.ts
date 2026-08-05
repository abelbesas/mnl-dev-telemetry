/**
 * The idempotency tag carried in every worklog description we push (spec §4.6,
 * brief §6E).
 *
 * This is the whole retry-safety story: Tempo has no idempotency key, so before
 * creating a worklog we search for one already carrying this draft's tag. A
 * push that timed out after Tempo committed is therefore observable on retry,
 * and never double-logs.
 *
 * Pure and dependency-free so the format is directly testable — it is a
 * persistent, cross-system contract, not an implementation detail.
 */

export const SYNC_TAG_PREFIX = "mnl-dev-telemetry";

/** `[mnl-dev-telemetry:<draft_id>]` */
export function buildSyncTag(draftId: string): string {
  return `[${SYNC_TAG_PREFIX}:${draftId}]`;
}

/**
 * Compose the description Tempo stores: the human text plus the tag. The tag is
 * appended (never prepended) so a dev reading their Tempo timesheet sees their
 * own words first.
 */
export function buildWorklogDescription(
  description: string | null | undefined,
  draftId: string,
): string {
  const tag = buildSyncTag(draftId);
  const text = (description ?? "").trim();
  return text ? `${text} ${tag}` : tag;
}

/**
 * Extract the draft id from a description, or null when it carries no tag of
 * ours. Tolerates surrounding text and whitespace inside the brackets, since a
 * human may have edited the description in Tempo.
 */
export function parseSyncTag(description: string | null | undefined): string | null {
  if (!description) return null;
  const match = new RegExp(`\\[\\s*${SYNC_TAG_PREFIX}\\s*:\\s*([^\\]\\s]+)\\s*\\]`).exec(
    description,
  );
  return match?.[1] ?? null;
}

/** True when `description` carries this exact draft's tag. */
export function hasSyncTag(
  description: string | null | undefined,
  draftId: string,
): boolean {
  return parseSyncTag(description) === draftId;
}

/** Strip our tag, for showing a clean description back in the dashboard. */
export function stripSyncTag(description: string | null | undefined): string {
  if (!description) return "";
  return description
    .replace(new RegExp(`\\[\\s*${SYNC_TAG_PREFIX}\\s*:\\s*[^\\]\\s]+\\s*\\]`, "g"), "")
    .trim();
}
