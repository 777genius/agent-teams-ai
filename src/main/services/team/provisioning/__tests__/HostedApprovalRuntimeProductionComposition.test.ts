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
      consume: async () => ({ marker: 'authoritative-reread' }),
    } as unknown as AuthoritativeHostedApprovalRuntimeBindingLease;
    const admission = coordinator([]);
    admission.transition = async (teamName) => {
      const acquired = await adapter.acquireRosterSessionBootstrapProcessLease(teamName);
      expect(acquired?.binding).toEqual({ marker: 'authoritative' });
      await expect(acquired?.consume()).resolves.toEqual({ marker: 'authoritative-reread' });
      await expect(acquired?.consume()).resolves.toBeNull();
      await expect(adapter.expectedInstalledArtifactDigest(teamName)).resolves.toBe(
        `sha256:${'a'.repeat(64)}`
      );
      return { state: 'revoked', reason: 'observed' };
    };
    const service = createTeamProvisioningServiceWithHostedApprovalRuntimeAdmission(
      admission,
      adapter
    );

    await expect(
      service.transitionHostedApprovalRuntimeAdmission(
      'team-a',
        { state: 'provisioning', ownerGeneration: 1 },
        {
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
    const service = createTeamProvisioningServiceWithHostedApprovalRuntimeAdmission(admission);

    const provisioning = await service.transitionHostedApprovalRuntimeAdmission('team-a', {
      state: 'provisioning',
      ownerGeneration: 4,
    });
    if (provisioning.state !== 'restart_required') throw new Error('unexpected state');
    await service.transitionHostedApprovalRuntimeAdmission('team-a', {
      state: 'restart_required',
      ownerGeneration: 4,
      approvalGeneration: provisioning.approvalGeneration,
    });
    await service.transitionHostedApprovalRuntimeAdmission('team-a', {
      state: 'active',
      ownerGeneration: 5,
      approvalGeneration: provisioning.approvalGeneration,
      approvalDigest: provisioning.approvalDigest,
    });

    expect(transitions).toEqual([
      ['team-a', { state: 'provisioning', ownerGeneration: 4 }],
      [
        'team-a',
        { state: 'restart_required', ownerGeneration: 4, approvalGeneration: 17 },
      ],
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
    const service = createTeamProvisioningServiceWithHostedApprovalRuntimeAdmission(
      coordinator(events)
    );

    await service.stopTeam('not-running');

    expect(events).toEqual(['revoke:stop', 'effect:stop']);
  });

  it('awaits explicit failure and owner-loss barriers', async () => {
    const events: string[] = [];
    const service = createTeamProvisioningServiceWithHostedApprovalRuntimeAdmission(
      coordinator(events)
    );

    await service.notifyHostedApprovalRuntimeFailure('team-a');
    await service.notifyHostedApprovalRuntimeOwnerLoss('team-a');

    expect(events).toEqual([
      'revoke:failure',
      'effect:failure',
      'revoke:owner-loss',
      'effect:owner-loss',
    ]);
  });

  it('keeps the normal desktop caller capability-false', async () => {
    const service = createProductOwnedTeamProvisioningService('/not-opened', '/not-opened');
    await expect(
      service.transitionHostedApprovalRuntimeAdmission('team-a', {
        state: 'provisioning',
        ownerGeneration: 1,
      })
    ).resolves.toEqual({
      state: 'revoked',
      reason: 'hosted-approval-runtime-capability-disabled',
    });
  });
});
