import {
  buildCommandFingerprintRecord,
  type CommandClaimRecord,
  type CommandClaimScope,
  commitDurableCommand,
  createDurableCommandDescriptorIdentity,
  createInitialEffectPlan,
  type DurableApplicationCommandEffectRecord,
  type DurableApplicationCommandRecord,
  encodeCommandFingerprintPreimage,
  resolveCommandClaim,
  selectCommandFingerprintKeyVersion,
  transitionDurableCommandState,
  transitionDurableEffectState,
} from '@features/application-command-ledger';
import {
  areRuntimeIngressCredentialsExact,
  isRuntimeIngressCredentialRecoverable,
  isRuntimeIngressSessionStateRecoverable,
  revokeRuntimeIngressCredential,
  revokeRuntimeIngressSessionState,
  type RuntimeIngressCanonicalEffect,
  type RuntimeIngressCredential,
  type RuntimeIngressSessionState,
  type RuntimeIngressVerb,
} from '@features/team-runtime-control/core/domain/runtime-ingress';

import type {
  ApplyRuntimeIngressAtomicallyRequest,
  ApplyRuntimeIngressAtomicallyResult,
  FingerprintRuntimeIngressCommandRequest,
  LoadRuntimeIngressCommandRequest,
  RevokeRuntimeIngressCredentialAtomicallyRequest,
  RuntimeIngressDurableCommandRecord,
  RuntimeIngressDurableEffectEvidence,
  RuntimeIngressDurableRecoveryPort,
  VerifyRuntimeIngressCredentialRequest,
} from '@features/team-runtime-control/core/application/runtime-ingress';

const ACTIVE_FINGERPRINT_KEY_VERSION = 'runtime-ingress-test-key-v1';

interface FakeDurableBacking {
  credentials: Map<string, RuntimeIngressCredential>;
  presentedSecrets: Map<string, string>;
  sessions: Map<string, RuntimeIngressSessionState>;
  commands: Map<string, RuntimeIngressDurableCommandRecord>;
  effects: Map<string, RuntimeIngressCanonicalEffect>;
}

export class FakeRuntimeIngressCrashError extends Error {
  constructor(readonly crashPoint: 'before_atomic_commit' | 'after_atomic_commit') {
    super(`fake-runtime-ingress-crash:${crashPoint}`);
  }
}

export class FakeRuntimeIngressDurableRecovery implements RuntimeIngressDurableRecoveryPort {
  private crashBeforeCommit = false;
  private crashAfterCommit = false;
  private revokeBeforeCommandLoad = false;
  private atomicApplicationBarrier:
    | {
        remaining: number;
        readonly promise: Promise<void>;
        readonly release: () => void;
      }
    | undefined;

  constructor(private readonly backing: FakeDurableBacking = createBacking()) {}

  restart(): FakeRuntimeIngressDurableRecovery {
    return new FakeRuntimeIngressDurableRecovery(this.backing);
  }

  seed(
    credential: RuntimeIngressCredential,
    presentedSecret: string,
    session: RuntimeIngressSessionState
  ): void {
    if (
      !isRuntimeIngressCredentialRecoverable(credential) ||
      !isRuntimeIngressSessionStateRecoverable(session)
    ) {
      throw new TypeError('fake-runtime-ingress-seed-invalid');
    }
    this.backing.credentials.set(credential.credentialId, credential);
    this.backing.presentedSecrets.set(credential.credentialId, presentedSecret);
    this.backing.sessions.set(session.sessionId, session);
  }

  failBeforeAtomicCommitOnce(): void {
    this.crashBeforeCommit = true;
  }

  failAfterAtomicCommitOnce(): void {
    this.crashAfterCommit = true;
  }

  revokeBeforeNextCommandLoad(): void {
    this.revokeBeforeCommandLoad = true;
  }

  synchronizeNextAtomicApplications(count = 2): void {
    if (!Number.isSafeInteger(count) || count < 2 || this.atomicApplicationBarrier) {
      throw new TypeError('fake-runtime-ingress-atomic-barrier-invalid');
    }
    let release = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.atomicApplicationBarrier = { remaining: count, promise, release };
  }

  deleteSession(sessionId: RuntimeIngressSessionState['sessionId']): void {
    this.backing.sessions.delete(sessionId);
  }

  corruptSession(sessionId: RuntimeIngressSessionState['sessionId']): void {
    this.backing.sessions.set(sessionId, {
      sessionStateVersion: 1,
      revision: 0,
    } as RuntimeIngressSessionState);
  }

  corruptSessionRuntimeInstanceBinding(sessionId: RuntimeIngressSessionState['sessionId']): void {
    const session = this.backing.sessions.get(sessionId);
    if (!session) throw new Error('fake-runtime-ingress-session-missing');
    this.backing.sessions.set(sessionId, {
      ...session,
      runtimeInstanceId: 'runtime-instance:forged',
    } as RuntimeIngressSessionState);
  }

  corruptOnlyCommand(): void {
    const entry = [...this.backing.commands.entries()][0];
    if (!entry) throw new Error('fake-runtime-ingress-command-missing');
    const [key, command] = entry;
    this.backing.commands.set(key, {
      ...command,
      state: 'running',
    });
  }

  corruptOnlyCommandOutcome(binding: 'acknowledgement' | 'accepted_instant' | 'session'): void {
    this.replaceOnlyCommand((command) => {
      const acknowledgement = parseJsonObject(command.outcomeJson);
      const replayKey = requireObject(acknowledgement.replayKey);
      switch (binding) {
        case 'acknowledgement':
          acknowledgement.acknowledgementId = `ack:${'f'.repeat(64)}`;
          break;
        case 'accepted_instant':
          acknowledgement.acceptedAtIso = '2026-07-23T10:01:00.001Z';
          break;
        case 'session':
          acknowledgement.replayKey = {
            ...replayKey,
            sessionId: 'runtime-session:forged',
          };
          break;
      }
      return { ...command, outcomeJson: JSON.stringify(acknowledgement) };
    });
  }

  corruptOnlyCommandEffectEvidence(
    binding:
      | 'effect'
      | 'accepted_instant'
      | 'session'
      | 'scope'
      | 'command'
      | 'runtime_instance'
      | 'transaction'
  ): void {
    this.replaceOnlyCommand((command) => {
      const effect = command.effects[0];
      const evidenceRecord = effect?.evidence[0];
      if (!effect || !evidenceRecord) {
        throw new Error('fake-runtime-ingress-effect-evidence-missing');
      }
      const evidence = parseJsonObject(
        evidenceRecord.evidenceJson
      ) as unknown as RuntimeIngressDurableEffectEvidence;
      let corrupted: RuntimeIngressDurableEffectEvidence;
      switch (binding) {
        case 'effect':
          corrupted = {
            ...evidence,
            effectRef:
              `effect:${'e'.repeat(64)}` as RuntimeIngressDurableEffectEvidence['effectRef'],
          };
          break;
        case 'accepted_instant':
          corrupted = { ...evidence, acceptedAtIso: '2026-07-23T10:01:00.001Z' };
          break;
        case 'session':
          corrupted = {
            ...evidence,
            replayKey: {
              ...evidence.replayKey,
              sessionId: 'runtime-session:forged',
            } as RuntimeIngressDurableEffectEvidence['replayKey'],
          };
          break;
        case 'scope':
          corrupted = {
            ...evidence,
            claimScope: { ...evidence.claimScope, stableActorId: '["forged-scope"]' },
          };
          break;
        case 'command':
          corrupted = { ...evidence, durableCommandId: 'command:forged' };
          break;
        case 'runtime_instance':
          corrupted = {
            ...evidence,
            replayKey: {
              ...evidence.replayKey,
              runtimeInstanceId: 'runtime-instance:forged',
            } as RuntimeIngressDurableEffectEvidence['replayKey'],
          };
          break;
        case 'transaction':
          corrupted = {
            ...evidence,
            transaction: { ...evidence.transaction, attemptId: 'attempt:forged' },
          };
          break;
      }
      return {
        ...command,
        effects: [
          {
            ...effect,
            evidence: [
              {
                ...evidenceRecord,
                evidenceJson: JSON.stringify(corrupted),
              },
            ],
          },
        ],
      };
    });
  }

  get effectApplicationCount(): number {
    return this.backing.effects.size;
  }

  get onlyCommand(): RuntimeIngressDurableCommandRecord | null {
    return [...this.backing.commands.values()][0] ?? null;
  }

  session(sessionId: RuntimeIngressSessionState['sessionId']): RuntimeIngressSessionState | null {
    return this.backing.sessions.get(sessionId) ?? null;
  }

  credential(
    credentialId: RuntimeIngressCredential['credentialId']
  ): RuntimeIngressCredential | null {
    return this.backing.credentials.get(credentialId) ?? null;
  }

  async verifyCredential(request: VerifyRuntimeIngressCredentialRequest) {
    await Promise.resolve();
    const credential = this.backing.credentials.get(request.presented.credentialId);
    const secret = this.backing.presentedSecrets.get(request.presented.credentialId);
    if (!credential || secret !== request.presented.secret) {
      return { status: 'rejected' as const };
    }
    return { status: 'verified' as const, credential };
  }

  async loadCredential(credentialId: RuntimeIngressCredential['credentialId']) {
    await Promise.resolve();
    const credential = this.backing.credentials.get(credentialId);
    return credential ? { status: 'found' as const, credential } : { status: 'missing' as const };
  }

  async loadSession(sessionId: RuntimeIngressSessionState['sessionId']) {
    await Promise.resolve();
    const session = this.backing.sessions.get(sessionId);
    return session ? { status: 'found' as const, session } : { status: 'missing' as const };
  }

  async fingerprintCommand(request: FingerprintRuntimeIngressCommandRequest) {
    await Promise.resolve();
    if (
      encodeCommandFingerprintPreimage(request.prepared.preimage) !==
      request.prepared.encodedPreimage
    ) {
      return { status: 'unavailable' as const };
    }
    const existing = this.backing.commands.get(commandClaimKey(request.scope));
    const keyVersion = selectCommandFingerprintKeyVersion(
      existing?.claim ?? null,
      ACTIVE_FINGERPRINT_KEY_VERSION
    );
    return {
      status: 'fingerprinted' as const,
      fingerprint: buildCommandFingerprintRecord(
        request.prepared.preimage,
        keyVersion,
        deterministicTestHmac(request.prepared.encodedPreimage, keyVersion)
      ),
    };
  }

  async loadCommand(request: LoadRuntimeIngressCommandRequest) {
    await Promise.resolve();
    if (this.revokeBeforeCommandLoad) {
      this.revokeBeforeCommandLoad = false;
      this.revokeCredentialForRace(request.expectedCredential);
    }
    const credential = this.backing.credentials.get(request.expectedCredential.credentialId);
    if (
      credential?.phase !== 'active' ||
      !areRuntimeIngressCredentialsExact(credential, request.expectedCredential)
    ) {
      return { status: 'credential_inactive' as const };
    }
    const session = this.backing.sessions.get(request.expectedSession.sessionId);
    if (!session || !areSessionsExact(session, request.expectedSession)) {
      return { status: 'session_conflict' as const };
    }
    const command = this.backing.commands.get(commandClaimKey(request.scope));
    if (!command) return { status: 'missing' as const };
    const resolution = resolveCommandClaim(command.claim, {
      scope: request.scope,
      fingerprint: request.fingerprint,
    });
    return resolution.outcome === 'idempotency_mismatch'
      ? { status: 'fingerprint_conflict' as const }
      : { status: 'found' as const, command };
  }

  async applyAtomically(
    request: ApplyRuntimeIngressAtomicallyRequest
  ): Promise<ApplyRuntimeIngressAtomicallyResult> {
    await Promise.resolve();
    await this.waitAtAtomicApplicationBarrier();
    const credential = this.backing.credentials.get(request.expectedCredential.credentialId);
    if (
      credential?.phase !== 'active' ||
      !areRuntimeIngressCredentialsExact(credential, request.expectedCredential)
    ) {
      return { status: 'credential_inactive' };
    }
    const session = this.backing.sessions.get(request.expectedSession.sessionId);
    if (!session || !areSessionsExact(session, request.expectedSession)) {
      return { status: 'session_conflict' };
    }
    if (!isValidAtomicTransition(request) || !doesFingerprintMatchDescriptor(request)) {
      return { status: 'unavailable' };
    }

    const claim: CommandClaimRecord<RuntimeIngressVerb> = {
      scope: request.claimScope,
      fingerprint: request.fingerprint,
    };
    const key = commandClaimKey(request.claimScope);
    const existing = this.backing.commands.get(key);
    if (existing) {
      const resolution = resolveCommandClaim(existing.claim, claim);
      if (resolution.outcome === 'idempotency_mismatch') {
        return { status: 'fingerprint_conflict' };
      }
      if (existing.state !== 'committed') {
        return { status: 'recovery_required' };
      }
      return { status: 'duplicate', command: existing, session };
    }
    if (this.crashBeforeCommit) {
      this.crashBeforeCommit = false;
      throw new FakeRuntimeIngressCrashError('before_atomic_commit');
    }

    const acceptedAt = request.acknowledgement.acceptedAtIso;
    const durableCommandId = request.acknowledgement.replayKey.commandId;
    const transaction = Object.freeze({
      generation: 1,
      attemptId: `attempt:${request.acknowledgement.replayKey.commandId}`,
    });
    const attempt = Object.freeze({
      ...transaction,
      ownerId: 'runtime-ingress-test-owner',
      leaseToken: 'runtime-ingress-test-lease',
    });
    const initialPlan = createInitialEffectPlan(request.descriptor);
    const running = transitionDurableCommandState('prepared', 'running');
    const attempting = transitionDurableEffectState(
      request.descriptor.effects[0],
      initialPlan[0].state,
      'attempting'
    );
    const observedSucceeded = transitionDurableEffectState(
      request.descriptor.effects[0],
      attempting,
      'observed_succeeded'
    );
    const committedPlan = [
      {
        ...initialPlan[0],
        state: observedSucceeded,
      },
    ] as const;
    const committed = commitDurableCommand(
      running,
      request.descriptor,
      createDurableCommandDescriptorIdentity(request.descriptor),
      committedPlan
    );
    const effects: readonly DurableApplicationCommandEffectRecord[] = Object.freeze([
      Object.freeze({
        ...committedPlan[0],
        updatedAt: acceptedAt,
        evidence: Object.freeze([
          Object.freeze({
            ...request.descriptor.effects[0],
            outcome: 'observed_succeeded' as const,
            sequence: 1,
            evidenceJson: JSON.stringify({
              evidenceVersion: 1,
              durableCommandId,
              acknowledgementId: request.acknowledgement.acknowledgementId,
              effectRef: request.acknowledgement.effectRef,
              replayKey: request.acknowledgement.replayKey,
              claimScope: request.claimScope,
              fingerprint: request.fingerprint,
              transaction,
              effect: {
                effectId: committedPlan[0].effectId,
                effectVersion: committedPlan[0].effectVersion,
                recoveryClass: committedPlan[0].recoveryClass,
                evidenceSchemaVersion: committedPlan[0].evidenceSchemaVersion,
                ordinal: committedPlan[0].ordinal,
              },
              acceptedAtIso: acceptedAt,
            } satisfies RuntimeIngressDurableEffectEvidence),
            recordedAt: acceptedAt,
          }),
        ]),
      }),
    ]);
    const command: DurableApplicationCommandRecord<RuntimeIngressVerb> = Object.freeze({
      commandId: durableCommandId,
      claim,
      descriptor: createDurableCommandDescriptorIdentity(request.descriptor),
      attempt: Object.freeze({
        ...attempt,
        claimedAt: acceptedAt,
        leaseExpiresAt: acceptedAt,
      }),
      state: committed,
      retentionClass: 'runtime-ingress-receipt',
      auditSessionId: request.acknowledgement.replayKey.sessionId,
      outcomeJson: JSON.stringify(request.acknowledgement),
      errorCode: null,
      errorJson: null,
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
      committedAt: acceptedAt,
      effects,
    });

    const nextSessions = new Map(this.backing.sessions);
    const nextCommands = new Map(this.backing.commands);
    const nextEffects = new Map(this.backing.effects);
    nextSessions.set(request.nextSession.sessionId, request.nextSession);
    nextCommands.set(key, command);
    nextEffects.set(key, request.effect);
    this.backing.sessions = nextSessions;
    this.backing.commands = nextCommands;
    this.backing.effects = nextEffects;

    if (this.crashAfterCommit) {
      this.crashAfterCommit = false;
      throw new FakeRuntimeIngressCrashError('after_atomic_commit');
    }
    return {
      status: 'applied',
      command,
      session: request.nextSession,
    };
  }

  async revokeCredentialAtomically(request: RevokeRuntimeIngressCredentialAtomicallyRequest) {
    await Promise.resolve();
    const credential = this.backing.credentials.get(request.expectedCredential.credentialId);
    if (!credential) return { status: 'missing' as const };
    if (credential.phase === 'revoked') {
      return { status: 'already_revoked' as const, credential };
    }
    if (!areRuntimeIngressCredentialsExact(credential, request.expectedCredential)) {
      return { status: 'conflict' as const };
    }
    if (
      !isRuntimeIngressCredentialRecoverable(request.nextCredential) ||
      request.nextCredential.phase !== 'revoked' ||
      request.nextCredential.revision !== credential.revision + 1
    ) {
      return { status: 'unavailable' as const };
    }

    const nextCredentials = new Map(this.backing.credentials);
    const nextSessions = new Map(this.backing.sessions);
    nextCredentials.set(request.nextCredential.credentialId, request.nextCredential);
    const session = nextSessions.get(request.nextCredential.sessionId);
    if (session && isRuntimeIngressSessionStateRecoverable(session)) {
      const revokedSession = revokeRuntimeIngressSessionState(session, request.nextCredential);
      if (revokedSession) {
        nextSessions.set(revokedSession.sessionId, revokedSession);
      } else {
        nextSessions.delete(request.nextCredential.sessionId);
      }
    } else {
      nextSessions.delete(request.nextCredential.sessionId);
    }
    this.backing.credentials = nextCredentials;
    this.backing.sessions = nextSessions;
    return { status: 'revoked' as const, credential: request.nextCredential };
  }

  private revokeCredentialForRace(expected: RuntimeIngressCredential): void {
    const current = this.backing.credentials.get(expected.credentialId);
    if (current?.phase !== 'active') return;
    const transition = revokeRuntimeIngressCredential(
      current,
      '2026-07-23T10:03:00.000Z',
      'load-command-race'
    );
    if (transition.status !== 'revoked') return;
    this.backing.credentials.set(transition.next.credentialId, transition.next);
    const session = this.backing.sessions.get(transition.next.sessionId);
    if (!session) return;
    const revokedSession = revokeRuntimeIngressSessionState(session, transition.next);
    if (revokedSession) this.backing.sessions.set(revokedSession.sessionId, revokedSession);
  }

  private replaceOnlyCommand(
    replace: (command: RuntimeIngressDurableCommandRecord) => RuntimeIngressDurableCommandRecord
  ): void {
    const entry = [...this.backing.commands.entries()][0];
    if (!entry) throw new Error('fake-runtime-ingress-command-missing');
    const [key, command] = entry;
    this.backing.commands.set(key, replace(command));
  }

  private async waitAtAtomicApplicationBarrier(): Promise<void> {
    const barrier = this.atomicApplicationBarrier;
    if (!barrier) return;
    barrier.remaining -= 1;
    if (barrier.remaining === 0) {
      this.atomicApplicationBarrier = undefined;
      barrier.release();
    }
    await barrier.promise;
  }
}

function createBacking(): FakeDurableBacking {
  return {
    credentials: new Map(),
    presentedSecrets: new Map(),
    sessions: new Map(),
    commands: new Map(),
    effects: new Map(),
  };
}

function isValidAtomicTransition(request: ApplyRuntimeIngressAtomicallyRequest): boolean {
  const accepted = request.nextSession.acceptedVerbs.find(
    (state) => state.verb === request.acknowledgement.replayKey.authority.verb
  );
  return (
    isRuntimeIngressSessionStateRecoverable(request.nextSession) &&
    request.nextSession.revision === request.expectedSession.revision + 1 &&
    request.nextSession.lastAcceptedSequence === request.acknowledgement.replayKey.sequence &&
    request.nextSession.credentialId === request.expectedCredential.credentialId &&
    request.nextSession.sessionId === request.acknowledgement.replayKey.sessionId &&
    request.nextSession.deliveryOwnerId === request.acknowledgement.replayKey.deliveryOwnerId &&
    request.acknowledgement.replayKey.sessionId === request.expectedSession.sessionId &&
    accepted?.lastCommandId === request.acknowledgement.replayKey.commandId &&
    accepted.lastAcknowledgement === request.acknowledgement
  );
}

function doesFingerprintMatchDescriptor(request: ApplyRuntimeIngressAtomicallyRequest): boolean {
  return (
    request.descriptor.commandKind === request.claimScope.commandKind &&
    request.descriptor.descriptorId === request.fingerprint.descriptorId &&
    request.descriptor.descriptorVersion === request.fingerprint.descriptorVersion &&
    request.descriptor.inputSchemaVersion === request.fingerprint.schemaVersion &&
    request.descriptor.fingerprintVersion === request.fingerprint.fingerprintVersion &&
    request.descriptor.effectPlanVersion === request.fingerprint.effectPlanVersion
  );
}

function areSessionsExact(
  left: RuntimeIngressSessionState,
  right: RuntimeIngressSessionState
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function commandClaimKey(scope: CommandClaimScope<RuntimeIngressVerb>): string {
  return JSON.stringify([
    scope.deploymentId,
    scope.stableActorId,
    scope.commandKind,
    scope.idempotencyKey,
  ]);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') throw new Error('fake-runtime-ingress-json-missing');
  return requireObject(JSON.parse(value) as unknown);
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('fake-runtime-ingress-json-invalid');
  }
  return value as Record<string, unknown>;
}

function deterministicTestHmac(preimage: string, keyVersion: string): string {
  const value = `${keyVersion}\0${preimage}`;
  let words = [
    0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1, 0xd3a2646c, 0xfd7046c5,
  ];
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    words = words.map(
      (valueAtWord, word) => Math.imul(valueAtWord ^ (code + word + index), 0x01000193) >>> 0
    );
  }
  return words.map((word) => word.toString(16).padStart(8, '0')).join('');
}
