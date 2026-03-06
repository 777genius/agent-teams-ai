/**
 * Parses teamctl stdout into structured results.
 *
 * teamctl outputs in three formats:
 *   1. JSON — task create/get/list, attach, message send, kanban reviewers list
 *   2. "OK ..." text — status changes, comments, links, kanban moves, reviews
 *   3. Plain text — task briefing (multi-line human-readable report)
 */

/** Parse JSON from teamctl stdout (task create/get/list, attach, message send) */
export function parseJsonOutput<T = unknown>(stdout: string): T {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('Empty output from teamctl (expected JSON)');
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new Error(
      `Failed to parse teamctl JSON output: ${trimmed.slice(0, 200)}`,
    );
  }
}

/** Parse "OK ..." acknowledgment lines from teamctl */
export function parseOkOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.startsWith('OK ')) {
    return trimmed.slice(3); // Strip "OK " prefix, keep the rest
  }
  // Some commands output just "OK\n"
  if (trimmed === 'OK') {
    return 'OK';
  }
  // Return as-is if format is unexpected — don't throw
  return trimmed;
}

/** Return plain text as-is (briefing, help output) */
export function parseTextOutput(stdout: string): string {
  return stdout.trim();
}

/**
 * Format teamctl stderr into a user-friendly error message.
 * teamctl writes errors to stderr via `die(message)` and exits with code 1.
 */
export function formatError(stderr: string, stdout: string): string {
  const msg = stderr.trim() || stdout.trim();
  if (!msg) return 'Unknown teamctl error';
  return msg;
}
