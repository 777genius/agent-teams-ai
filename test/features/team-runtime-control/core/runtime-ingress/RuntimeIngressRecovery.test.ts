import {
  type CommandFingerprintRecord,
  HMAC_SHA256_LD_V1,
} from '@features/application-command-ledger';
import { parseLaneId, type Sha256Hash } from '@features/team-runtime-control/contracts';
import {
  ExecuteRuntimeIngress,
  type ExecuteRuntimeIngressRequest,
  RevokeRuntimeIngressCredential,
  type RuntimeIngressClockPort,
} from '@features/team-runtime-control/core/application/runtime-ingress';
import {
  initializeRuntimeIngressSessionState,
  isRuntimeIngressSessionStateRecoverable,
  issueRuntimeIngressCredential,
  parseRuntimeIngressCommandId,
  parseRuntimeIngressCredentialId,
  parseRuntimeIngressPresentedSecret,
  parseRuntimeIngressRuntimeInstanceId,
  parseRuntimeIngressSessionId,
  RUNTIME_INGRESS_VERBS,
  type RuntimeIngressAuthority,
  type RuntimeIngressBodyIdentityAssertions,
  type RuntimeIngressCredential,
  type RuntimeIngressCredentialScope,
  type RuntimeIngressSessionState,
  type RuntimeIngressVerb,
} from '@features/team-runtime-control/core/domain/runtime-ingress';
import {
  parseDeploymentId,
  parseMemberId,
  parseRunId,
  parseTeamId,
} from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

import { FakeRuntimeIngressDurableRecovery } from './fixtures/FakeRuntimeIngressDurableRecovery';

const ISSUED_AT = '2026-07-23T10:00:00.000Z';
const BOOTSTRAP_OBSERVED_AT = '2026-07-23T10:00:30.000Z';
const ACCEPTED_AT = '2026-07-23T10:01:00.000Z';
const HEARTBEAT_OBSERVED_AT = '2026-07-23T10:01:30.000Z';
const RESTARTED_AT = '2026-07-23T10:02:00.000Z';
const REVOKED_AT = '2026-07-23T10:03:00.000Z';

class FixedClock implements RuntimeIngressClockPort {
  constructor(private readonly instant: string) {}

  nowIso(): string {
    return this.instant;
  }
}

interface Harness {
  readonly recovery: FakeRuntimeIngressDurableRecovery;
  readonly credential: RuntimeIngressCredential;
  readonly session: RuntimeIngressSessionState;
  readonly authority: RuntimeIngressAuthority;
  readonly request: ExecuteRuntimeIngressRequest;
}

function digest(character: string): Sha256Hash {
  return `sha256:${character.repeat(64)}`;
}

function createHarness(
  allowedVerbs: readonly RuntimeIngressVerb[] = RUNTIME_INGRESS_VERBS,
  identity = '1'
): Harness {
  const scope: RuntimeIngressCredentialScope = {
    deploymentId: parseDeploymentId('deployment_runtime-ingress-test'),
    teamId: parseTeamId(`team_${'a'.repeat(32)}`),
    runId: parseRunId(`run_${'b'.repeat(32)}`),
    planGeneration: 7,
    laneId: parseLaneId('lane:opencode:1'),
    providerId: 'opencode',
    credentialGeneration: 3,
    allowedVerbs,
  };
  const credential = issueRuntimeIngressCredential({
    credentialId: parseRuntimeIngressCredentialId(`credential:lane:${identity}`),
    secretDigest: digest('1'),
    secretDigestKeyVersion: 2,
    scope,
    sessionId: parseRuntimeIngressSessionId(`runtime-session:${identity}`),
    issuedAtIso: ISSUED_AT,
  });
  const deliveryOwnerId = parseMemberId(`member_${'c'.repeat(32)}`);
  const session = initializeRuntimeIngressSessionState(credential, deliveryOwnerId);
  const recovery = new FakeRuntimeIngressDurableRecovery();
  const secret = parseRuntimeIngressPresentedSecret(`presented-secret:lane:${identity}`);
  recovery.seed(credential, secret, session);
  const authority: RuntimeIngressAuthority = {
    deploymentId: scope.deploymentId,
    teamId: scope.teamId,
    runId: scope.runId,
    planGeneration: scope.planGeneration,
    laneId: scope.laneId,
    providerId: scope.providerId,
    credentialGeneration: scope.credentialGeneration,
    verb: 'runtime.bootstrap-checkin',
  };
  return {
    recovery,
    credential,
    session,
    authority,
    request: {
      authority,
      presentedCredential: {
        credentialId: credential.credentialId,
        secret,
      },
      sessionId: session.sessionId,
      runtimeInstanceId: parseRuntimeIngressRuntimeInstanceId(`runtime-instance:${identity}`),
      deliveryOwnerId,
      commandId: parseRuntimeIngressCommandId('command:bootstrap:1'),
      sequence: 1,
      observedAtIso: BOOTSTRAP_OBSERVED_AT,
      effect: {
        payloadJson: '{"runtimeSessionId":"provider-value"}',
      },
    },
  };
}

function executor(
  recovery: FakeRuntimeIngressDurableRecovery,
  instant = ACCEPTED_AT
): ExecuteRuntimeIngress {
  return new ExecuteRuntimeIngress(recovery, new FixedClock(instant));
}

function nextRequest(
  harness: Harness,
  verb: RuntimeIngressVerb,
  commandId: string,
  sequence: number,
  observedAtIso: string,
  payloadJson = '{}'
): ExecuteRuntimeIngressRequest {
  return {
    ...harness.request,
    authority: { ...harness.authority, verb },
    commandId: parseRuntimeIngressCommandId(commandId),
    sequence,
    observedAtIso,
    effect: { payloadJson },
  };
}

async function acceptBootstrap(harness: Harness): Promise<void> {
  await expect(executor(harness.recovery).execute(harness.request)).resolves.toMatchObject({
    status: 'accepted',
  });
}

describe('canonical runtime ingress durable recovery', () => {
  it('commits the ledger effect, lane effect, session, and acknowledgement atomically', async () => {
    const harness = createHarness();
    harness.recovery.failAfterAtomicCommitOnce();

    await expect(executor(harness.recovery).execute(harness.request)).resolves.toEqual({
      status: 'rejected',
      reason: 'storage_unavailable',
    });
    expect(harness.recovery.effectApplicationCount).toBe(1);
    expect(harness.recovery.onlyCommand).toMatchObject({
      state: 'committed',
      claim: {
        scope: {
          deploymentId: harness.authority.deploymentId,
          commandKind: 'runtime.bootstrap-checkin',
          idempotencyKey: harness.request.commandId,
        },
        fingerprint: {
          descriptorId: 'team-runtime-control.runtime.bootstrap-checkin',
          fingerprintVersion: HMAC_SHA256_LD_V1,
        },
      },
      effects: [
        {
          effectId: 'commit-runtime-ingress-acceptance',
          recoveryClass: 'transactional_local',
          state: 'observed_succeeded',
        },
      ],
    });
    const committedSession = harness.recovery.session(harness.session.sessionId);
    expect(committedSession).toMatchObject({
      revision: 2,
      phase: 'active',
      runtimeInstanceId: harness.request.runtimeInstanceId,
      deliveryOwnerId: harness.request.deliveryOwnerId,
      bootstrapAcceptedAtIso: ACCEPTED_AT,
      lastObservedAtIso: BOOTSTRAP_OBSERVED_AT,
      lastAcceptedSequence: 1,
    });

    const restarted = harness.recovery.restart();
    const replayed = await executor(restarted, '2030-01-01T00:00:00.000Z').execute(harness.request);
    expect(replayed).toEqual({
      status: 'replayed',
      acknowledgement: committedSession?.acceptedVerbs[0]?.lastAcknowledgement,
    });
    expect(restarted.effectApplicationCount).toBe(1);
  });

  it('does not expose a command, acknowledgement, session change, or effect before commit', async () => {
    const harness = createHarness();
    harness.recovery.failBeforeAtomicCommitOnce();

    await expect(executor(harness.recovery).execute(harness.request)).resolves.toEqual({
      status: 'rejected',
      reason: 'storage_unavailable',
    });
    expect(harness.recovery.effectApplicationCount).toBe(0);
    expect(harness.recovery.onlyCommand).toBeNull();
    expect(harness.recovery.session(harness.session.sessionId)).toEqual(harness.session);

    const restarted = harness.recovery.restart();
    await expect(executor(restarted, RESTARTED_AT).execute(harness.request)).resolves.toMatchObject(
      {
        status: 'accepted',
      }
    );
    expect(restarted.effectApplicationCount).toBe(1);
  });

  it('reconciles deterministic concurrent identical requests to one accepted acknowledgement', async () => {
    const harness = createHarness();
    harness.recovery.synchronizeNextAtomicApplications();

    const [first, second] = await Promise.all([
      executor(harness.recovery).execute(harness.request),
      executor(harness.recovery).execute(harness.request),
    ]);

    expect(first).toMatchObject({ status: 'accepted' });
    expect(second).toEqual({
      status: 'replayed',
      acknowledgement:
        first.status === 'accepted' || first.status === 'replayed'
          ? first.acknowledgement
          : undefined,
    });
    expect(harness.recovery.effectApplicationCount).toBe(1);
  });

  it('fails closed on deterministic concurrent requests with one command id and conflicting intent', async () => {
    const harness = createHarness();
    harness.recovery.synchronizeNextAtomicApplications();

    const [accepted, conflicted] = await Promise.all([
      executor(harness.recovery).execute(harness.request),
      executor(harness.recovery).execute({
        ...harness.request,
        effect: { payloadJson: '{"runtimeSessionId":"altered"}' },
      }),
    ]);

    expect(accepted).toMatchObject({ status: 'accepted' });
    expect(conflicted).toEqual({ status: 'rejected', reason: 'replay_conflict' });
    expect(harness.recovery.effectApplicationCount).toBe(1);
  });

  it('generates replay references that cannot collide across runtime-ingress sessions', async () => {
    const first = createHarness(RUNTIME_INGRESS_VERBS, '1');
    const second = createHarness(RUNTIME_INGRESS_VERBS, '2');

    const [firstOutcome, secondOutcome] = await Promise.all([
      executor(first.recovery).execute(first.request),
      executor(second.recovery).execute(second.request),
    ]);
    if (firstOutcome.status === 'rejected' || secondOutcome.status === 'rejected') {
      throw new Error('runtime-ingress-reference-fixture-rejected');
    }

    expect(firstOutcome.acknowledgement.acknowledgementId).not.toBe(
      secondOutcome.acknowledgement.acknowledgementId
    );
    expect(firstOutcome.acknowledgement.effectRef).not.toBe(
      secondOutcome.acknowledgement.effectRef
    );
  });

  it('uses the application-command-ledger HMAC fingerprint for normalized intent conflicts', async () => {
    const harness = createHarness();
    await acceptBootstrap(harness);
    const fingerprint = harness.recovery.onlyCommand?.claim.fingerprint;
    expect(fingerprint).toEqual(
      expect.objectContaining<Partial<CommandFingerprintRecord>>({
        descriptorVersion: 1,
        schemaVersion: 1,
        fingerprintVersion: HMAC_SHA256_LD_V1,
        effectPlanVersion: 1,
        keyVersion: 'runtime-ingress-test-key-v1',
      })
    );
    expect(fingerprint?.digest).toMatch(/^[0-9a-f]{64}$/);

    await expect(
      executor(harness.recovery).execute({
        ...harness.request,
        effect: { payloadJson: '{"changed":true}' },
      })
    ).resolves.toEqual({ status: 'rejected', reason: 'replay_conflict' });
    await expect(
      executor(harness.recovery).execute({
        ...harness.request,
        observedAtIso: '2026-07-23T10:00:31.000Z',
      })
    ).resolves.toEqual({ status: 'rejected', reason: 'replay_conflict' });
    expect(harness.recovery.effectApplicationCount).toBe(1);
  });

  it('revalidates active credential and persisted session before every committed replay', async () => {
    const revoked = createHarness();
    await acceptBootstrap(revoked);
    await expect(
      new RevokeRuntimeIngressCredential(revoked.recovery).execute({
        credentialId: revoked.credential.credentialId,
        expectedScope: revoked.credential.scope,
        revokedAtIso: REVOKED_AT,
        reason: 'lane-stopped',
      })
    ).resolves.toEqual({ status: 'revoked' });
    await expect(executor(revoked.recovery).execute(revoked.request)).resolves.toEqual({
      status: 'rejected',
      reason: 'credential_invalid',
    });
    expect(revoked.recovery.effectApplicationCount).toBe(1);

    const missing = createHarness();
    await acceptBootstrap(missing);
    missing.recovery.deleteSession(missing.session.sessionId);
    await expect(executor(missing.recovery).execute(missing.request)).resolves.toEqual({
      status: 'rejected',
      reason: 'session_unavailable',
    });

    const corrupt = createHarness();
    await acceptBootstrap(corrupt);
    corrupt.recovery.corruptSession(corrupt.session.sessionId);
    await expect(executor(corrupt.recovery).execute(corrupt.request)).resolves.toEqual({
      status: 'rejected',
      reason: 'session_invalid',
    });

    const raced = createHarness();
    await acceptBootstrap(raced);
    raced.recovery.revokeBeforeNextCommandLoad();
    await expect(executor(raced.recovery).execute(raced.request)).resolves.toEqual({
      status: 'rejected',
      reason: 'credential_invalid',
    });
    expect(raced.recovery.effectApplicationCount).toBe(1);

    const rebound = createHarness();
    await acceptBootstrap(rebound);
    rebound.recovery.corruptSessionRuntimeInstanceBinding(rebound.session.sessionId);
    await expect(executor(rebound.recovery).execute(rebound.request)).resolves.toEqual({
      status: 'rejected',
      reason: 'session_invalid',
    });
  });

  it('rejects duplicate retained sequences while accepting valid monotonic recovery state', async () => {
    const harness = createHarness();
    await acceptBootstrap(harness);
    await expect(
      executor(harness.recovery, RESTARTED_AT).execute(
        nextRequest(harness, 'runtime.heartbeat', 'command:heartbeat:2', 2, HEARTBEAT_OBSERVED_AT)
      )
    ).resolves.toMatchObject({ status: 'accepted' });
    await expect(
      executor(harness.recovery, REVOKED_AT).execute(
        nextRequest(
          harness,
          'runtime.deliver-message',
          'command:delivery:3',
          3,
          '2026-07-23T10:02:30.000Z'
        )
      )
    ).resolves.toMatchObject({ status: 'accepted' });

    const monotonic = harness.recovery.session(harness.session.sessionId);
    if (!monotonic) throw new Error('runtime-ingress-monotonic-session-missing');
    expect(isRuntimeIngressSessionStateRecoverable(monotonic)).toBe(true);

    const duplicateSequence: RuntimeIngressSessionState = {
      ...monotonic,
      acceptedVerbs: monotonic.acceptedVerbs.map((state) =>
        state.verb === 'runtime.heartbeat'
          ? {
              ...state,
              lastSequence: monotonic.lastAcceptedSequence,
              lastAcknowledgement: {
                ...state.lastAcknowledgement,
                replayKey: {
                  ...state.lastAcknowledgement.replayKey,
                  sequence: monotonic.lastAcceptedSequence,
                },
              },
            }
          : state
      ),
    };
    expect(isRuntimeIngressSessionStateRecoverable(duplicateSequence)).toBe(false);
  });

  it('derives full lane authority from persisted credential scope and treats body ids as assertions', async () => {
    const mismatchCases: {
      readonly name: string;
      readonly bodyIdentityAssertions?: RuntimeIngressBodyIdentityAssertions;
      readonly authority?: RuntimeIngressAuthority;
      readonly reason: string;
    }[] = [
      {
        name: 'body team',
        bodyIdentityAssertions: {
          teamId: parseTeamId(`team_${'d'.repeat(32)}`),
        },
        reason: 'body_authority_mismatch',
      },
      {
        name: 'body run',
        bodyIdentityAssertions: {
          runId: parseRunId(`run_${'e'.repeat(32)}`),
        },
        reason: 'body_authority_mismatch',
      },
      {
        name: 'body lane',
        bodyIdentityAssertions: { laneId: parseLaneId('lane:other') },
        reason: 'body_authority_mismatch',
      },
      {
        name: 'body provider',
        bodyIdentityAssertions: { providerId: 'codex' },
        reason: 'body_authority_mismatch',
      },
      {
        name: 'relay provider',
        authority: { ...createHarness().authority, providerId: 'codex' },
        reason: 'credential_scope_mismatch',
      },
      {
        name: 'relay team',
        authority: {
          ...createHarness().authority,
          teamId: parseTeamId(`team_${'f'.repeat(32)}`),
        },
        reason: 'credential_scope_mismatch',
      },
      {
        name: 'relay run',
        authority: {
          ...createHarness().authority,
          runId: parseRunId(`run_${'1'.repeat(32)}`),
        },
        reason: 'credential_scope_mismatch',
      },
      {
        name: 'relay lane',
        authority: {
          ...createHarness().authority,
          laneId: parseLaneId('lane:other'),
        },
        reason: 'credential_scope_mismatch',
      },
      {
        name: 'relay plan generation',
        authority: { ...createHarness().authority, planGeneration: 8 },
        reason: 'credential_scope_mismatch',
      },
      {
        name: 'relay credential generation',
        authority: { ...createHarness().authority, credentialGeneration: 4 },
        reason: 'credential_scope_mismatch',
      },
    ];

    for (const mismatch of mismatchCases) {
      const harness = createHarness();
      const outcome = await executor(harness.recovery).execute({
        ...harness.request,
        authority: mismatch.authority ?? harness.authority,
        bodyIdentityAssertions: mismatch.bodyIdentityAssertions,
      });
      expect(outcome, mismatch.name).toEqual({
        status: 'rejected',
        reason: mismatch.reason,
      });
      expect(harness.recovery.effectApplicationCount, mismatch.name).toBe(0);
    }

    const verbScoped = createHarness(['runtime.bootstrap-checkin', 'runtime.heartbeat']);
    await expect(
      executor(verbScoped.recovery).execute({
        ...verbScoped.request,
        authority: {
          ...verbScoped.authority,
          verb: 'runtime.deliver-message',
        },
      })
    ).resolves.toEqual({
      status: 'rejected',
      reason: 'credential_scope_mismatch',
    });
    expect(verbScoped.recovery.effectApplicationCount).toBe(0);
  });

  it('enforces bootstrap, runtime-instance binding, and delivery ownership durably', async () => {
    const harness = createHarness();
    await expect(
      executor(harness.recovery).execute(
        nextRequest(harness, 'runtime.heartbeat', 'command:heartbeat:1', 1, BOOTSTRAP_OBSERVED_AT)
      )
    ).resolves.toEqual({ status: 'rejected', reason: 'bootstrap_required' });
    await acceptBootstrap(harness);

    const heartbeat = nextRequest(
      harness,
      'runtime.heartbeat',
      'command:heartbeat:2',
      2,
      HEARTBEAT_OBSERVED_AT
    );
    await expect(
      executor(harness.recovery, RESTARTED_AT).execute({
        ...heartbeat,
        runtimeInstanceId: parseRuntimeIngressRuntimeInstanceId('runtime-instance:forged'),
      })
    ).resolves.toEqual({ status: 'rejected', reason: 'runtime_instance_mismatch' });
    await expect(
      executor(harness.recovery, RESTARTED_AT).execute({
        ...heartbeat,
        deliveryOwnerId: parseMemberId(`member_${'9'.repeat(32)}`),
      })
    ).resolves.toEqual({ status: 'rejected', reason: 'delivery_owner_mismatch' });
    await expect(
      executor(harness.recovery, RESTARTED_AT).execute(
        nextRequest(
          harness,
          'runtime.bootstrap-checkin',
          'command:bootstrap:2',
          2,
          HEARTBEAT_OBSERVED_AT
        )
      )
    ).resolves.toEqual({ status: 'rejected', reason: 'bootstrap_already_accepted' });

    await expect(
      executor(harness.recovery, RESTARTED_AT).execute(heartbeat)
    ).resolves.toMatchObject({
      status: 'accepted',
    });
    const restarted = harness.recovery.restart();
    const delivery = nextRequest(
      harness,
      'runtime.deliver-message',
      'command:delivery:3',
      3,
      '2026-07-23T10:02:30.000Z',
      '{"target":"user"}'
    );
    await expect(
      executor(restarted, '2026-07-23T10:03:00.000Z').execute(delivery)
    ).resolves.toMatchObject({ status: 'accepted' });
    expect(restarted.session(harness.session.sessionId)).toMatchObject({
      phase: 'active',
      runtimeInstanceId: harness.request.runtimeInstanceId,
      deliveryOwnerId: harness.request.deliveryOwnerId,
      lastAcceptedSequence: 3,
      acceptedVerbs: [
        { verb: 'runtime.bootstrap-checkin', acceptedCount: 1, lastSequence: 1 },
        { verb: 'runtime.deliver-message', acceptedCount: 1, lastSequence: 3 },
        { verb: 'runtime.heartbeat', acceptedCount: 1, lastSequence: 2 },
      ],
    });
  });

  it('uses real ISO calendar parsing and numeric freshness/order checks', async () => {
    const invalidCalendar = createHarness();
    await expect(
      executor(invalidCalendar.recovery).execute({
        ...invalidCalendar.request,
        observedAtIso: '2026-02-30T10:00:30.000Z',
      })
    ).resolves.toEqual({ status: 'rejected', reason: 'protocol_invalid' });

    const stale = createHarness();
    await expect(
      executor(stale.recovery).execute({
        ...stale.request,
        observedAtIso: '2026-07-23T09:50:00.000Z',
      })
    ).resolves.toEqual({ status: 'rejected', reason: 'event_not_fresh' });

    const future = createHarness();
    await expect(
      executor(future.recovery).execute({
        ...future.request,
        observedAtIso: '2026-07-23T10:01:31.000Z',
      })
    ).resolves.toEqual({ status: 'rejected', reason: 'event_not_fresh' });

    const ordered = createHarness();
    await acceptBootstrap(ordered);
    await expect(
      executor(ordered.recovery, RESTARTED_AT).execute(
        nextRequest(ordered, 'runtime.heartbeat', 'command:heartbeat:2', 2, BOOTSTRAP_OBSERVED_AT)
      )
    ).resolves.toEqual({ status: 'rejected', reason: 'event_out_of_order' });

    const beforeIssue = createHarness();
    await expect(
      executor(beforeIssue.recovery, '2026-07-23T09:59:59.999Z').execute(beforeIssue.request)
    ).resolves.toEqual({ status: 'rejected', reason: 'event_not_fresh' });
  });

  it('fences command and sequence reuse without repeating a lane effect', async () => {
    const harness = createHarness();
    await acceptBootstrap(harness);
    const heartbeat = nextRequest(
      harness,
      'runtime.heartbeat',
      'command:heartbeat:2',
      2,
      HEARTBEAT_OBSERVED_AT
    );
    await expect(
      executor(harness.recovery, RESTARTED_AT).execute(heartbeat)
    ).resolves.toMatchObject({
      status: 'accepted',
    });
    await expect(
      executor(harness.recovery, RESTARTED_AT).execute({
        ...heartbeat,
        commandId: parseRuntimeIngressCommandId('command:different:2'),
      })
    ).resolves.toEqual({ status: 'rejected', reason: 'sequence_out_of_order' });
    await expect(
      executor(harness.recovery, RESTARTED_AT).execute({
        ...heartbeat,
        effect: { payloadJson: '{"different":true}' },
      })
    ).resolves.toEqual({ status: 'rejected', reason: 'replay_conflict' });
    expect(harness.recovery.effectApplicationCount).toBe(2);
  });

  it('fails closed on an impossible persisted durable-command recovery state', async () => {
    const harness = createHarness();
    await acceptBootstrap(harness);
    harness.recovery.corruptOnlyCommand();

    await expect(executor(harness.recovery).execute(harness.request)).resolves.toEqual({
      status: 'rejected',
      reason: 'recovery_required',
    });
    expect(harness.recovery.effectApplicationCount).toBe(1);
  });

  it('rejects forged or altered persisted outcome and effect-evidence bindings', async () => {
    const corruptions: readonly {
      readonly name: string;
      readonly corrupt: (recovery: FakeRuntimeIngressDurableRecovery) => void;
    }[] = [
      {
        name: 'forged acknowledgement',
        corrupt: (recovery) => recovery.corruptOnlyCommandOutcome('acknowledgement'),
      },
      {
        name: 'forged effect',
        corrupt: (recovery) => recovery.corruptOnlyCommandEffectEvidence('effect'),
      },
      {
        name: 'altered acknowledgement timestamp',
        corrupt: (recovery) => recovery.corruptOnlyCommandOutcome('accepted_instant'),
      },
      {
        name: 'altered evidence timestamp',
        corrupt: (recovery) => recovery.corruptOnlyCommandEffectEvidence('accepted_instant'),
      },
      {
        name: 'altered acknowledgement session',
        corrupt: (recovery) => recovery.corruptOnlyCommandOutcome('session'),
      },
      {
        name: 'altered evidence session',
        corrupt: (recovery) => recovery.corruptOnlyCommandEffectEvidence('session'),
      },
      {
        name: 'altered workspace scope',
        corrupt: (recovery) => recovery.corruptOnlyCommandEffectEvidence('scope'),
      },
      {
        name: 'altered durable command',
        corrupt: (recovery) => recovery.corruptOnlyCommandEffectEvidence('command'),
      },
      {
        name: 'altered runtime instance',
        corrupt: (recovery) => recovery.corruptOnlyCommandEffectEvidence('runtime_instance'),
      },
      {
        name: 'altered transaction',
        corrupt: (recovery) => recovery.corruptOnlyCommandEffectEvidence('transaction'),
      },
    ];

    for (const corruption of corruptions) {
      const harness = createHarness();
      await acceptBootstrap(harness);
      corruption.corrupt(harness.recovery);

      await expect(
        executor(harness.recovery).execute(harness.request),
        corruption.name
      ).resolves.toEqual({
        status: 'rejected',
        reason: 'recovery_required',
      });
      expect(harness.recovery.effectApplicationCount, corruption.name).toBe(1);
    }
  });

  it('replays a valid persisted outcome only when its complete effect evidence remains exact', async () => {
    const harness = createHarness();
    await acceptBootstrap(harness);
    const expected = harness.recovery
      .session(harness.session.sessionId)
      ?.acceptedVerbs.find(
        (state) => state.verb === 'runtime.bootstrap-checkin'
      )?.lastAcknowledgement;

    await expect(
      executor(harness.recovery, RESTARTED_AT).execute(harness.request)
    ).resolves.toEqual({
      status: 'replayed',
      acknowledgement: expected,
    });
    expect(harness.recovery.effectApplicationCount).toBe(1);
  });

  it('rejects an invalid bearer before durable command, session, or lane-effect mutation', async () => {
    const harness = createHarness();
    const outcome = await executor(harness.recovery).execute({
      ...harness.request,
      presentedCredential: {
        ...harness.request.presentedCredential,
        secret: parseRuntimeIngressPresentedSecret('presented-secret:wrong'),
      },
    });

    expect(outcome).toEqual({ status: 'rejected', reason: 'credential_invalid' });
    expect(harness.recovery.effectApplicationCount).toBe(0);
    expect(harness.recovery.onlyCommand).toBeNull();
    expect(harness.recovery.session(harness.session.sessionId)).toEqual(harness.session);
  });

  it('revokes credential and session atomically and validates revocation instants', async () => {
    const harness = createHarness();
    await acceptBootstrap(harness);
    const revoker = new RevokeRuntimeIngressCredential(harness.recovery);

    await expect(
      revoker.execute({
        credentialId: harness.credential.credentialId,
        expectedScope: { ...harness.credential.scope, providerId: 'codex' },
        revokedAtIso: REVOKED_AT,
        reason: 'wrong-scope',
      })
    ).resolves.toEqual({
      status: 'rejected',
      reason: 'credential_scope_mismatch',
    });
    await expect(
      revoker.execute({
        credentialId: harness.credential.credentialId,
        expectedScope: harness.credential.scope,
        revokedAtIso: '2026-02-30T10:03:00.000Z',
        reason: 'invalid-calendar',
      })
    ).resolves.toEqual({ status: 'rejected', reason: 'revocation_invalid' });
    await expect(
      revoker.execute({
        credentialId: harness.credential.credentialId,
        expectedScope: harness.credential.scope,
        revokedAtIso: '2026-07-23T09:59:59.999Z',
        reason: 'before-issue',
      })
    ).resolves.toEqual({ status: 'rejected', reason: 'revocation_invalid' });

    await expect(
      revoker.execute({
        credentialId: harness.credential.credentialId,
        expectedScope: harness.credential.scope,
        revokedAtIso: REVOKED_AT,
        reason: 'lane-stopped',
      })
    ).resolves.toEqual({ status: 'revoked' });
    expect(harness.recovery.credential(harness.credential.credentialId)).toMatchObject({
      phase: 'revoked',
      revision: 2,
      revocationReason: 'lane-stopped',
    });
    expect(harness.recovery.session(harness.session.sessionId)).toMatchObject({
      phase: 'revoked',
      credentialRevision: 2,
      revision: 3,
      runtimeInstanceId: harness.request.runtimeInstanceId,
    });
    await expect(
      new RevokeRuntimeIngressCredential(harness.recovery).execute({
        credentialId: harness.credential.credentialId,
        expectedScope: harness.credential.scope,
        revokedAtIso: REVOKED_AT,
        reason: 'lane-stopped',
      })
    ).resolves.toEqual({ status: 'already_revoked' });
  });
});
