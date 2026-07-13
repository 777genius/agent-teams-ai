import { readFileSync } from 'node:fs';
import path from 'node:path';

import { extractInterpolationVariables } from '@features/localization/core/domain/catalogPolicy';
import { RESOLVED_APP_LOCALES } from '@features/localization/contracts';
import { describe, expect, it } from 'vitest';

const ACTION_KEYS = [
  'reconnect',
  'removeManagedCredential',
  'replaceCredential',
  'signInAgain',
] as const;
const RECONNECT_KEYS = [
  'apiDescription',
  'apiTitle',
  'continueInBrowser',
  'getBrowserCode',
  'oauthDescription',
  'oauthTitle',
  'replaceAndVerify',
] as const;

interface RuntimeProviderReconnectCatalog {
  runtimeProvider?: {
    actions?: Record<string, unknown>;
    reconnect?: Record<string, unknown>;
  };
}

function loadSettings(locale: string): RuntimeProviderReconnectCatalog {
  const filePath = path.join(
    process.cwd(),
    'src/features/localization/renderer/locales',
    locale,
    'settings.json'
  );
  return JSON.parse(readFileSync(filePath, 'utf8')) as RuntimeProviderReconnectCatalog;
}

describe('runtime provider reconnect translations', () => {
  it('keeps every reconnect key complete across supported locales', () => {
    const english = loadSettings('en').runtimeProvider;

    for (const locale of RESOLVED_APP_LOCALES) {
      const catalog = loadSettings(locale).runtimeProvider;
      for (const key of ACTION_KEYS) {
        expect(catalog?.actions?.[key], `${locale}: runtimeProvider.actions.${key}`).toBeTypeOf(
          'string'
        );
      }
      for (const key of RECONNECT_KEYS) {
        const value = catalog?.reconnect?.[key];
        expect(value, `${locale}: runtimeProvider.reconnect.${key}`).toBeTypeOf('string');
        expect(extractInterpolationVariables(String(value))).toEqual(
          extractInterpolationVariables(String(english?.reconnect?.[key]))
        );
      }
    }
  });
});
