import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('standalone hosted workspace-registry wiring', () => {
  it('mounts the admitted registry behind its exact hosted authorization policy', async () => {
    const source = await readFile('src/main/standalone.ts', 'utf8');

    expect(source).toContain('classifyHostedWorkspaceRegistryAuthorization(');
    expect(source).toContain('classifyHostedTeamConfigurationAuthorization');
    expect(source).toContain('workspaceRegistrySnapshot = bootstrap.workspaceRegistrySnapshot');
    expect(source).toContain('createHostedWorkspaceRegistryComposition({');
    expect(source).toContain('snapshot: workspaceRegistrySnapshot');
    expect(source).toContain('runtimeInstance: hostedDiagnosticsRuntimeInstance');
    expect(source).toContain('expectedDeploymentId: hostedAccessFeature.deploymentId');
    expect(source).toContain('hostedWorkspaceRegistryRoutes,');
  });

  it('restores the admitted hosted Claude root after ConfigManager loads', async () => {
    const source = await readFile('src/main/standalone.ts', 'utf8');
    const configImportIndex = source.indexOf(
      "await import('./services/infrastructure/ConfigManager')"
    );
    const restorationIndex = source.indexOf(
      'if (admittedHostedClaudeRoot !== null) {\n    setClaudeBasePathOverride(admittedHostedClaudeRoot);',
      configImportIndex
    );
    const scannerPathDerivationIndex = source.indexOf('const projectsDir = getProjectsBasePath();');

    expect(configImportIndex).toBeGreaterThanOrEqual(0);
    expect(restorationIndex).toBeGreaterThan(configImportIndex);
    expect(scannerPathDerivationIndex).toBeGreaterThan(restorationIndex);
  });
});
