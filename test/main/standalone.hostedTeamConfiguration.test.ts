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
    const composition = (
      await readFile('src/main/composition/hosted/hostedTeamConfigurationComposition.ts', 'utf8')
    ).replace(/\s+/g, ' ');
    expect(source).toMatch(
      /publication: teamIdentityGrantFenceSource === null \? null : hostedDraftPublication,/
    );
    expect(source).toMatch(
      /routeAdmissionBinding: createHostedTeamConfigurationRouteAdmissionBinding\(\s*\(\) => hostedTeamConfiguration\?\.isReady\(\) === true\s*\)/
    );
    expect(composition).toContain('isReady: () => dependencies.publication !== null');
    expect(composition).toContain('const ready = isReady();');
    expect(composition).toContain("status: ready ? ('ready' as const) : ('not_ready' as const)");
    expect(composition).toContain("reasons: Object.freeze(ready ? [] : ['team_configuration_unavailable'])");
    expect(composition).toContain(
      'createHostedTeamConfigurationAuthority(dependencies.storage, publication ? { journal: publication.journal, publisher: publication.publisher, captureWorkspace, } : undefined)'
    );
    expect(composition).toContain(
      'if (!request || !principal || !publication || dependencies.restoreGeneration === undefined)'
    );
    expect(composition).toContain(
      'publication.captureWorkspace(workspaceId, principal, context, dependencies.restoreGeneration)'
    );
    expect(composition).toContain('await authorizeWorkspace(); await fence.assertCurrent();');
    expect(composition).toContain(
      'dependencies.authentication.isTeamConfigurationScopeAuthorized(request, authorizationScope(scope), MUTATIONS.has(operation))'
    );
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
