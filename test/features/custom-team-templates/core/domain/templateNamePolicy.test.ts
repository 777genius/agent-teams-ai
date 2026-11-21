import { TEMPLATE_NAME_MAX_LENGTH } from '@features/custom-team-templates/core/domain/templateLimits';
import {
  areTemplateNamesEquivalent,
  findTemplateNameConflict,
  normalizeTemplateNameKey,
  validateTemplateName,
} from '@features/custom-team-templates/core/domain/templateNamePolicy';
import { describe, expect, it } from 'vitest';

describe('templateNamePolicy', () => {
  it('trims and normalizes the key while preserving display capitalization', () => {
    const result = validateTemplateName('  Product   Team  ');
    expect(result).toEqual({
      valid: true,
      value: 'Product   Team',
      normalizedKey: 'product team',
    });
  });

  it('compares names case-insensitively across whitespace and Unicode forms', () => {
    expect(areTemplateNamesEquivalent('Product Team', 'product team')).toBe(true);
    expect(areTemplateNamesEquivalent('A  B', 'a b')).toBe(true);
    expect(areTemplateNamesEquivalent('Cafe\u0301 Team', 'Café Team')).toBe(true);
    expect(areTemplateNamesEquivalent('Team A', 'Team B')).toBe(false);
  });

  it('rejects blank and non-string names', () => {
    expect(validateTemplateName('   ')).toEqual({
      valid: false,
      issues: [{ code: 'templateNameRequired', field: 'name' }],
    });
    expect(validateTemplateName(42)).toEqual({
      valid: false,
      issues: [{ code: 'templateNameRequired', field: 'name' }],
    });
  });

  it('rejects oversized names without truncating them', () => {
    const oversized = 'a'.repeat(TEMPLATE_NAME_MAX_LENGTH + 1);
    expect(validateTemplateName(oversized)).toEqual({
      valid: false,
      issues: [{ code: 'templateNameTooLong', field: 'name' }],
    });
  });

  it('accepts a name at the exact length bound', () => {
    const atBound = 'a'.repeat(TEMPLATE_NAME_MAX_LENGTH);
    expect(validateTemplateName(atBound)).toEqual({
      valid: true,
      value: atBound,
      normalizedKey: atBound,
    });
  });

  it('rejects control characters', () => {
    expect(validateTemplateName('Bad\nName')).toEqual({
      valid: false,
      issues: [{ code: 'templateNameInvalidCharacters', field: 'name' }],
    });
  });

  it('rejects Unicode control characters and line/paragraph separators', () => {
    // U+0085 (NEL, Cc), U+2028 (LINE SEPARATOR, Zl), U+2029 (PARAGRAPH SEPARATOR, Zp).
    for (const embedded of ['Bad\u0085Name', 'Bad\u2028Name', 'Bad\u2029Name']) {
      expect(validateTemplateName(embedded)).toEqual({
        valid: false,
        issues: [{ code: 'templateNameInvalidCharacters', field: 'name' }],
      });
    }
    // Ordinary spaces (Zs) stay allowed.
    expect(validateTemplateName('Bad Name').valid).toBe(true);
  });

  it('rejects control characters at the start or end before trimming', () => {
    for (const char of ['\n', '\r', '\t', '\u2028', '\u2029', '\u0085']) {
      expect(validateTemplateName(`${char}Name`)).toEqual({
        valid: false,
        issues: [{ code: 'templateNameInvalidCharacters', field: 'name' }],
      });
      expect(validateTemplateName(`Name${char}`)).toEqual({
        valid: false,
        issues: [{ code: 'templateNameInvalidCharacters', field: 'name' }],
      });
    }
  });

  it('trims ordinary leading and trailing spaces from valid names', () => {
    const result = validateTemplateName('  Product Team  ');
    expect(result).toEqual({
      valid: true,
      value: 'Product Team',
      normalizedKey: 'product team',
    });
  });
  it('finds the existing template whose name normalizes to the same key', () => {
    const existing = [
      { templateId: 'template-1', name: 'Product Team' },
      { templateId: 'template-2', name: 'Marketing' },
    ];
    expect(findTemplateNameConflict('  product   team ', existing)).toEqual({
      templateId: 'template-1',
    });
    expect(findTemplateNameConflict('Content Studio', existing)).toBeNull();
    expect(findTemplateNameConflict('   ', existing)).toBeNull();
  });

  it('normalizes a key deterministically', () => {
    expect(normalizeTemplateNameKey('  Café   Team ')).toBe('café team');
  });
});
