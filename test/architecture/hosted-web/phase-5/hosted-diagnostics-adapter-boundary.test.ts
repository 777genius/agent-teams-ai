import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const ENTRYPOINT = resolve(ROOT, 'src/features/hosted-operations/main/hosted.ts');
const FACTORY = resolve(
  ROOT,
  'src/features/hosted-operations/main/composition/createHostedDiagnosticsAdapters.ts'
);
const STORE = resolve(
  ROOT,
  'src/features/hosted-operations/main/adapters/output/BoundedHostedDiagnosticsReferenceStore.ts'
);
const PLATFORM = resolve(
  ROOT,
  'src/features/hosted-operations/main/infrastructure/NodeHostedDiagnosticsPlatform.ts'
);

describe('hosted diagnostics adapter boundary', () => {
  it('publishes only the factory and focused ports from the main entrypoint', () => {
    const entrypoint = readFileSync(ENTRYPOINT, 'utf8');

    expect(entrypoint).toContain('createHostedDiagnosticsAdapters');
    expect(entrypoint).toContain('HostedDiagnosticsRecorderPort');
    expect(entrypoint).not.toContain('BoundedHostedDiagnosticsReferenceStore');
    expect(entrypoint).not.toContain('NodeHostedDiagnosticsPlatform');
  });

  it('keeps process-local storage bounded, redacted, and free of forbidden host coupling', () => {
    const factory = readFileSync(FACTORY, 'utf8');
    const store = readFileSync(STORE, 'utf8');
    const platform = readFileSync(PLATFORM, 'utf8');
    const production = `${factory}\n${store}\n${platform}`;

    for (const forbidden of [
      'electron',
      'sqlite',
      'schema.sql',
      'standalone',
      '@main/services',
      'providerOutput',
      'rawPath',
      'projectPath',
      ' as unknown as ',
      ' as any',
    ]) {
      expect(production.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(store).toContain('applyRetentionBudget');
    expect(store).toContain('redactOperationAttributes');
    expect(store).toContain('createQueryContext');
    expect(store).toContain('byteLengthOf');
    expect(store).not.toMatch(/authority:.*(?:bootId|requestId)/s);
  });
});
