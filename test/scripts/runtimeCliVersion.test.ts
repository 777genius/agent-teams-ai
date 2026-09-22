import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

interface RuntimeCliVersionModule {
  formatRuntimeVersionForDisplay(output: string): string;
  getExpectedRuntimeCliVersion(lock: { version: string; cliVersion?: unknown }): string;
  matchesRuntimeCliVersion(output: unknown, expectedVersion: string): boolean;
}

async function loadModule(): Promise<RuntimeCliVersionModule> {
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), 'scripts/lib/runtime-cli-version.mjs')
  ).href;
  return (await import(moduleUrl)) as RuntimeCliVersionModule;
}

describe('runtime CLI version contract', () => {
  it('displays the compatibility version with the orchestrator label', async () => {
    const { formatRuntimeVersionForDisplay } = await loadModule();
    expect(formatRuntimeVersionForDisplay('2.1.251 (Claude Code)\n')).toBe(
      '2.1.251 (teams orchestrator)'
    );
    expect(formatRuntimeVersionForDisplay('')).toBe('teams orchestrator');
  });

  it('accepts a pinned compatibility version that differs from the release identity', async () => {
    const { getExpectedRuntimeCliVersion, matchesRuntimeCliVersion } = await loadModule();
    const lock = { version: '0.0.79', cliVersion: '2.1.251' };
    const expected = getExpectedRuntimeCliVersion(lock);

    expect(expected).toBe('2.1.251');
    expect(matchesRuntimeCliVersion('2.1.251 (Claude Code)\n', expected)).toBe(true);
    expect(matchesRuntimeCliVersion('0.0.79 (Claude Code)', expected)).toBe(false);
    expect(lock.version).toBe('0.0.79');
  });

  it('preserves the release version contract for legacy locks', async () => {
    const { getExpectedRuntimeCliVersion, matchesRuntimeCliVersion } = await loadModule();
    const expected = getExpectedRuntimeCliVersion({ version: '0.0.78' });

    expect(expected).toBe('0.0.78');
    expect(matchesRuntimeCliVersion('0.0.78 (Claude Code)', expected)).toBe(true);
    expect(matchesRuntimeCliVersion('2.1.251 (Claude Code)', expected)).toBe(false);
  });

  it.each([undefined, null, 251, '', '  ', 'compatible', '2.1', '2.1.251 (Claude Code)'])(
    'rejects an explicitly invalid CLI version instead of silently falling back: %s',
    async (cliVersion) => {
      const { getExpectedRuntimeCliVersion } = await loadModule();
      expect(() => getExpectedRuntimeCliVersion({ version: '0.0.79', cliVersion })).toThrow(
        /cliVersion must be a version/
      );
    }
  );

  it.each([
    '12.1.251 (Claude Code)',
    '2.1.2510 (Claude Code)',
    '2.1.251-dev (Claude Code)',
    '2.1.251+other-build (Claude Code)',
    'unexpected version 2.1.251',
    '',
    undefined,
  ])('rejects mismatched or missing leading version tokens: %s', async (output) => {
    const { matchesRuntimeCliVersion } = await loadModule();
    expect(matchesRuntimeCliVersion(output, '2.1.251')).toBe(false);
  });

  it('accepts whitespace and a separately pinned prerelease version', async () => {
    const { getExpectedRuntimeCliVersion, matchesRuntimeCliVersion } = await loadModule();
    const expected = getExpectedRuntimeCliVersion({
      version: '0.0.79',
      cliVersion: ' 2.1.251-dev+abc123 ',
    });
    expect(matchesRuntimeCliVersion(' \r\n2.1.251-dev+abc123 (Claude Code)\r\n', expected)).toBe(
      true
    );
  });
});
