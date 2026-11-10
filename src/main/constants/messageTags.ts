/**
 * Message Tag Constants
 *
 * Centralized XML tag string literals used in message parsing and filtering.
 */

// =============================================================================
// System Output Tags
// =============================================================================

/** Local command stdout wrapper tag */
export const LOCAL_COMMAND_STDOUT_TAG = '<local-command-stdout>';

/** Local command stderr wrapper tag */
export const LOCAL_COMMAND_STDERR_TAG = '<local-command-stderr>';

/** Local command caveat wrapper tag */
const LOCAL_COMMAND_CAVEAT_TAG = '<local-command-caveat>';

/** System reminder wrapper tag */
const SYSTEM_REMINDER_TAG = '<system-reminder>';

// =============================================================================
// Empty Output Tags
// =============================================================================

/** Empty stdout output */
export const EMPTY_STDOUT = '<local-command-stdout></local-command-stdout>';

/** Empty stderr output */
export const EMPTY_STDERR = '<local-command-stderr></local-command-stderr>';

// =============================================================================
// Tag Arrays for Filtering
// =============================================================================

/** Tags that indicate system output (excludes from User chunks) */
export const SYSTEM_OUTPUT_TAGS = [
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  SYSTEM_REMINDER_TAG,
] as const;

/** Tags that indicate hard noise (messages filtered completely) */
export const HARD_NOISE_TAGS = [LOCAL_COMMAND_CAVEAT_TAG, SYSTEM_REMINDER_TAG] as const;
