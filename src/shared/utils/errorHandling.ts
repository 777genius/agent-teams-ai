/**
 * Shared error handling utilities.
 *
 * Provides type-safe error message extraction and formatting
 * for use across both main and renderer processes.
 */

/**
 * Extracts a human-readable error message from an unknown error value.
 * Handles Error instances, strings, and other types safely.
 *
 * @param error - The error value (could be Error, string, or unknown)
 * @returns A string error message
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
