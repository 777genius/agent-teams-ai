import { createHash } from 'node:crypto';

import {
  parseAnchorChannelRef,
  parseAnchorIdentityRef,
  parseMainProcessIdentityRef,
  parseOwnedProcessRef,
  parseOwningProcessIdentityRef,
  parseProcessControllerInstanceId,
  parseSpawnNonce,
  PROCESS_OWNER_ATTESTATION_VERSION,
  PROCESS_SUPERVISION_PROTOCOL_VERSION,
  type ProcessOwnershipScope,
} from '@features/team-runtime-control/contracts/processSupervision';
import {
  type CompositeRuntimePlanHash,
  parseExecutionUnitId,
  parseRuntimeBinaryId,
  type Sha256Hash,
} from '@features/team-runtime-control/contracts/runtimePlan';
import {
  beginOwnedProcessStop,
  commitProcessOwnership,
  completeOwnedProcessStop,
  computeCanonicalArgvDigest,
  computeCanonicalPolicyDigest,
  createSpawnIntent,
  initializeProcessOwnershipState,
  spawnNonceDigest,
} from '@features/team-runtime-control/core/domain/process-supervision';
import { parseRunId, parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

const hash = (character: string): Sha256Hash => `sha256:${character.repeat(64)}`;

function scope(suffix = 'a'): ProcessOwnershipScope {
  return {
    planRef: {
      teamId: parseTeamId(`team_${suffix.repeat(32)}`),
      runId: parseRunId(`run_${suffix.repeat(32)}`),
      generation: 7,
      planHash: hash(suffix) as CompositeRuntimePlanHash,
    },
    executionUnitId: parseExecutionUnitId(`unit-${suffix}`),
  };
}

function intentValue(overrides: Record<string, unknown> = {}) {
  const argv = ['serve', '--mode', 'exact'];
  return {
    scope: scope(),
    processRef: parseOwnedProcessRef('process-ref-0000000000000001'),
    spawnNonce: parseSpawnNonce('spawn-nonce-0000000000000001'),
    workspaceBinding: {
      workspaceId: parseWorkspaceId(`workspace_${'b'.repeat(32)}`),
      registrationRevision: 2,
      bindingGeneration: 3,
      mountGeneration: 4,
    },
    binaryBinding: {
      policy: 'registered_exact_binary' as const,
      binaryId: parseRuntimeBinaryId('binary-exact'),
      binaryRevision: 5,
      binaryHash: hash('c'),
    },
    argv,
    callerArgvDigest: computeCanonicalArgvDigest(argv),
    environmentPolicyDigest: computeCanonicalPolicyDigest({
      policy: 'explicit_allowlist',
      variables: ['SAFE_NAME'],
    }),
    relayScopeDigest: computeCanonicalPolicyDigest({
      lane: 'primary',
      members: ['lead', 'worker'],
    }),
    ...overrides,
  };
}

function readyProof(intent = createSpawnIntent(intentValue())) {
  const ownerAttestation = Object.freeze({
    attestationVersion: PROCESS_OWNER_ATTESTATION_VERSION,
    processRef: intent.processRef,
    scope: intent.scope,
    workspaceBinding: intent.workspaceBinding,
    spawnNonceDigest: spawnNonceDigest(intent.spawnNonce),
    channelRef: parseAnchorChannelRef('channel-ref-000000000000001'),
    owningProcessIdentityRef: parseOwningProcessIdentityRef('owner-identity-0000000000001'),
    anchorIdentityRef: parseAnchorIdentityRef('anchor-identity-00000000001'),
  });
  return {
    processRef: intent.processRef,
    scope: intent.scope,
    workspaceBinding: intent.workspaceBinding,
    spawnNonceDigest: spawnNonceDigest(intent.spawnNonce),
    controllerInstanceId: parseProcessControllerInstanceId('controller-instance-00000001'),
    ownerAttestation,
    mainProcessIdentityRef: parseMainProcessIdentityRef('main-identity-0000000000001'),
    statusSequence: 1 as const,
  };
}

describe('process ownership domain', () => {
  it('canonically hashes actual argv including exact argument order and boundaries', () => {
    expect(computeCanonicalArgvDigest(['ab', 'c'])).not.toBe(
      computeCanonicalArgvDigest(['a', 'bc'])
    );
    expect(computeCanonicalArgvDigest(['first', 'second'])).not.toBe(
      computeCanonicalArgvDigest(['second', 'first'])
    );
    expect(computeCanonicalPolicyDigest({ members: ['first', 'second'] })).not.toBe(
      computeCanonicalPolicyDigest({ members: ['second', 'first'] })
    );
    expect(computeCanonicalArgvDigest(['é'])).toMatch(/^sha256:[a-f0-9]{64}$/);
    const expectedBytes = Buffer.concat([
      Buffer.from('agent-teams-argv-v1\u0000'),
      Buffer.from('5:first;'),
      Buffer.from('6:second;'),
    ]);
    expect(computeCanonicalArgvDigest(['first', 'second'])).toBe(
      `sha256:${createHash('sha256').update(expectedBytes).digest('hex')}`
    );
    expect(() => computeCanonicalArgvDigest(['bad\u0000argument'])).toThrow('argv-entry');
    expect(() => computeCanonicalArgvDigest(['\ud800'])).toThrow('argv-entry');
  });

  it('rejects a caller argv digest forgery while retaining no raw argv', () => {
    expect(() => createSpawnIntent(intentValue({ callerArgvDigest: hash('f') }))).toThrow(
      'argv-digest-mismatch'
    );

    const intent = createSpawnIntent(intentValue());
    expect(intent.argvCount).toBe(3);
    expect(intent.argvDigest).toBe(computeCanonicalArgvDigest(['serve', '--mode', 'exact']));
    expect(JSON.stringify(intent)).not.toContain('serve');
    expect(JSON.stringify(intent)).not.toContain('--mode');
    expect(Object.isFrozen(intent)).toBe(true);
  });

  it('commits only exact nonce, workspace, plan, unit, argv, and protocol order ownership', () => {
    const intent = createSpawnIntent(intentValue());
    const pending = initializeProcessOwnershipState(intent);
    const proof = readyProof(intent);
    const accepted = commitProcessOwnership(pending, proof);
    expect(accepted.status).toBe('accepted');
    if (accepted.status !== 'accepted') throw new Error('expected ownership transition');
    expect(accepted.next.phase).toBe('owned');

    expect(
      commitProcessOwnership(pending, {
        ...proof,
        spawnNonceDigest: hash('9'),
      })
    ).toEqual({ status: 'rejected', reason: 'ownership_mismatch' });
    expect(
      commitProcessOwnership(pending, {
        ...proof,
        workspaceBinding: { ...proof.workspaceBinding, mountGeneration: 99 },
      })
    ).toEqual({ status: 'rejected', reason: 'ownership_mismatch' });
    expect(
      commitProcessOwnership(pending, {
        ...proof,
        scope: scope('d'),
      })
    ).toEqual({ status: 'rejected', reason: 'ownership_mismatch' });
    expect(PROCESS_SUPERVISION_PROTOCOL_VERSION).toBe(1);
  });

  it('fences stop by exact plan, execution unit, and opaque process ref', () => {
    const intent = createSpawnIntent(intentValue());
    const committed = commitProcessOwnership(
      initializeProcessOwnershipState(intent),
      readyProof(intent)
    );
    if (committed.status !== 'accepted') throw new Error('expected ownership transition');

    const correctFence = { ...intent.scope, processRef: intent.processRef };
    const stopping = beginOwnedProcessStop(committed.next, correctFence);
    expect(stopping.status).toBe('accepted');
    if (stopping.status !== 'accepted') throw new Error('expected stopping state');
    expect(beginOwnedProcessStop(stopping.next, correctFence)).toEqual({
      status: 'rejected',
      reason: 'invalid_phase',
    });
    expect(
      beginOwnedProcessStop(committed.next, {
        ...correctFence,
        executionUnitId: parseExecutionUnitId('unit-reused'),
      })
    ).toEqual({ status: 'rejected', reason: 'ownership_mismatch' });
    expect(
      beginOwnedProcessStop(committed.next, {
        ...correctFence,
        processRef: parseOwnedProcessRef('process-ref-0000000000000099'),
      })
    ).toEqual({ status: 'rejected', reason: 'ownership_mismatch' });
  });

  it('requires a strictly ordered typed drain and refuses residuals in a drained result', () => {
    const intent = createSpawnIntent(intentValue());
    const committed = commitProcessOwnership(
      initializeProcessOwnershipState(intent),
      readyProof(intent)
    );
    if (committed.status !== 'accepted') throw new Error('expected ownership transition');
    const stopping = beginOwnedProcessStop(committed.next, {
      ...intent.scope,
      processRef: intent.processRef,
    });
    if (stopping.status !== 'accepted') throw new Error('expected stop transition');

    const ownership = 'ownership' in stopping.next ? stopping.next.ownership : undefined;
    if (!ownership) throw new Error('missing ownership');
    const baseProof = {
      processRef: ownership.processRef,
      scope: ownership.scope,
      spawnNonceDigest: ownership.spawnNonceDigest,
      ownerAttestation: ownership.ownerAttestation,
      ownedProcessEof: {
        processRef: ownership.processRef,
        ownerAttestation: ownership.ownerAttestation,
        observed: true as const,
      },
      statusSequence: 2,
      outcome: 'drained' as const,
      residuals: [] as readonly string[],
    };
    expect(completeOwnedProcessStop(stopping.next, baseProof).status).toBe('accepted');
    expect(
      completeOwnedProcessStop(stopping.next, { ...baseProof, ownedProcessEof: undefined as never })
    ).toEqual({ status: 'rejected', reason: 'ownership_mismatch' });
    expect(completeOwnedProcessStop(stopping.next, { ...baseProof, statusSequence: 1 })).toEqual({
      status: 'rejected',
      reason: 'protocol_order',
    });
    expect(
      completeOwnedProcessStop(stopping.next, { ...baseProof, residuals: ['ambiguous'] })
    ).toEqual({ status: 'rejected', reason: 'ownership_mismatch' });
  });
});
