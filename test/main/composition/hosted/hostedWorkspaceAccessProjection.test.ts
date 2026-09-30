import {
  WorkspaceMountBinding,
  WorkspaceRegistration,
  WorkspaceRegistrationRegistry,
} from '@features/workspace-registry/core';
import { parseBootId, parseDeploymentId, parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

import {
  createHostedWorkspaceAccessProjection,
  HOSTED_WORKSPACE_ACCESS_CAPABILITIES,
  type HostedWorkspaceAccessProjectionDependencies,
} from '../../../../src/main/composition/hosted/hostedWorkspaceAccessProjection';

import type { WorkspaceRegistryStartupSnapshot } from '@features/workspace-registry/main';

const A = parseWorkspaceId(`workspace_${'a'.repeat(32)}`);
const B = parseWorkspaceId(`workspace_${'b'.repeat(32)}`);
const TEAM = parseTeamId(`team_${'c'.repeat(32)}`);
const BOOT = parseBootId('boot_access_test');
const REVISION = 'd'.repeat(64);
const IDENTITY = 'e'.repeat(64);

function fixture(
  multiRootActive = true,
  retireOwnerOnCommandFence: 0 | 1 | 2 = 0
) {
  const registrations = [A, B].map((id) => new WorkspaceRegistration({
    schemaVersion: 1,
    registrationKey: `registration-${id.slice(-1)}`,
    workspaceId: id,
    displayName: id,
    registrationRevision: 1,
    declaredRootHash: id === A ? 'a'.repeat(64) : 'b'.repeat(64),
    enabled: true,
  }));
  const bindings = registrations.map((registration) => new WorkspaceMountBinding({
    registration,
    bootId: BOOT,
    mountGeneration: 1,
    declaredRootHash: registration.declaredRootHash,
    observedAt: 1,
    health: 'healthy',
    // Deliberately includes Git privileges in B. They cannot imply Hosted effects.
    allowedOperations: ['workspace.registry.get-project-branch'],
  }));
  const snapshot: WorkspaceRegistryStartupSnapshot = Object.freeze({
    registry: new WorkspaceRegistrationRegistry(registrations),
    bindings: Object.freeze(bindings),
  });
  let granted = true;
  let attributionRevision = 1;
  let ownerReady = true;
  let commandFenceIndex = 0;
  const auth: HostedWorkspaceAccessProjectionDependencies['authentication'] = {
    async captureWorkspaceReadGrantFence(_request, publicWorkspaceId) {
      if (!granted) return null;
      return {
        runtimeWorkspaceId: publicWorkspaceId,
        grantRevision: REVISION,
        revalidate: async () => granted,
      };
    },
    async captureTeamWorkspaceGrantFence(request, _teamId, permission) {
      if (!granted) return null;
      const capturedAttributionRevision = attributionRevision;
      const index = permission === 'hosted.command' ? ++commandFenceIndex : 0;
      let revalidations = 0;
      const publicWorkspaceId = (request as { workspaceId: string }).workspaceId;
      return {
        publicWorkspaceId,
        runtimeWorkspaceId: publicWorkspaceId,
        ownerEffectFence: { grantRevision: REVISION, identityChecksum: IDENTITY },
        revalidate: async () => {
          revalidations += 1;
          if (index !== 0 && index === retireOwnerOnCommandFence && revalidations === 2)
            ownerReady = false;
          return granted && capturedAttributionRevision === attributionRevision;
        },
      };
    },
    async isTeamConfigurationScopeAuthorized() { return 'authorized'; },
  };
  const projection = createHostedWorkspaceAccessProjection({
    authentication: auth,
    runtimeInstance: { deploymentId: parseDeploymentId('deployment_access_test'), bootId: BOOT },
    multiRootActive,
    admittedSnapshot: snapshot,
    currentSnapshot: () => snapshot,
    ownerBinding: bindings[0]!,
    ownerReady: () => ownerReady,
    available: Object.fromEntries(HOSTED_WORKSPACE_ACCESS_CAPABILITIES.map((capability) => [
      capability,
      () => retireOwnerOnCommandFence === 0 ||
        capability === 'directory.read' || capability === 'team.open' || capability === 'message.send',
    ])),
  });
  return {
    projection,
    revoke: () => { granted = false; },
    changeAttribution: () => { attributionRevision += 1; },
  };
}

describe('hosted workspace access projection', () => {
  it('rejects forged B writes despite every advertised authority and Git permission', async () => {
    const { projection } = fixture();
    const request = { workspaceId: B };
    const target = { publicWorkspaceId: B, publicTeamId: TEAM };
    const access = await projection.project(request, target);

    expect(access?.capabilities).toEqual([
      'directory.read', 'team.open', 'configuration.read', 'task.read', 'message.read',
    ]);
    expect(await projection.captureEffect(request, target, 'message.send')).toBeNull();
    expect(await projection.captureEffect(request, target, 'configuration.write')).toBeNull();
    expect(Object.keys(access ?? {})).toEqual([
      'deploymentId', 'bootId', 'registrationRevision', 'mountGeneration', 'grantRevision',
      'teamIdentityRevision', 'capabilities',
    ]);
  });

  it('invalidates an A effect after grant revocation before the effect runs', async () => {
    const { projection, revoke } = fixture();
    const request = { workspaceId: A };
    const target = { publicWorkspaceId: A, publicTeamId: TEAM };
    const captured = await projection.captureEffect(request, target, 'message.send');

    expect(captured).not.toBeNull();
    revoke();
    expect(await captured!.revalidate()).toBe(false);
    expect(await projection.project(request, target)).toBeNull();
  });

  it('retains the original team fence when attribution changes but the DTO stays identical', async () => {
    const { projection, changeAttribution } = fixture();
    const request = { workspaceId: A };
    const target = { publicWorkspaceId: A, publicTeamId: TEAM };
    const captured = await projection.captureEffect(request, target, 'message.send');
    expect(captured).not.toBeNull();

    changeAttribution();
    expect(await projection.project(request, target)).toEqual(captured!.snapshot);
    expect(await captured!.revalidate()).toBe(false);
  });

  it('keeps B unavailable until multi-root activation even with a valid grant', async () => {
    const { projection } = fixture(false);
    expect(await projection.project({ workspaceId: B }, { publicWorkspaceId: B })).toBeNull();
  });

  it('rejects an effect when the last grant recheck retires Owner', async () => {
    const request = { workspaceId: A };
    const target = { publicWorkspaceId: A, publicTeamId: TEAM };
    expect(await fixture(true, 1).projection.captureEffect(request, target, 'message.send')).toBeNull();

    const { projection } = fixture(true, 2);
    const captured = await projection.captureEffect(request, target, 'message.send');
    expect(captured).not.toBeNull();
    expect(await captured!.revalidate()).toBe(false);
  });
});
