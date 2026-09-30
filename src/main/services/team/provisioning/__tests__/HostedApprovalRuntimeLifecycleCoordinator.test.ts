import { describe, expect, it } from 'vitest';

import { HostedApprovalRuntimeLifecycleCoordinator } from '../HostedApprovalRuntimeLifecycleCoordinator';

import type {
  HostedApprovalRuntimeLifecycle,
  HostedApprovalRuntimePublication,
} from '../HostedApprovalRuntimeAdmissionPublisher';
import type {
  HostedApprovalRuntimeLifecycleCoordinatorDependencies,
  HostedApprovalRuntimeLifecyclePublisherPort,
} from '../HostedApprovalRuntimeLifecycleCoordinator';
import type { HostedApprovalRuntimeOwnerLeaseContract } from '../HostedApprovalRuntimeProductionLifecycleBoundary';

const APPROVAL_DIGEST = `sha256:${'a'.repeat(64)}` as const;
const DOCUMENT_DIGEST = `sha256:${'b'.repeat(64)}` as const;
const ATTEMPT_ONE = `approval-lifecycle-attempt_${'1'.repeat(32)}`;
const ATTEMPT_TWO = `approval-lifecycle-attempt_${'2'.repeat(32)}`;

interface HarnessOptions {
  readonly noEvidence?: boolean;
  readonly rotateOnConfirmation?: boolean;
  readonly assertFalseOn?: HostedApprovalRuntimeLifecycle['state'];
  readonly restart?: (teamName: string) => Promise<void>;
  readonly ensureAbsent?: (
    teamName: string,
    reason: string,
    events: string[]
  ) => Promise<HostedApprovalRuntimePublication>;
}

interface Harness {
  readonly coordinator: HostedApprovalRuntimeLifecycleCoordinator;
  readonly events: string[];
  readonly publishCount: number;
  readonly restartCount: number;
}

function harness(options: HarnessOptions = {}): Harness {
  const events: string[] = [];
  let publishCount = 0;
  let restartCount = 0;
  const ownerLease: HostedApprovalRuntimeOwnerLeaseContract | null = options.noEvidence
    ? null
    : {
        async acquireTransitionEvidence(teamName, lifecycle) {
          events.push(`acquire:${teamName}:${lifecycle.state}`);
          let consumed = false;
          return {
            lifecycle,
            lease: {
              token: `lease-${publishCount}`,
              binding: { marker: lifecycle.state } as never,
              async consume() {
                if (consumed) return null;
                consumed = true;
                events.push(`consume:${lifecycle.state}`);
                return {
                  binding: { marker: `${lifecycle.state}-fresh` } as never,
                  async assertCurrent() {
                    events.push(`assert:${lifecycle.state}`);
                    return options.assertFalseOn !== lifecycle.state;
                  },
                  async release() {
                    events.push(`release:${lifecycle.state}`);
                  },
                };
              },
            },
            resolveExpectedInstalledArtifactDigest: async () => APPROVAL_DIGEST,
          };
        },
      };

  const publisher: HostedApprovalRuntimeLifecyclePublisherPort = {
    async ensureAbsent(teamName, reason) {
      events.push(`absent:${teamName}:${reason}`);
      if (options.ensureAbsent) return options.ensureAbsent(teamName, reason, events);
      return { state: 'absent', reason };
    },
    async publish(teamName, lifecycle, leaseOwner) {
      publishCount += 1;
      events.push(`publish:${teamName}:${lifecycle.state}`);
      const evidence = await leaseOwner?.acquireTransitionEvidence(teamName, lifecycle);
      if (!evidence || JSON.stringify(evidence.lifecycle) !== JSON.stringify(lifecycle)) {
        return { state: 'unavailable', reason: 'owner-evidence-unavailable' };
      }
      const pin = await evidence.lease.consume();
      if (!pin) {
        return { state: 'revoked', reason: 'owner-pin-unavailable' };
      }
      try {
        if (!(await pin.assertCurrent())) {
          return { state: 'revoked', reason: 'owner-pin-unavailable' };
        }
        if (lifecycle.state === 'active') {
          return active(lifecycle.ownerGeneration);
        }
        if (options.rotateOnConfirmation && lifecycle.state === 'restart_required') {
          return restartRequired(2);
        }
        return restartRequired(1);
      } finally {
        await pin.release();
      }
    },
  };

  const dependencies: HostedApprovalRuntimeLifecycleCoordinatorDependencies = {
    projection: {
      async readProvisioningLifecycle(teamName) {
        events.push(`projection:${teamName}:provisioning`);
        return { state: 'provisioning', ownerGeneration: 7 };
      },
      async readSuccessorOwnerGeneration(teamName, predecessor) {
        events.push(`projection:${teamName}:successor:${predecessor}`);
        return 8;
      },
    },
    ownerLease,
    publisher,
    restart: {
      async restartSuccessor(teamName, transition) {
        restartCount += 1;
        events.push(`restart:${teamName}:${transition.predecessorOwnerGeneration}`);
        events.push(`restart-approval:${transition.approvalGeneration}`);
        await options.restart?.(teamName);
      },
    },
  };
  return {
    coordinator: new HostedApprovalRuntimeLifecycleCoordinator(dependencies),
    events,
    get publishCount() {
      return publishCount;
    },
    get restartCount() {
      return restartCount;
    },
  };
}

describe('HostedApprovalRuntimeLifecycleCoordinator', () => {
  it('orders provisioning, restart evidence, and a pinned successor activation', async () => {
    const state = harness();

    await expect(state.coordinator.transitionToActive('team-a', ATTEMPT_ONE)).resolves.toEqual(
      active(8)
    );

    expect(state.events).toEqual([
      'absent:team-a:hosted-approval-runtime-lifecycle-transition-start',
      'projection:team-a:provisioning',
      'publish:team-a:provisioning',
      'acquire:team-a:provisioning',
      'consume:provisioning',
      'assert:provisioning',
      'release:provisioning',
      'publish:team-a:restart_required',
      'acquire:team-a:restart_required',
      'consume:restart_required',
      'assert:restart_required',
      'release:restart_required',
      'restart:team-a:7',
      'restart-approval:1',
      'projection:team-a:successor:7',
      'publish:team-a:active',
      'acquire:team-a:active',
      'consume:active',
      'assert:active',
      'release:active',
    ]);
  });

  it('does not restart or activate without evidence from the injected owner', async () => {
    const state = harness({ noEvidence: true });

    await expect(state.coordinator.transitionToActive('team-a', ATTEMPT_ONE)).resolves.toEqual({
      state: 'unavailable',
      reason: 'hosted-approval-runtime-owner-lease-unavailable',
    });

    expect(state.restartCount).toBe(0);
    expect(state.publishCount).toBe(0);
    expect(state.events.at(-1)).toBe(
      'absent:team-a:hosted-approval-runtime-owner-lease-unavailable'
    );
  });

  it('fails closed when binding evidence rotates before restart', async () => {
    const state = harness({ rotateOnConfirmation: true });

    await expect(state.coordinator.transitionToActive('team-a', ATTEMPT_ONE)).resolves.toEqual({
      state: 'unavailable',
      reason: 'hosted-approval-runtime-restart-evidence-rotated',
    });

    expect(state.restartCount).toBe(0);
    expect(state.events).not.toContain('publish:team-a:active');
    expect(state.events.at(-1)).toBe(
      'absent:team-a:hosted-approval-runtime-restart-evidence-rotated'
    );
  });

  it('releases a remotely consumed pin and proves absence when its assertion is false', async () => {
    const state = harness({ assertFalseOn: 'restart_required' });

    await expect(state.coordinator.transitionToActive('team-a', ATTEMPT_ONE)).resolves.toEqual({
      state: 'unavailable',
      reason: 'hosted-approval-runtime-restart-evidence-rotated',
    });

    expect(state.restartCount).toBe(0);
    expect(state.events).toContain('release:restart_required');
    expect(state.events.at(-1)).toBe(
      'absent:team-a:hosted-approval-runtime-restart-evidence-rotated'
    );
  });

  it('retains an idempotent result and shares one local and remote transition', async () => {
    const state = harness();
    const first = state.coordinator.transitionToActive('team-a', ATTEMPT_ONE);
    const replay = state.coordinator.transitionToActive('team-a', ATTEMPT_ONE);

    expect(replay).toBe(first);
    await expect(Promise.all([first, replay])).resolves.toEqual([active(8), active(8)]);
    expect(state.restartCount).toBe(1);
    expect(state.publishCount).toBe(3);
  });

  it('fences an in-flight transition on owner loss before any successor publication', async () => {
    const restartEntered = deferred<void>();
    const allowRestart = deferred<void>();
    const state = harness({
      restart: async () => {
        restartEntered.resolve(undefined);
        await allowRestart.promise;
      },
    });
    const transition = state.coordinator.transitionToActive('team-a', ATTEMPT_ONE);
    await restartEntered.promise;
    const ownerEffect = state.coordinator.beforeOwnerLoss('team-a', async () => {
      state.events.push('effect:owner-loss');
    });

    allowRestart.resolve(undefined);
    await expect(transition).resolves.toEqual({
      state: 'unavailable',
      reason: 'hosted-approval-runtime-owner-lost',
    });
    await ownerEffect;

    expect(state.events).not.toContain('publish:team-a:active');
    expect(state.events.indexOf('absent:team-a:hosted-approval-runtime-owner-lost')).toBeLessThan(
      state.events.indexOf('effect:owner-loss')
    );
  });

  it('keeps owner-loss admission closed until an explicit fresh owner is admitted', async () => {
    const state = harness();

    await state.coordinator.beforeOwnerLoss('team-a', async () => undefined);
    await expect(state.coordinator.transitionToActive('team-a', ATTEMPT_ONE)).resolves.toEqual({
      state: 'unavailable',
      reason: 'hosted-approval-runtime-owner-lost',
    });
    expect(state.publishCount).toBe(0);
    expect(state.events.at(-1)).toBe('absent:team-a:hosted-approval-runtime-owner-lost');

    state.coordinator.admitFreshOwner('team-a');
    await expect(state.coordinator.transitionToActive('team-a', ATTEMPT_ONE)).resolves.toEqual(
      active(8)
    );
  });

  it('revokes after a restart crash and requires a new logical attempt', async () => {
    const state = harness({
      restart: async () => {
        throw new Error('successor-crashed');
      },
    });

    const first = await state.coordinator.transitionToActive('team-a', ATTEMPT_ONE);
    const replay = await state.coordinator.transitionToActive('team-a', ATTEMPT_ONE);

    expect(first).toEqual({ state: 'unavailable', reason: 'successor-crashed' });
    expect(replay).toBe(first);
    expect(state.restartCount).toBe(1);
    expect(state.events.at(-1)).toBe('absent:team-a:successor-crashed');
  });

  it('serializes attempts and performs product-restart recovery in team order', async () => {
    const state = harness();
    const first = state.coordinator.transitionToActive('team-a', ATTEMPT_ONE);
    const second = state.coordinator.transitionToActive('team-a', ATTEMPT_TWO);
    await Promise.all([first, second]);
    await state.coordinator.recoverAfterProductRestart(['team-z', 'team-a', 'team-z']);
    await state.coordinator.transitionToActive('team-a', ATTEMPT_ONE);

    expect(state.restartCount).toBe(3);
    const recovery = state.events.filter((event) => event.includes('product-restarted'));
    expect(recovery).toEqual([
      'absent:team-a:hosted-approval-runtime-product-restarted',
      'absent:team-z:hosted-approval-runtime-product-restarted',
    ]);
  });

  it('totally orders distinct attempts behind the local team pin', async () => {
    const restartEntered = deferred<void>();
    const allowRestart = deferred<void>();
    let restart = 0;
    const state = harness({
      restart: async () => {
        restart += 1;
        if (restart === 1) {
          restartEntered.resolve(undefined);
          await allowRestart.promise;
        }
      },
    });

    const first = state.coordinator.transitionToActive('team-a', ATTEMPT_ONE);
    await restartEntered.promise;
    const second = state.coordinator.transitionToActive('team-a', ATTEMPT_TWO);
    await Promise.resolve();

    expect(state.events.filter((event) => event === 'projection:team-a:provisioning')).toHaveLength(
      1
    );
    allowRestart.resolve(undefined);
    await Promise.all([first, second]);

    const activePublications = state.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event === 'publish:team-a:active');
    const transitionStarts = state.events
      .map((event, index) => ({ event, index }))
      .filter(
        ({ event }) => event === 'absent:team-a:hosted-approval-runtime-lifecycle-transition-start'
      );
    expect(activePublications).toHaveLength(2);
    expect(transitionStarts).toHaveLength(2);
    expect(activePublications[0].index).toBeLessThan(transitionStarts[1].index);
  });

  it('synchronously restart-fences every team before awaiting ordered revocation', async () => {
    const restartEntered = new Map([
      ['team-a', deferred<void>()],
      ['team-z', deferred<void>()],
    ]);
    const allowRestart = new Map([
      ['team-a', deferred<void>()],
      ['team-z', deferred<void>()],
    ]);
    const state = harness({
      restart: async (teamName) => {
        restartEntered.get(teamName)?.resolve(undefined);
        await allowRestart.get(teamName)?.promise;
      },
    });
    const teamA = state.coordinator.transitionToActive('team-a', ATTEMPT_ONE);
    const teamZ = state.coordinator.transitionToActive('team-z', ATTEMPT_ONE);
    await Promise.all([
      restartEntered.get('team-a')?.promise,
      restartEntered.get('team-z')?.promise,
    ]);

    const recovery = state.coordinator.recoverAfterProductRestart(['team-z', 'team-a']);
    allowRestart.get('team-z')?.resolve(undefined);
    await expect(teamZ).resolves.toEqual({
      state: 'unavailable',
      reason: 'hosted-approval-runtime-owner-lost',
    });
    expect(state.events).not.toContain('publish:team-z:active');

    allowRestart.get('team-a')?.resolve(undefined);
    await expect(teamA).resolves.toEqual({
      state: 'unavailable',
      reason: 'hosted-approval-runtime-owner-lost',
    });
    await recovery;
  });

  it('fences all in-flight teams and proves absence before the shutdown effect', async () => {
    const restartEntered = deferred<void>();
    const allowRestart = deferred<void>();
    const state = harness({
      restart: async () => {
        restartEntered.resolve(undefined);
        await allowRestart.promise;
      },
    });
    const transition = state.coordinator.transitionToActive('team-a', ATTEMPT_ONE);
    await restartEntered.promise;
    const shutdown = state.coordinator.beforeShutdown(['team-z', 'team-a'], async () => {
      state.events.push('effect:shutdown');
      return 'stopped' as const;
    });

    allowRestart.resolve(undefined);
    await expect(transition).resolves.toEqual({
      state: 'unavailable',
      reason: 'hosted-approval-runtime-owner-lost',
    });
    await expect(shutdown).resolves.toBe('stopped');

    expect(state.events).not.toContain('publish:team-a:active');
    expect(state.events.indexOf('absent:team-a:hosted-approval-runtime-shutdown')).toBeLessThan(
      state.events.indexOf('absent:team-z:hosted-approval-runtime-shutdown')
    );
    expect(state.events.indexOf('absent:team-z:hosted-approval-runtime-shutdown')).toBeLessThan(
      state.events.indexOf('effect:shutdown')
    );
  });

  it('closes shutdown admission before blocked revocation rejects a late transition', async () => {
    const shutdownRevocationEntered = deferred<void>();
    const allowShutdownRevocation = deferred<void>();
    const state = harness({
      ensureAbsent: async (_teamName, reason) => {
        if (reason === 'hosted-approval-runtime-shutdown') {
          shutdownRevocationEntered.resolve(undefined);
          await allowShutdownRevocation.promise;
        }
        return { state: 'absent', reason };
      },
    });

    const shutdown = state.coordinator.beforeShutdown(['team-a'], async () => {
      state.events.push('effect:shutdown');
      return 'stopped' as const;
    });
    await shutdownRevocationEntered.promise;

    const lateTransition = state.coordinator.transitionToActive('team-a', ATTEMPT_ONE);
    await Promise.resolve();
    expect(state.events).not.toContain('projection:team-a:provisioning');
    expect(state.publishCount).toBe(0);

    allowShutdownRevocation.resolve(undefined);
    await expect(shutdown).resolves.toBe('stopped');
    await expect(lateTransition).resolves.toEqual({
      state: 'unavailable',
      reason: 'hosted-approval-runtime-shutdown',
    });
    await expect(state.coordinator.transitionToActive('team-a', ATTEMPT_TWO)).resolves.toEqual({
      state: 'unavailable',
      reason: 'hosted-approval-runtime-shutdown',
    });
    expect(state.publishCount).toBe(0);

    state.coordinator.admitFreshOwner('team-a');
    await expect(state.coordinator.transitionToActive('team-a', ATTEMPT_TWO)).resolves.toEqual(
      active(8)
    );
  });

  it('rejects unbound attempt identifiers without consulting any authority port', async () => {
    const state = harness();

    await expect(
      state.coordinator.transitionToActive('team-a', 'locally-invented')
    ).resolves.toEqual({
      state: 'unavailable',
      reason: 'hosted-approval-runtime-lifecycle-attempt-invalid',
    });
    expect(state.events).toEqual([]);
  });
});

function restartRequired(approvalGeneration: number): HostedApprovalRuntimePublication {
  return {
    state: 'restart_required',
    approvalGeneration,
    approvalDigest: APPROVAL_DIGEST,
    admissionDocumentDigest: DOCUMENT_DIGEST,
  };
}

function active(ownerGeneration: number): HostedApprovalRuntimePublication {
  return {
    state: 'active',
    ownerGeneration,
    approvalGeneration: 1,
    approvalDigest: APPROVAL_DIGEST,
    admissionDocumentDigest: DOCUMENT_DIGEST,
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
