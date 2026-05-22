import { describe, expect, it } from 'vitest';

import { filterSafeSentryIntegrations, redactSentryEvent } from '../sentryConfig';

describe('sentryConfig privacy helpers', () => {
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
