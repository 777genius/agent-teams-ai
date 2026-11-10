const API_ERROR_PATTERNS = [
  /^API Error:\s*\d{3}/i,
  /\byou're out of extra usage\b/i,
  /\brate[_\s-]?limit(?:ed)?\b/i,
  /\bquota (?:exhausted|exceeded)\b/i,
];

/**
 * High-confidence, actionable provider failures that justify raising an
 * "API error" notification (which advises the user that manual intervention is
 * needed). Deliberately stricter than {@link isApiErrorMessage}: it anchors on
 * an explicit `API Error: <status>` line or the specific out-of-usage notice,
 * so ordinary agent prose that merely mentions "rate limit" / "quota exceeded"
 * cannot trigger a spurious "Manual restart needed" alert. Genuine rate-limit
 * messages are handled separately by the rate-limit auto-resume path.
 */
const ACTIONABLE_API_ERROR_PATTERNS = [/^API Error:\s*\d{3}/i, /^\s*you're out of extra usage\b/i];

/**
 * Returns true for provider/API failures that should render as error output.
 *
 * Broad by design — used for surfacing quota/rate-limit hints in the activity
 * view (e.g. red styling). For deciding whether to raise an actionable
 * notification, use {@link isActionableApiErrorMessage} instead.
 */
export function isApiErrorMessage(text: string): boolean {
  return API_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Returns true only for high-confidence, actionable API failures that warrant a
 * user-facing "API error" notification. See {@link ACTIONABLE_API_ERROR_PATTERNS}.
 */
export function isActionableApiErrorMessage(text: string): boolean {
  return ACTIONABLE_API_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}
