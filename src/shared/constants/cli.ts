/**
 * CLI error message marker.
 *
 * All "CLI not found" error messages across main process services MUST
 * include this substring so the renderer can detect CLI-missing state
 * without relying on brittle string matching against the full message.
 */
export const CLI_NOT_FOUND_MARKER = 'CLI not found';

/**
 * User-facing message when CLI binary cannot be resolved.
 * Contains CLI_NOT_FOUND_MARKER so the renderer can detect it.
 */
export const CLI_NOT_FOUND_MESSAGE =
  'Claude CLI not found. Go to the Dashboard to install it automatically.';
