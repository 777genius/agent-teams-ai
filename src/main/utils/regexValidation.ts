/**
 * Regex Validation Utilities.
 *
 * Provides security validation for user-supplied regex patterns
 * to prevent ReDoS (Regular Expression Denial of Service) attacks.
 */

/**
 * Maximum allowed length for a regex pattern.
 */
const MAX_PATTERN_LENGTH = 100;

/**
 * Patterns that indicate potentially problematic regex constructs.
 * These can cause exponential backtracking (ReDoS).
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  // Nested quantifiers: (a+)+, (a*)+, (a+)*, (a*)*
  /\([^)]{0,50}[+*][^)]{0,50}\)[+*]/,
  // Overlapping alternation with quantifiers: (a|a)+
  /\([^)|]{0,50}\|[^)]{0,50}\)[+*]/,
  // Multiple quantifiers on same group: a{1,}+
  /[+*]\{/,
  /\}[+*]/,
  // Backreferences with quantifiers (can cause exponential time)
  /\\[1-9][+*]/,
  // Very long character classes with quantifiers
  /\[[^\]]{20}\][+*]/,
];

/**
 * Characters that need to be balanced in a valid regex.
 */
const BALANCED_PAIRS: [string, string][] = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
];

/**
 * Result of regex pattern validation.
 */
export interface RegexValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Checks if brackets in a string are balanced.
 */
function areBracketsBalanced(pattern: string): boolean {
  const stack: string[] = [];
  const openBrackets = new Map(BALANCED_PAIRS.map(([open, close]) => [open, close]));
  const closeBrackets = new Map(BALANCED_PAIRS.map(([open, close]) => [close, open]));

  let escaped = false;
  let inCharClass = false;

  for (const char of pattern) {
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    // Track character class state
    if (char === '[' && !inCharClass) {
      inCharClass = true;
      stack.push(char);
      continue;
    }

    if (char === ']' && inCharClass) {
      inCharClass = false;
      if (stack.length === 0 || stack[stack.length - 1] !== '[') {
        return false;
      }
      stack.pop();
      continue;
    }

    // Skip bracket matching inside character classes
    if (inCharClass) {
      continue;
    }

    if (openBrackets.has(char)) {
      stack.push(char);
    } else if (closeBrackets.has(char)) {
      const expectedOpen = closeBrackets.get(char);
      if (stack.length === 0 || stack[stack.length - 1] !== expectedOpen) {
        return false;
      }
      stack.pop();
    }
  }

  return stack.length === 0;
}

/**
 * Validates a regex pattern for safety and correctness.
 *
 * Security checks performed:
 * 1. Length limit (max 100 chars)
 * 2. Dangerous pattern detection (nested quantifiers, etc.)
 * 3. Balanced brackets
 * 4. Valid regex syntax (via RegExp constructor)
 *
 * @param pattern - The regex pattern to validate
 * @returns Validation result with error message if invalid
 */
export function validateRegexPattern(pattern: string): RegexValidationResult {
  // Empty pattern check
  if (!pattern || typeof pattern !== 'string') {
    return { valid: false, error: 'Pattern must be a non-empty string' };
  }

  // Length check
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return {
      valid: false,
      error: `Pattern too long (max ${MAX_PATTERN_LENGTH} characters)`,
    };
  }

  // Check for dangerous patterns that could cause ReDoS
  for (const dangerous of DANGEROUS_PATTERNS) {
    if (dangerous.test(pattern)) {
      return {
        valid: false,
        error: 'Pattern contains constructs that could cause performance issues',
      };
    }
  }

  // Check bracket balance
  if (!areBracketsBalanced(pattern)) {
    return {
      valid: false,
      error: 'Pattern has unbalanced brackets',
    };
  }

  // Try to compile the regex to check for syntax errors
  try {
    new RegExp(pattern);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return {
      valid: false,
      error: `Invalid regex syntax: ${message}`,
    };
  }

  return { valid: true };
}

/**
 * Creates a safe RegExp from a pattern, returning null if invalid.
 * This is a convenience wrapper that validates and creates the regex.
 *
 * @param pattern - The regex pattern
 * @param flags - Optional regex flags (default: 'i' for case-insensitive)
 * @returns The compiled RegExp or null if validation fails
 */
export function createSafeRegExp(pattern: string, flags: string = 'i'): RegExp | null {
  const validation = validateRegexPattern(pattern);
  if (!validation.valid) {
    return null;
  }

  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}
