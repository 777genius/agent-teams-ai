/** Message ids accepted at the IPC boundary: a letter or digit, then `[A-Za-z0-9_-]`, 128 at most. */
export const MESSAGE_ID_MAX_LENGTH = 128;

export const MESSAGE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

const MESSAGE_ID_UNSAFE_CHARS = /[^A-Za-z0-9_-]/g;

/**
 * Fits a generated id into the message id charset and length: other characters become `_` and
 * the tail is cut. The value must already start with a letter or digit.
 */
export function toSafeMessageId(value: string): string {
  return value.replace(MESSAGE_ID_UNSAFE_CHARS, '_').slice(0, MESSAGE_ID_MAX_LENGTH);
}
