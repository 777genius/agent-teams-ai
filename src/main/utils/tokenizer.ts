/**
 * Tokenizer utility for token counting.
 *
 * This module provides functions to estimate tokens in text content by
 * dividing character length by 4.
 *
 * Usage:
 * - Main process: Import and use directly
 * - Renderer: Token counts should be pre-computed in main process and passed via IPC
 */

/**
 * Count tokens in a string by dividing length by 4.
 * Uses character count estimation instead of exact tokenizer.
 *
 * @param text - The text to tokenize
 * @returns Number of tokens (estimated)
 */
export function countTokens(text: string | undefined | null): number {
  if (!text || text.length === 0) {
    return 0;
  }

  // Estimate tokens using character length / 4 approximation
  return Math.ceil(text.length / 4);
}

/**
 * Count tokens for content that may be a string or array.
 * Arrays are stringified before counting.
 *
 * @param content - String or array content
 * @returns Number of tokens
 */
export function countContentTokens(content: string | unknown[] | undefined | null): number {
  if (!content) {
    return 0;
  }

  if (typeof content === 'string') {
    return countTokens(content);
  }

  // For array content, stringify and count
  return countTokens(JSON.stringify(content));
}
