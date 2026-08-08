import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('standalone hosted team-configuration wiring', () => {
  it('mounts the durable authority through feature-specific production route admission', async () => {
    const source = await readFile('src/main/standalone.ts', 'utf8');

    expect(source).not.toContain('...HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS');
    expect(source).toContain('authorizationPolicy: classifyHostedTeamConfigurationAuthorization');
    expect(source).toContain('createHostedTeamConfigurationComposition({');
    expect(source).toContain('storage: hostedAuthStorageBackend.teamConfigurations');
    expect(source).toContain('authentication: hostedAccessFeature.http');
    expect(source).toContain('runtimeInstance: hostedDiagnosticsRuntimeInstance');
    expect(source).toContain('expectedDeploymentId: hostedAccessFeature.deploymentId');
    expect(source).toContain('createHostedTeamConfigurationRouteAdmissionBinding(');
    expect(source).toContain("dimension === 'mutation' && lifecycleOwnerAvailable");
    expect(source).not.toContain('lifecycleOwnerAvailable || teamConfigurationAvailable');
    expect(source).toContain('hostedTeamConfigurationRoutes: hostedTeamConfiguration');
  });

  it('keeps platform and local-control mechanisms outside the standalone entrypoint', async () => {
    const source = await readFile('src/main/standalone.ts', 'utf8');
    const platform = await readFile(
      'src/main/composition/hosted/hostedAccessNodePlatform.ts',
      'utf8'
    );

    expect(source).not.toContain("from 'node:crypto'");
    expect(source).not.toContain("from 'node:net'");
    expect(source).not.toContain('function createHostedAuthHostPlatform');
    expect(source).not.toContain('function createHostedAuthLocalControlTransportFactory');
    expect(platform).toContain('createHostedAccessNodePlatform');
    expect(platform).toContain('createHostedAccessNodeLocalControlTransportFactory');
  });
});
