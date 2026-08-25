import { describe, expect, it } from 'vitest';

import { HostedApprovalRuntimeTransitionService } from '../HostedApprovalRuntimeTransitionService';

import type { HostedApprovalRuntimeAdmissionCoordinator } from '../HostedApprovalRuntimeAdmissionComposition';
import type { HostedApprovalRuntimeLifecycle } from '../HostedApprovalRuntimeAdmissionPublisher';
import type {
  HostedApprovalRuntimeTransitionAuthority,
  HostedApprovalRuntimeTransitionEvidence,
} from '../HostedApprovalRuntimeAuthoritativeEvidenceAdapter';

const MISMATCH_REASON = 'hosted-approval-runtime-lifecycle-evidence-mismatch';
const requestedLifecycle: HostedApprovalRuntimeLifecycle = Object.freeze({
  state: 'provisioning',
  ownerGeneration: 7,
});

describe('HostedApprovalRuntimeTransitionService', () => {
  it.each([
    {
      label: 'transition authority is missing',
      transitionAuthority: null,
      ownerEvidence: evidence(requestedLifecycle),
    },
    {
      label: 'the evidence Proxy lifecycle getter throws',
      transitionAuthority: transitionAuthority(),
      ownerEvidence: new Proxy(evidence(requestedLifecycle), {
        get() {
          throw new Error('owner evidence getter must not escape before revocation');
        },
      }),
    },
    {
      label: 'the lifecycle Proxy comparison throws',
      transitionAuthority: transitionAuthority(),
      ownerEvidence: evidence(
        new Proxy(requestedLifecycle, {
          get() {
            throw new Error('lifecycle comparison getter must not escape before revocation');
          },
        })
      ),
    },
  ])('awaits active-admission revocation when $label', async (testCase) => {
    const revocationEntered = deferred<void>();
    const allowRevocation = deferred<void>();
    const reasons: string[] = [];
    let admissionPresent = true;
    const coordinator = admissionCoordinator(async (_teamName, reason) => {
      reasons.push(reason);
      revocationEntered.resolve(undefined);
      await allowRevocation.promise;
      admissionPresent = false;
      return { state: 'revoked', reason };
    });
    const service = new HostedApprovalRuntimeTransitionService({
      coordinator,
      transitionAuthority: testCase.transitionAuthority,
    });

    let settled = false;
    const publication = service.transition('team-a', requestedLifecycle, testCase.ownerEvidence);
    void publication.finally(() => {
      settled = true;
    });
    await revocationEntered.promise;
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(admissionPresent).toBe(true);

    allowRevocation.resolve(undefined);
    await expect(publication).resolves.toEqual({
      state: 'unavailable',
      reason: MISMATCH_REASON,
    });
    expect(admissionPresent).toBe(false);
    expect(reasons).toEqual([MISMATCH_REASON]);
  });

  it('does not resolve unavailable when admission absence cannot be confirmed', async () => {
    const coordinator = admissionCoordinator(async (_teamName, reason) => ({
      state: 'unavailable',
      reason,
    }));
    const service = new HostedApprovalRuntimeTransitionService({
      coordinator,
      transitionAuthority: null,
    });

    await expect(
      service.transition('team-a', requestedLifecycle, evidence(requestedLifecycle))
    ).rejects.toThrow('hosted-approval-runtime-admission-absence-unconfirmed');
  });
});

function admissionCoordinator(
  ensureAbsent: HostedApprovalRuntimeAdmissionCoordinator['ensureAbsent']
): HostedApprovalRuntimeAdmissionCoordinator {
  const passThrough = async <T>(_teamName: string, operation: () => Promise<T>): Promise<T> =>
    operation();
  return {
    ensureAbsent,
    reconcileCurrent: async () => ({ state: 'absent', reason: 'unused' }),
    transition: async () => {
      throw new Error('transition must not run for rejected owner evidence');
    },
    beforeCancel: passThrough,
    beforeBindingChange: passThrough,
    beforeFailure: passThrough,
    beforeStop: passThrough,
    beforeOwnerLoss: passThrough,
    beforeShutdown: async (_teamNames, operation) => operation(),
  };
}

function transitionAuthority(): HostedApprovalRuntimeTransitionAuthority {
  return {
    async withEvidence(_teamName, _evidence, operation) {
      return operation();
    },
  };
}

function evidence(
  lifecycle: HostedApprovalRuntimeLifecycle
): HostedApprovalRuntimeTransitionEvidence {
  return {
    lifecycle,
    lease: {} as HostedApprovalRuntimeTransitionEvidence['lease'],
    resolveExpectedInstalledArtifactDigest: async () => null,
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
