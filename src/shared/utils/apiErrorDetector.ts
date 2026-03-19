/**
 * Detects API error messages from Claude CLI output.
 * Pattern: "API Error: <status_code>" at the beginning of the text.
 */

const API_ERROR_RE = /^API Error:\s*\d{3}/;

/**
 * Returns true if the message text starts with "API Error: <status_code>".
 */
export function isApiErrorMessage(text: string): boolean {
  return API_ERROR_RE.test(text);
}
