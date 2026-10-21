import { TEMPLATE_NAME_MAX_LENGTH } from './templateLimits';

import type { CustomTeamTemplateValidationIssue } from '@features/custom-team-templates/contracts';

/**
 * Deterministic uniqueness key for a template name.
 *
 * Uses locale-independent operations only: Unicode NFC normalization, trimming,
 * whitespace-run collapsing and `toLowerCase()` (never `toLocaleLowerCase()`).
 * Display capitalization is preserved separately.
 */
export function normalizeTemplateNameKey(rawName: string): string {
  return rawName.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Case-insensitive, whitespace-insensitive, Unicode-normalized name equality. */
export function areTemplateNamesEquivalent(left: string, right: string): boolean {
  return normalizeTemplateNameKey(left) === normalizeTemplateNameKey(right);
}

/**
 * Unicode control characters (Cc: C0 controls, DEL and the C1 block including
 * U+0085 NEL) plus the line separator U+2028 (Zl) and paragraph separator
 * U+2029 (Zp). Ordinary spaces are unaffected: they are Zs, not covered here.
 */
const CONTROL_OR_SEPARATOR_PATTERN = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** Rejects Unicode control characters and line/paragraph separators. */
function hasControlCharacter(value: string): boolean {
  return CONTROL_OR_SEPARATOR_PATTERN.test(value);
}

export type TemplateNameValidation =
  | { valid: true; value: string; normalizedKey: string }
  | { valid: false; issues: readonly CustomTeamTemplateValidationIssue[] };

/**
 * Validates a template display name.
 *
 * Returns explicit validation outcomes instead of throwing, never truncates
 * oversized input, and preserves the intended capitalization in `value`.
 */
export function validateTemplateName(rawName: unknown): TemplateNameValidation {
  if (typeof rawName !== 'string') {
    return { valid: false, issues: [{ code: 'templateNameRequired', field: 'name' }] };
  }
  const value = rawName.normalize('NFC').trim();
  if (!value) {
    return { valid: false, issues: [{ code: 'templateNameRequired', field: 'name' }] };
  }
  if (value.length > TEMPLATE_NAME_MAX_LENGTH) {
    return { valid: false, issues: [{ code: 'templateNameTooLong', field: 'name' }] };
  }
  if (hasControlCharacter(value)) {
    return { valid: false, issues: [{ code: 'templateNameInvalidCharacters', field: 'name' }] };
  }
  return { valid: true, value, normalizedKey: normalizeTemplateNameKey(value) };
}

/**
 * Finds an existing custom template whose name normalizes to the candidate key.
 *
 * Uniqueness is case-insensitive; the existing template's original
 * capitalization is untouched because only its id is returned.
 */
export function findTemplateNameConflict(
  candidateName: string,
  existing: readonly { templateId: string; name: string }[]
): { templateId: string } | null {
  const candidateKey = normalizeTemplateNameKey(candidateName);
  if (!candidateKey) {
    return null;
  }
  for (const template of existing) {
    if (normalizeTemplateNameKey(template.name) === candidateKey) {
      return { templateId: template.templateId };
    }
  }
  return null;
}
