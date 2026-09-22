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
const HTTP_COMPOSITION = resolve(
  ROOT,
  'src/main/composition/hosted/hostedDiagnosticsComposition.ts'
);
const HTTP_ORCHESTRATOR = resolve(ROOT, 'src/main/http/index.ts');
const QUERY_CONTEXT_MAIN_ENTRYPOINT = resolve(
  ROOT,
  'src/features/hosted-query-context/main/index.ts'
);
const QUERY_CONTEXT_HOSTED_ENTRYPOINT = resolve(
  ROOT,
  'src/features/hosted-query-context/main/hosted.ts'
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

  it('mounts the bounded feature through authenticated query context without lifecycle ownership', () => {
    const composition = readFileSync(HTTP_COMPOSITION, 'utf8');
    const orchestrator = readFileSync(HTTP_ORCHESTRATOR, 'utf8');
    const queryContextMainEntrypoint = readFileSync(QUERY_CONTEXT_MAIN_ENTRYPOINT, 'utf8');
    const queryContextHostedEntrypoint = readFileSync(QUERY_CONTEXT_HOSTED_ENTRYPOINT, 'utf8');

    expect(composition).toContain('createAuthenticatedHostedQueryContextFactory');
    expect(composition).toContain('createHostedDiagnosticsAdapters');
    expect(composition).toContain('createHostedDiagnosticsFeature');
    expect(composition).toContain('registerHostedDiagnosticsHttp');
    expect(composition).toContain('authenticatedPrincipalFor');
    expect(composition).toContain('expectedDeploymentId');
    expect(composition).toContain('adapters.close()');
    expect(composition).toContain("from '@features/hosted-query-context/main/hosted';");
    expect(composition).toContain("from '@features/hosted-operations/main/hosted';");
    expect(composition).not.toContain('@features/hosted-query-context/main/composition/');
    expect(queryContextHostedEntrypoint).toContain('createAuthenticatedHostedQueryContextFactory');
    expect(queryContextMainEntrypoint).not.toContain(
      'createAuthenticatedHostedQueryContextFactory'
    );
    expect(queryContextMainEntrypoint).not.toContain('/composition/');
    expect(queryContextMainEntrypoint).not.toContain('/infrastructure/');
    expect(orchestrator.indexOf('services.hostedAuth?.register(app)')).toBeLessThan(
      orchestrator.indexOf('hostedDiagnosticsRoutes?.register(app)')
    );
    expect(orchestrator).toContain('hosted_diagnostics_composition_invalid');

    for (const forbidden of [
      'HostedApplication',
      'HostedLifecycle',
      'HostedTeamWorkspace',
      'node:child_process',
      'node:fs',
      'process.env',
      'electron',
    ]) {
      expect(composition).not.toContain(forbidden);
    }
  });
});
