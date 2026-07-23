/**
 * Canonical issue-key handling (spec §3).
 *
 * Issue keys look like `ABC-123`: an uppercase project key (letters, digits and
 * underscores, starting with a letter) followed by `-` and a number.
 */

/** Canonical issue-key pattern, anchored on word boundaries. */
export const ISSUE_KEY_PATTERN = "\\b[A-Z][A-Z0-9_]+-\\d+\\b";

/** Single-match regex (first occurrence). */
export const ISSUE_KEY_REGEX = new RegExp(ISSUE_KEY_PATTERN);

/** Global regex, for extracting every key in a string. Do not share `lastIndex`. */
const issueKeyRegexGlobal = () => new RegExp(ISSUE_KEY_PATTERN, "g");

/** True if the whole string is exactly one issue key. */
export function isIssueKey(value: string): boolean {
  return new RegExp(`^${ISSUE_KEY_PATTERN}$`).test(value);
}

/**
 * Extract the issue key from a branch name first, then a commit message
 * (spec §3: "extracted from branch name first, then commit message").
 * Returns the first match found, or `null`.
 */
export function extractIssueKey(
  branch?: string | null,
  message?: string | null,
): string | null {
  for (const source of [branch, message]) {
    if (!source) continue;
    const match = source.match(ISSUE_KEY_REGEX);
    if (match) return match[0];
  }
  return null;
}

/** Extract every issue key from a string, in order, de-duplicated. */
export function extractAllIssueKeys(text?: string | null): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  for (const match of text.matchAll(issueKeyRegexGlobal())) {
    seen.add(match[0]);
  }
  return [...seen];
}
