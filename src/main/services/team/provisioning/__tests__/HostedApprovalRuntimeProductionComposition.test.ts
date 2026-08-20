import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHostedApprovalRuntimeAuthoritativeEvidenceAdapter } from '../HostedApprovalRuntimeAuthoritativeEvidenceAdapter';
import { createHostedApprovalRuntimeLifecycleOwner } from '../HostedApprovalRuntimeLifecycleOwner';
import {
  createProductOwnedTeamProvisioningService,
  createTeamProvisioningServiceWithHostedApprovalRuntimeAdmission,
} from '../HostedApprovalRuntimeProductionComposition';
import { HostedApprovalRuntimeProductionLifecycleBoundary } from '../HostedApprovalRuntimeProductionLifecycleBoundary';

import type { HostedApprovalRuntimeAdmissionCoordinator } from '../HostedApprovalRuntimeAdmissionComposition';
import type { AuthoritativeHostedApprovalRuntimeBindingLease } from '../HostedApprovalRuntimeAdmissionPublisher';
import type { HostedApprovalRuntimeTransitionEvidence } from '../HostedApprovalRuntimeAuthoritativeEvidenceAdapter';

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

  it('makes all two-generation states reachable only through the evidence-bearing owner port', async () => {
    const transitions: unknown[] = [];
    const adapter = createHostedApprovalRuntimeAuthoritativeEvidenceAdapter();
    const { hostedApprovalRuntime } =
      createTeamProvisioningServiceWithHostedApprovalRuntimeAdmission(
        coordinator([], transitions),
        adapter
      );
    const owner = createHostedApprovalRuntimeLifecycleOwner(hostedApprovalRuntime);
    const lease = {
      token: 'owner-transition-lease',
      binding: { marker: 'authoritative' },
      consume: async () => null,
    } as unknown as AuthoritativeHostedApprovalRuntimeBindingLease;
    const evidence = (
      lifecycle: Parameters<typeof hostedApprovalRuntime.transition>[1]
    ): HostedApprovalRuntimeTransitionEvidence => ({
      lifecycle,
      lease,
      resolveExpectedInstalledArtifactDigest: async () => `sha256:${'a'.repeat(64)}` as const,
    });

    await owner.transition('team-a', evidence({ state: 'provisioning', ownerGeneration: 8 }));
    await owner.transition(
      'team-a',
      evidence({ state: 'restart_required', ownerGeneration: 8, approvalGeneration: 17 })
    );
    await owner.transition(
      'team-a',
      evidence({
        state: 'active',
        ownerGeneration: 9,
        approvalGeneration: 17,
        approvalDigest: `sha256:${'a'.repeat(64)}`,
      })
    );

    expect(transitions).toHaveLength(3);
    expect(transitions).toEqual([
      ['team-a', { state: 'provisioning', ownerGeneration: 8 }],
      ['team-a', { state: 'restart_required', ownerGeneration: 8, approvalGeneration: 17 }],
      [
        'team-a',
        {
          state: 'active',
          ownerGeneration: 9,
          approvalGeneration: 17,
          approvalDigest: `sha256:${'a'.repeat(64)}`,
        },
      ],
    ]);
  });

  it('publishes all authoritative owner lifecycle states through leased production evidence', async () => {
    const transitions: unknown[] = [];
    const adapter = createHostedApprovalRuntimeAuthoritativeEvidenceAdapter();
    const { hostedApprovalRuntime } =
      createTeamProvisioningServiceWithHostedApprovalRuntimeAdmission(
        coordinator([], transitions),
        adapter
      );
    const boundary = new HostedApprovalRuntimeProductionLifecycleBoundary(
      createHostedApprovalRuntimeLifecycleOwner(hostedApprovalRuntime),
      hostedApprovalRuntime
    );
    const lease = {
      token: 'production-owner-transition-lease',
      binding: { marker: 'authoritative' },
      consume: async () => null,
    } as unknown as AuthoritativeHostedApprovalRuntimeBindingLease;
    const ownerLease = {
      acquireTransitionEvidence: async (
        _teamName: string,
        lifecycle: Parameters<typeof hostedApprovalRuntime.transition>[1]
      ) => ({
        lifecycle,
        lease,
        resolveExpectedInstalledArtifactDigest: async () => `sha256:${'a'.repeat(64)}` as const,
      }),
    };

    await boundary.publish('team-a', { state: 'provisioning', ownerGeneration: 10 }, ownerLease);
    await boundary.publish(
      'team-a',
      { state: 'restart_required', ownerGeneration: 10, approvalGeneration: 17 },
      ownerLease
    );
    await boundary.publish(
      'team-a',
      {
        state: 'active',
        ownerGeneration: 11,
        approvalGeneration: 17,
        approvalDigest: `sha256:${'a'.repeat(64)}`,
      },
      ownerLease
    );

    expect(transitions).toEqual([
      ['team-a', { state: 'provisioning', ownerGeneration: 10 }],
      ['team-a', { state: 'restart_required', ownerGeneration: 10, approvalGeneration: 17 }],
      [
        'team-a',
        {
          state: 'active',
          ownerGeneration: 11,
          approvalGeneration: 17,
          approvalDigest: `sha256:${'a'.repeat(64)}`,
        },
      ],
    ]);
  });

  it('fails closed and revokes when the production owner lease is unavailable', async () => {
    const revocations: string[] = [];
    const admission = coordinator([]);
    admission.ensureAbsent = async (_teamName, reason) => {
      revocations.push(reason);
      return { state: 'revoked', reason };
    };
    const { hostedApprovalRuntime } =
      createTeamProvisioningServiceWithHostedApprovalRuntimeAdmission(admission);
    const boundary = new HostedApprovalRuntimeProductionLifecycleBoundary(
      createHostedApprovalRuntimeLifecycleOwner(hostedApprovalRuntime),
      hostedApprovalRuntime
    );

    await expect(
      boundary.publish('team-a', { state: 'provisioning', ownerGeneration: 1 }, null)
    ).resolves.toEqual({
      state: 'unavailable',
      reason: 'hosted-approval-runtime-owner-lease-unavailable',
    });
    expect(revocations).toEqual(['hosted-approval-runtime-owner-lease-unavailable']);
  });

  it('rejects a missing owner lease when a coordinator-less runtime cannot prove absence', async () => {
    const { hostedApprovalRuntime } =
      createTeamProvisioningServiceWithHostedApprovalRuntimeAdmission(null);
    const boundary = new HostedApprovalRuntimeProductionLifecycleBoundary(
      createHostedApprovalRuntimeLifecycleOwner(hostedApprovalRuntime),
      hostedApprovalRuntime
    );

    await expect(
      boundary.publish('team-a', { state: 'provisioning', ownerGeneration: 1 }, null)
    ).rejects.toThrow('hosted-approval-runtime-admission-absence-unconfirmed');
  });

  it.each([
    [
      'an unavailable result',
      async () => ({
        state: 'unavailable' as const,
        reason: 'hosted-approval-runtime-coordinator-unavailable',
      }),
      'hosted-approval-runtime-admission-absence-unconfirmed',
    ],
    [
      'a malformed result',
      async () => ({ state: 'absent' as const, reason: 'test', unexpected: true }),
      'hosted-approval-runtime-admission-absence-unconfirmed',
    ],
    [
      'a thrown failure',
      async () => {
        throw new Error('revocation did not settle');
      },
      'revocation did not settle',
    ],
  ])(
    'rejects a missing owner lease when ensureAbsent returns %s',
    async (_label, ensureAbsent, error) => {
      const admission = coordinator([]);
      admission.ensureAbsent =
        ensureAbsent as HostedApprovalRuntimeAdmissionCoordinator['ensureAbsent'];
      const { hostedApprovalRuntime } =
        createTeamProvisioningServiceWithHostedApprovalRuntimeAdmission(admission);
      const boundary = new HostedApprovalRuntimeProductionLifecycleBoundary(
        createHostedApprovalRuntimeLifecycleOwner(hostedApprovalRuntime),
        hostedApprovalRuntime
      );

      await expect(
        boundary.publish('team-a', { state: 'provisioning', ownerGeneration: 1 }, null)
      ).rejects.toThrow(error);
    }
  );

  it.each([
    [
      'a circular lifecycle',
      () => {
        const lifecycle: Record<string, unknown> = {
          state: 'provisioning',
          ownerGeneration: 1,
        };
        lifecycle.circular = lifecycle;
        return ownerEvidence(lifecycle);
      },
    ],
    [
      'a throwing lifecycle getter',
      () => {
        const lifecycle = Object.defineProperties(
          {},
          {
            state: {
              enumerable: true,
              get() {
                throw new Error('state getter must not escape');
              },
            },
            ownerGeneration: { enumerable: true, value: 1 },
          }
        );
        return ownerEvidence(lifecycle);
      },
    ],
    [
      'a throwing toJSON hook',
      () =>
        ownerEvidence({
          state: 'provisioning',
          ownerGeneration: 1,
          toJSON() {
            throw new Error('toJSON must not run');
          },
        }),
    ],
    ['a malformed scalar', () => ownerEvidence({ state: 'provisioning', ownerGeneration: 1.5 })],
    [
      'a lifecycle whose structural inspection throws',
      () =>
        ownerEvidence(
          new Proxy(
            { state: 'provisioning', ownerGeneration: 1 },
            {
              ownKeys() {
                throw new Error('deep comparison must not escape');
              },
            }
          )
        ),
    ],
  ])('awaits fail-closed revocation for owner evidence with %s', async (_label, evidence) => {
    const cleanupEntered = deferred<void>();
    const allowCleanup = deferred<void>();
    const revocations: string[] = [];
    let transitionCount = 0;
    const admission = coordinator([]);
    admission.ensureAbsent = async (_teamName, reason) => {
      revocations.push(reason);
      cleanupEntered.resolve(undefined);
      await allowCleanup.promise;
      return { state: 'revoked', reason };
    };
    const { hostedApprovalRuntime } =
      createTeamProvisioningServiceWithHostedApprovalRuntimeAdmission(admission);
    const boundary = new HostedApprovalRuntimeProductionLifecycleBoundary(
      {
        async transition() {
          transitionCount += 1;
          return { state: 'unavailable', reason: 'must-not-transition' };
        },
      },
      hostedApprovalRuntime
    );
    const ownerLease = {
      acquireTransitionEvidence: async () => evidence(),
    } as never;

    let settled = false;
    const publication = boundary.publish(
      'team-a',
      { state: 'provisioning', ownerGeneration: 1 },
      ownerLease
    );
    void publication.then(() => {
      settled = true;
    });
    await cleanupEntered.promise;
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(transitionCount).toBe(0);
    allowCleanup.resolve(undefined);
    await expect(publication).resolves.toEqual({
      state: 'unavailable',
      reason: 'hosted-approval-runtime-owner-lease-unavailable',
    });
    expect(revocations).toEqual(['hosted-approval-runtime-owner-lease-unavailable']);
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

function ownerEvidence(lifecycle: unknown): unknown {
  return {
    lifecycle,
    lease: {},
    resolveExpectedInstalledArtifactDigest: async () => `sha256:${'a'.repeat(64)}`,
  };
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
