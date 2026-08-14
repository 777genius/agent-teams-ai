import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHostedApprovalRuntimeAuthoritativeEvidenceAdapter } from '../HostedApprovalRuntimeAuthoritativeEvidenceAdapter';
import {
  createProductOwnedTeamProvisioningService,
  createTeamProvisioningServiceWithHostedApprovalRuntimeAdmission,
} from '../HostedApprovalRuntimeProductionComposition';

import type { HostedApprovalRuntimeAdmissionCoordinator } from '../HostedApprovalRuntimeAdmissionComposition';
import type { AuthoritativeHostedApprovalRuntimeBindingLease } from '../HostedApprovalRuntimeAdmissionPublisher';

function coordinator(
  events: string[],
  transitions: unknown[] = []
): HostedApprovalRuntimeAdmissionCoordinator {
  const before = async <T>(label: string, effect: () => Promise<T>): Promise<T> => {
    events.push(`revoke:${label}`);
    events.push(`effect:${label}`);
    return effect();
  };
  return {
    ensureAbsent: async (teamName, reason) => ({
      state: 'absent',
      reason: `${teamName}:${reason}`,
    }),
    reconcileCurrent: async () => ({ state: 'absent', reason: 'no-current-evidence' }),
    transition: async (teamName, lifecycle) => {
      transitions.push([teamName, lifecycle]);
      return {
        state: 'restart_required',
        approvalGeneration: 17,
        approvalDigest: `sha256:${'a'.repeat(64)}`,
        admissionDocumentDigest: `sha256:${'b'.repeat(64)}`,
      };
    },
    beforeCancel: (_teamName, effect) => before('cancel', effect),
    beforeBindingChange: (_teamName, effect) => before('binding-change', effect),
    beforeFailure: (_teamName, effect) => before('failure', effect),
    beforeStop: (_teamName, effect) => before('stop', effect),
    beforeOwnerLoss: (_teamName, effect) => before('owner-loss', effect),
    beforeShutdown: (_teamNames, effect) => before('shutdown', effect),
  };
}

describe('hosted approval runtime production Team Provisioning caller', () => {
  it('binds the trusted lifecycle call to request-scoped authoritative evidence', async () => {
    const adapter = createHostedApprovalRuntimeAuthoritativeEvidenceAdapter();
    const lease = {
      token: 'lease-test',
      binding: { marker: 'authoritative' },
      consume: async () => ({
        binding: { marker: 'authoritative-reread' },
        assertCurrent: async () => true,
        release: async () => undefined,
      }),
    } as unknown as AuthoritativeHostedApprovalRuntimeBindingLease;
    const admission = coordinator([]);
    admission.transition = async (teamName) => {
      const acquired = await adapter.acquireRosterSessionBootstrapProcessLease(teamName);
      expect(acquired?.binding).toEqual({ marker: 'authoritative' });
      await expect(acquired?.consume()).resolves.toMatchObject({
        binding: { marker: 'authoritative-reread' },
      });
      await expect(acquired?.consume()).resolves.toBeNull();
      await expect(adapter.expectedInstalledArtifactDigest(teamName)).resolves.toBe(
        `sha256:${'a'.repeat(64)}`
      );
      return { state: 'revoked', reason: 'observed' };
    };
    const { hostedApprovalRuntime } =
      createTeamProvisioningServiceWithHostedApprovalRuntimeAdmission(admission, adapter);

    await expect(
      hostedApprovalRuntime.transition(
        'team-a',
        { state: 'provisioning', ownerGeneration: 1 },
        {
          lifecycle: { state: 'provisioning', ownerGeneration: 1 },
          lease,
          resolveExpectedInstalledArtifactDigest: async () => `sha256:${'a'.repeat(64)}`,
        }
      )
    ).resolves.toEqual({ state: 'revoked', reason: 'observed' });

    await expect(adapter.expectedInstalledArtifactDigest('team-a')).resolves.toBeNull();
  });

  it('routes two-generation transitions through the product-owned coordinator', async () => {
    const events: string[] = [];
    const transitions: unknown[] = [];
    const admission = coordinator(events, transitions);
    const { hostedApprovalRuntime } =
      createTeamProvisioningServiceWithHostedApprovalRuntimeAdmission(admission);

    const provisioning = await hostedApprovalRuntime.transition('team-a', {
      state: 'provisioning',
      ownerGeneration: 4,
    });
    if (provisioning.state !== 'restart_required') throw new Error('unexpected state');
    await hostedApprovalRuntime.transition('team-a', {
      state: 'restart_required',
      ownerGeneration: 4,
      approvalGeneration: provisioning.approvalGeneration,
    });
    await hostedApprovalRuntime.transition('team-a', {
      state: 'active',
      ownerGeneration: 5,
      approvalGeneration: provisioning.approvalGeneration,
      approvalDigest: provisioning.approvalDigest,
    });

    expect(transitions).toEqual([
      ['team-a', { state: 'provisioning', ownerGeneration: 4 }],
      ['team-a', { state: 'restart_required', ownerGeneration: 4, approvalGeneration: 17 }],
      [
        'team-a',
        {
          state: 'active',
          ownerGeneration: 5,
          approvalGeneration: 17,
          approvalDigest: `sha256:${'a'.repeat(64)}`,
        },
      ],
    ]);
  });

  it('awaits revocation before the real stop caller enters its destructive effect', async () => {
    const events: string[] = [];
    const { hostedApprovalRuntime, service } =
      createTeamProvisioningServiceWithHostedApprovalRuntimeAdmission(coordinator(events));

    await hostedApprovalRuntime.beforeStop('not-running', () => service.stopTeam('not-running'));

    expect(events).toEqual(['revoke:stop', 'effect:stop']);
  });

  it('awaits explicit failure and owner-loss barriers', async () => {
    const events: string[] = [];
    const { hostedApprovalRuntime } =
      createTeamProvisioningServiceWithHostedApprovalRuntimeAdmission(coordinator(events));

    await hostedApprovalRuntime.beforeFailure('team-a', async () => undefined);
    await hostedApprovalRuntime.beforeOwnerLoss('team-a', async () => undefined);

    expect(events).toEqual([
      'revoke:failure',
      'effect:failure',
      'revoke:owner-loss',
      'effect:owner-loss',
    ]);
  });

  it('keeps the normal desktop caller capability-false', async () => {
    const root = join('/tmp', `approval-production-${randomUUID()}`);
    const teams = join(root, 'teams');
    const team = join(teams, 'team-a');
    const state = join(root, 'state');
    await mkdir(team, { recursive: true, mode: 0o700 });
    await mkdir(state, { mode: 0o700 });
    await Promise.all([chmod(teams, 0o700), chmod(team, 0o700), chmod(state, 0o700)]);
    const admissionPath = join(team, 'hosted-approval-runtime-admission.v1.json');
    await writeFile(admissionPath, '{}\n', { mode: 0o600 });
    const { hostedApprovalRuntime } = createProductOwnedTeamProvisioningService(teams, state);
    await expect(hostedApprovalRuntime.ensureAbsent('team-a', 'startup')).resolves.toEqual({
      state: 'revoked',
      reason: 'startup',
    });
    await expect(readFile(admissionPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      hostedApprovalRuntime.transition('team-a', {
        state: 'provisioning',
        ownerGeneration: 1,
      })
    ).resolves.toEqual({
      state: 'absent',
      reason: 'hosted-approval-runtime-capability-disabled',
    });
    await rm(root, { recursive: true, force: true });
  });

  it('does not report revocation when no coordinator can prove descriptor absence', async () => {
    const { hostedApprovalRuntime } =
      createTeamProvisioningServiceWithHostedApprovalRuntimeAdmission(null);
    await expect(hostedApprovalRuntime.ensureAbsent('team-a')).resolves.toEqual({
      state: 'unavailable',
      reason: 'hosted-approval-runtime-coordinator-unavailable',
    });
  });
});
