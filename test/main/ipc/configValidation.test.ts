import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { RESOLVED_APP_LOCALES } from '../../../src/features/localization/contracts';
import { validateConfigUpdatePayload } from '../../../src/main/ipc/configValidation';

describe('configValidation', () => {
  it('accepts valid general updates', () => {
    const result = validateConfigUpdatePayload('general', {
      theme: 'system',
      launchAtLogin: true,
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.section).toBe('general');
      expect(result.data).toEqual({
        theme: 'system',
        launchAtLogin: true,
      });
    }
  });

  it('accepts general.autoExpandAIGroups boolean toggle', () => {
    const resultOn = validateConfigUpdatePayload('general', { autoExpandAIGroups: true });
    expect(resultOn.valid).toBe(true);
    if (resultOn.valid) {
      expect(resultOn.data).toEqual({ autoExpandAIGroups: true });
    }

    const resultOff = validateConfigUpdatePayload('general', { autoExpandAIGroups: false });
    expect(resultOff.valid).toBe(true);
    if (resultOff.valid) {
      expect(resultOff.data).toEqual({ autoExpandAIGroups: false });
    }
  });

  it('rejects non-boolean general.autoExpandAIGroups', () => {
    const result = validateConfigUpdatePayload('general', { autoExpandAIGroups: 'yes' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('boolean');
    }
  });

  it.each(RESOLVED_APP_LOCALES)('accepts supported general.appLocale update %s', (appLocale) => {
    const result = validateConfigUpdatePayload('general', { appLocale });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data).toEqual({ appLocale });
    }
  });

  it('accepts system general.appLocale updates', () => {
    const result = validateConfigUpdatePayload('general', { appLocale: 'system' });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data).toEqual({ appLocale: 'system' });
    }
  });

  it('rejects unsupported general.appLocale updates', () => {
    const result = validateConfigUpdatePayload('general', { appLocale: 'xx' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('supported app locale');
    }
  });

  it('accepts absolute general.claudeRootPath updates', () => {
    const result = validateConfigUpdatePayload('general', {
      claudeRootPath: '/Users/test/.claude',
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.section).toBe('general');
      expect(result.data).toEqual({
        claudeRootPath: path.resolve('/Users/test/.claude'),
      });
    }
  });

  it('rejects relative general.claudeRootPath updates', () => {
    const result = validateConfigUpdatePayload('general', {
      claudeRootPath: '.claude',
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('absolute path');
    }
  });

  it('rejects invalid section names', () => {
    const result = validateConfigUpdatePayload('invalid-section', { theme: 'dark' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Section must be one of');
    }
  });

  it('rejects unknown notification keys', () => {
    const result = validateConfigUpdatePayload('notifications', { unknownField: true });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('not supported');
    }
  });

  it('accepts valid notifications.triggers payload', () => {
    const result = validateConfigUpdatePayload('notifications', {
      triggers: [
        {
          id: 'trigger-1',
          name: 'test',
          enabled: true,
          contentType: 'tool_result',
          mode: 'error_status',
          requireError: true,
        },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it('rejects invalid notifications.triggers payload', () => {
    const result = validateConfigUpdatePayload('notifications', {
      triggers: [{ id: 'missing-required-fields' }],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('valid trigger');
    }
  });

  it.each([
    'notifyOnLeadInbox',
    'notifyOnUserInbox',
    'notifyOnClarifications',
    'notifyOnStatusChange',
    'notifyOnTeamLaunched',
    'autoResumeOnRateLimit',
    'statusChangeOnlySolo',
  ] as const)('accepts boolean %s toggle', (key) => {
    const resultOn = validateConfigUpdatePayload('notifications', { [key]: true });
    expect(resultOn.valid).toBe(true);
    if (resultOn.valid) {
      expect(resultOn.data).toEqual({ [key]: true });
    }

    const resultOff = validateConfigUpdatePayload('notifications', { [key]: false });
    expect(resultOff.valid).toBe(true);
    if (resultOff.valid) {
      expect(resultOff.data).toEqual({ [key]: false });
    }
  });

  it.each([
    'notifyOnLeadInbox',
    'notifyOnUserInbox',
    'notifyOnClarifications',
    'notifyOnStatusChange',
    'notifyOnTeamLaunched',
    'autoResumeOnRateLimit',
    'statusChangeOnlySolo',
  ] as const)('rejects non-boolean %s', (key) => {
    const result = validateConfigUpdatePayload('notifications', { [key]: 'yes' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('boolean');
    }
  });

  it('accepts valid statusChangeStatuses string array', () => {
    const result = validateConfigUpdatePayload('notifications', {
      statusChangeStatuses: ['completed', 'in_progress'],
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data).toEqual({ statusChangeStatuses: ['completed', 'in_progress'] });
    }
  });

  it('accepts empty statusChangeStatuses array', () => {
    const result = validateConfigUpdatePayload('notifications', {
      statusChangeStatuses: [],
    });
    expect(result.valid).toBe(true);
  });

  it('rejects non-array statusChangeStatuses', () => {
    const result = validateConfigUpdatePayload('notifications', {
      statusChangeStatuses: true,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('string[]');
    }
  });

  it('rejects statusChangeStatuses with non-string items', () => {
    const result = validateConfigUpdatePayload('notifications', {
      statusChangeStatuses: [42],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('string[]');
    }
  });

  it('rejects out-of-range snoozeMinutes', () => {
    const result = validateConfigUpdatePayload('notifications', { snoozeMinutes: 0 });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('between 1 and');
    }
  });

  it('accepts valid display updates', () => {
    const result = validateConfigUpdatePayload('display', {
      compactMode: true,
      syntaxHighlighting: false,
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.section).toBe('display');
      expect(result.data).toEqual({
        compactMode: true,
        syntaxHighlighting: false,
      });
    }
  });

  it('accepts loopback httpServer host updates', () => {
    const result = validateConfigUpdatePayload('httpServer', {
      enabled: true,
      port: 4567,
      host: '127.0.0.1',
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data).toEqual({
        enabled: true,
        port: 4567,
        host: '127.0.0.1',
      });
    }
  });

  it('rejects non-loopback httpServer host updates', () => {
    const result = validateConfigUpdatePayload('httpServer', {
      host: '0.0.0.0',
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('loopback');
    }
  });

  it('normalizes legacy Codex provider connection updates to the native-only config shape', () => {
    const result = validateConfigUpdatePayload('providerConnections', {
      codex: {
        apiKeyBetaEnabled: true,
        authMode: 'api_key',
      },
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data).toEqual({
        codex: {},
      });
    }
  });

  it('drops unsupported legacy Codex auth modes during providerConnections migration', () => {
    const result = validateConfigUpdatePayload('providerConnections', {
      codex: {
        authMode: 'auto',
      },
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data).toEqual({
        codex: {},
      });
    }
  });

  it('accepts Codex custom provider profile updates', () => {
    const result = validateConfigUpdatePayload('providerConnections', {
      codex: {
        preferredAuthMode: 'api_key',
        customProvider: {
          enabled: true,
          baseUrl: ' http://127.0.0.1:8080/v1 ',
          model: ' gateway-codex-model ',
        },
      },
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data).toEqual({
        codex: {
          preferredAuthMode: 'api_key',
          customProvider: {
            enabled: true,
            baseUrl: 'http://127.0.0.1:8080/v1',
            model: 'gateway-codex-model',
          },
        },
      });
    }
  });

  it('allows disabling Codex custom provider while keeping empty fields', () => {
    const result = validateConfigUpdatePayload('providerConnections', {
      codex: {
        customProvider: {
          enabled: false,
          baseUrl: '',
          model: '',
        },
      },
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data).toEqual({
        codex: {
          customProvider: {
            enabled: false,
            baseUrl: '',
            model: '',
          },
        },
      });
    }
  });

  it.each([
    ['ftp://gateway.example.com/v1', 'http:// or https://'],
    ['https://user:token@gateway.example.com/v1', 'credentials'],
    ['https://gateway.example.com/v1?token=secret', 'query or fragment'],
    ['https://gateway.example.com/v1#token', 'query or fragment'],
    ['not a url', 'valid URL'],
  ])('rejects invalid Codex custom provider base URL %s', (baseUrl, expectedError) => {
    const result = validateConfigUpdatePayload('providerConnections', {
      codex: {
        customProvider: {
          enabled: true,
          baseUrl,
          model: 'gateway-codex-model',
        },
      },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain(expectedError);
    }
  });

  it('requires Codex custom provider model when enabled', () => {
    const result = validateConfigUpdatePayload('providerConnections', {
      codex: {
        customProvider: {
          enabled: true,
          baseUrl: 'https://gateway.example.com/v1',
          model: ' ',
        },
      },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('model is required');
    }
  });

  it.each([
    [`gateway\nmodel`, 'control characters'],
    ['m'.repeat(201), '200 characters or fewer'],
  ])('rejects invalid Codex custom provider model %s', (model, expectedError) => {
    const result = validateConfigUpdatePayload('providerConnections', {
      codex: {
        customProvider: {
          enabled: true,
          baseUrl: 'https://gateway.example.com/v1',
          model,
        },
      },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain(expectedError);
    }
  });

  it('rejects UI-derived Codex custom provider status fields', () => {
    const result = validateConfigUpdatePayload('providerConnections', {
      codex: {
        customProvider: {
          enabled: true,
          active: true,
          baseUrl: 'https://gateway.example.com/v1',
          model: 'gateway-codex-model',
        },
      },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('active is not a valid setting');
    }
  });

  it('accepts Anthropic-compatible endpoint provider connection updates', () => {
    const result = validateConfigUpdatePayload('providerConnections', {
      anthropic: {
        compatibleEndpoint: {
          enabled: true,
          baseUrl: ' http://localhost:1234/v1 ',
        },
      },
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data).toEqual({
        anthropic: {
          compatibleEndpoint: {
            enabled: true,
            baseUrl: 'http://localhost:1234/v1',
          },
        },
      });
    }
  });

  it.each([
    'https://api.anthropic.com',
    'https://api.anthropic.com:443/v1',
    'HTTPS://API.ANTHROPIC.COM/v1',
    'https://api-staging.anthropic.com',
    'http://token@localhost:1234',
    'http://user:pass@localhost:1234',
    'ftp://localhost:1234',
    'not a url',
  ])('rejects invalid Anthropic-compatible endpoint URL %s', (baseUrl) => {
    const result = validateConfigUpdatePayload('providerConnections', {
      anthropic: {
        compatibleEndpoint: {
          enabled: true,
          baseUrl,
        },
      },
    });

    expect(result.valid).toBe(false);
  });

  it('rejects UI-derived Anthropic-compatible endpoint status fields', () => {
    const result = validateConfigUpdatePayload('providerConnections', {
      anthropic: {
        compatibleEndpoint: {
          enabled: true,
          baseUrl: 'http://localhost:1234',
          tokenConfigured: true,
        },
      },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('tokenConfigured is not a valid setting');
    }
  });

  it('allows disabling Anthropic-compatible endpoint with an empty base URL', () => {
    const result = validateConfigUpdatePayload('providerConnections', {
      anthropic: {
        compatibleEndpoint: {
          enabled: false,
          baseUrl: '',
        },
      },
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data).toEqual({
        anthropic: {
          compatibleEndpoint: {
            enabled: false,
            baseUrl: '',
          },
        },
      });
    }
  });

  it('normalizes legacy Codex runtime backend updates to codex-native', () => {
    const apiResult = validateConfigUpdatePayload('runtime', {
      providerBackends: {
        codex: 'api',
      },
    });

    expect(apiResult.valid).toBe(true);
    if (apiResult.valid) {
      expect(apiResult.data).toEqual({
        providerBackends: {
          codex: 'codex-native',
        },
      });
    }

    const nativeResult = validateConfigUpdatePayload('runtime', {
      providerBackends: {
        codex: 'codex-native',
      },
    });

    expect(nativeResult.valid).toBe(true);
    if (nativeResult.valid) {
      expect(nativeResult.data).toEqual({
        providerBackends: {
          codex: 'codex-native',
        },
      });
    }
  });

  it('rejects unknown Codex runtime backends', () => {
    const result = validateConfigUpdatePayload('runtime', {
      providerBackends: {
        codex: 'native',
      },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('runtime.providerBackends.codex must be one of: codex-native');
    }
  });
});
