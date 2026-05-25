import {
  extractInterpolationVariables,
  validateCatalogCompleteness,
} from '@features/localization/core/domain/catalogPolicy';
import { describe, expect, it } from 'vitest';

describe('catalogPolicy', () => {
  it('accepts matching catalog shape', () => {
    const issues = validateCatalogCompleteness(
      {
        en: { common: { greeting: 'Hello {{name}}' } },
        pseudo: { common: { greeting: 'Hi {{name}}' } },
      },
      'en'
    );

    expect(issues).toEqual([]);
  });

  it('reports missing and extra keys', () => {
    const issues = validateCatalogCompleteness(
      {
        en: { common: { actions: { save: 'Save', cancel: 'Cancel' } } },
        pseudo: { common: { actions: { save: 'Save', close: 'Close' } } },
      },
      'en'
    );

    expect(issues.map((issue) => issue.type)).toEqual(['missing-key', 'extra-key']);
  });

  it('reports interpolation mismatches', () => {
    const issues = validateCatalogCompleteness(
      {
        en: { common: { greeting: 'Hello {{name}}' } },
        pseudo: { common: { greeting: 'Hello {{user}}' } },
      },
      'en'
    );

    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('interpolation-mismatch');
  });

  it('extracts sorted interpolation variables', () => {
    expect(extractInterpolationVariables('{{count}} items for {{name}}')).toEqual([
      'count',
      'name',
    ]);
  });
});
