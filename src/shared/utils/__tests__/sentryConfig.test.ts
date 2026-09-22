import { describe, expect, it } from 'vitest';

import { filterSafeSentryIntegrations, isValidDsn, redactSentryEvent } from '../sentryConfig';

describe('sentryConfig privacy helpers', () => {
  it('accepts only an HTTPS Sentry DSN with a public key and numeric project id', () => {
    expect(isValidDsn('https://public@example.ingest.sentry.io/4511088289120336')).toBe(true);
    expect(isValidDsn('http://public@example.com/1')).toBe(false);
    expect(isValidDsn('https://user:secret@example.com/1')).toBe(false);
    expect(isValidDsn('https://public@example.com/project')).toBe(false);
    expect(isValidDsn('not-a-url')).toBe(false);
  });

  it('redacts high-risk event data recursively', () => {
    const event = redactSentryEvent({
      message:
        'token sk-secretsecretsecret ANTHROPIC_AUTH_TOKEN=lmstudio at /Users/alice/work/private-repo',
      user: {
        email: 'dev@example.com',
      },
      extra: {
        accountUuid: 'd9b2d63a-582c-4d69-8a01-90e8199f532d',
        nested: [{ projectPath: '/home/bob/repo' }],
      },
    });

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('sk-secretsecretsecret');
    expect(serialized).not.toContain('lmstudio');
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('private-repo');
    expect(serialized).not.toContain('dev@example.com');
    expect(serialized).not.toContain('d9b2d63a-582c-4d69-8a01-90e8199f532d');
    expect(serialized).not.toContain('/home/bob');
  });

  it('filters default integrations that may collect PII-heavy context', () => {
    expect(
      filterSafeSentryIntegrations([
        { name: 'MainProcessSession' },
        { name: 'OnUncaughtException' },
        { name: 'Screenshots' },
        { name: 'SentryMinidump' },
        { name: 'ElectronContext' },
        { name: 'LocalVariables' },
        { name: 'ElectronBreadcrumbs' },
        { name: 'ScopeToMain' },
      ]).map((integration) => integration.name)
    ).toEqual(['MainProcessSession', 'OnUncaughtException', 'ScopeToMain']);
  });
});
