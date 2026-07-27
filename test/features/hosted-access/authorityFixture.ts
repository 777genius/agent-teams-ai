import {
  type AuthKeyringEnvelope,
  type AuthKeyringId,
  type AuthKeyringPort,
  type AuthorityBinding,
  type AuthorityRepositoryReadResult,
  type AuthorityRepositoryWriteResult,
  type AuthResetStage,
  type CsrfToken,
  HostedAccessAuthority,
  type HostedAccessAuthorityDependencies,
  type HostedAccessAuthorityPolicy,
  type HostedAccessAuthorityRepositoryPort,
  type HostedAccessAuthorityState,
  type HostedAccessCryptoPort,
  type HostedAccessRandomPort,
  type KeyedSecretHash,
  type OpaqueAuthoritySecret,
  type PairingChallengeDeliveryPort,
  type PairingChallengeId,
  type PairingDrainProofPort,
  parseAuthorityKeyMaterial,
  parseCsrfToken,
  parseKeyedSecretHash,
  parseOpaqueAuthoritySecret,
} from '@features/hosted-access';

export const DEFAULT_POLICY: HostedAccessAuthorityPolicy = Object.freeze({
  pairingChallengeTtlMs: 100,
  pairingMaxAttempts: 3,
  deviceIdleTtlMs: 1_000,
  deviceAbsoluteTtlMs: 10_000,
  deviceRenewalTtlMs: 5_000,
  sessionIdleTtlMs: 100,
  sessionAbsoluteTtlMs: 500,
  sessionRenewalTtlMs: 300,
  predecessorGraceMs: 50,
  predecessorMaxUses: 2,
  retainedDeviceGenerations: 4,
  compareAndSwapAttempts: 12,
});

export const BINDING = Object.freeze({
  deploymentId: 'deployment_00000001',
  restoreGeneration: 0,
}) as AuthorityBinding;

export const REPLACEMENT_BINDING = Object.freeze({
  deploymentId: 'deployment_00000002',
  restoreGeneration: 1,
}) as AuthorityBinding;

type StateStagePredicate = (state: HostedAccessAuthorityState) => boolean;

export class FakeAuthorityRepository implements HostedAccessAuthorityRepositoryPort {
  state: HostedAccessAuthorityState | null = null;
  rollbackFenceRevision: number | null = null;
  loads = 0;
  initializes = 0;
  swaps = 0;
  loseNextCasResponseAfterCommit = false;
  failBeforeCommitWhen: StateStagePredicate | null = null;
  loseAfterCommitWhen: StateStagePredicate | null = null;

  async load(): Promise<AuthorityRepositoryReadResult> {
    this.loads += 1;
    return this.state === null
      ? { status: 'empty', rollbackFenceRevision: this.rollbackFenceRevision }
      : {
          status: 'available',
          state: this.state,
          rollbackFenceRevision: this.rollbackFenceRevision ?? -1,
        };
  }

  async initialize(state: HostedAccessAuthorityState): Promise<AuthorityRepositoryWriteResult> {
    this.initializes += 1;
    if (this.state !== null || this.rollbackFenceRevision !== null || state.revision !== 0) {
      return { status: 'conflict' };
    }
    this.state = state;
    this.rollbackFenceRevision = state.revision;
    return { status: 'committed' };
  }

  async compareAndSwap(input: {
    readonly expectedRevision: number;
    readonly expectedRollbackFenceRevision: number;
    readonly nextState: HostedAccessAuthorityState;
    readonly nextRollbackFenceRevision: number;
  }): Promise<AuthorityRepositoryWriteResult> {
    this.swaps += 1;
    if (
      this.state?.revision !== input.expectedRevision ||
      this.rollbackFenceRevision !== input.expectedRollbackFenceRevision ||
      input.nextState.revision !== input.nextRollbackFenceRevision ||
      input.nextRollbackFenceRevision !== input.expectedRollbackFenceRevision + 1
    ) {
      return { status: 'conflict' };
    }
    if (this.failBeforeCommitWhen?.(input.nextState)) {
      this.failBeforeCommitWhen = null;
      return { status: 'unavailable' };
    }
    this.state = input.nextState;
    this.rollbackFenceRevision = input.nextRollbackFenceRevision;
    if (this.loseNextCasResponseAfterCommit) {
      this.loseNextCasResponseAfterCommit = false;
      return { status: 'unavailable' };
    }
    if (this.loseAfterCommitWhen?.(input.nextState)) {
      this.loseAfterCommitWhen = null;
      return { status: 'unavailable' };
    }
    return { status: 'committed' };
  }

  loseBeforeStage(stage: AuthResetStage): void {
    this.failBeforeCommitWhen = (state) => state.resetIntent?.stage === stage;
  }

  loseAfterStage(stage: AuthResetStage): void {
    this.loseAfterCommitWhen = (state) => state.resetIntent?.stage === stage;
  }
}

export class FakeKeyrings implements AuthKeyringPort {
  active: AuthKeyringEnvelope | null = null;
  readonly staged = new Map<AuthKeyringId, AuthKeyringEnvelope>();
  loads = 0;
  stageCalls = 0;
  activateCalls = 0;
  loseNextStageResponseAfterWrite = false;
  loseNextActivationResponseAfterWrite = false;

  async loadActive() {
    this.loads += 1;
    return this.active === null
      ? ({ status: 'missing' } as const)
      : ({ status: 'available', envelope: this.active } as const);
  }

  async createInitial(envelope: AuthKeyringEnvelope) {
    if (this.active !== null) return { status: 'conflict' } as const;
    this.active = envelope;
    return { status: 'created' } as const;
  }

  async loadStaged(keyringId: AuthKeyringId) {
    const envelope = this.staged.get(keyringId);
    return envelope === undefined
      ? ({ status: 'missing' } as const)
      : ({ status: 'available', envelope } as const);
  }

  async stageReplacement(envelope: AuthKeyringEnvelope) {
    this.stageCalls += 1;
    const existing = this.staged.get(envelope.keyringId);
    if (existing !== undefined) return { status: 'already_applied' } as const;
    this.staged.set(envelope.keyringId, envelope);
    if (this.loseNextStageResponseAfterWrite) {
      this.loseNextStageResponseAfterWrite = false;
      return { status: 'unavailable' } as const;
    }
    return { status: 'staged' } as const;
  }

  async activateStaged(keyringId: AuthKeyringId) {
    this.activateCalls += 1;
    const envelope = this.staged.get(keyringId);
    if (envelope === undefined) {
      return this.active?.keyringId === keyringId
        ? ({ status: 'already_applied' } as const)
        : ({ status: 'conflict' } as const);
    }
    this.active = envelope;
    this.staged.delete(keyringId);
    if (this.loseNextActivationResponseAfterWrite) {
      this.loseNextActivationResponseAfterWrite = false;
      return { status: 'unavailable' } as const;
    }
    return { status: 'activated' } as const;
  }
}

export class FakeChallengeDelivery implements PairingChallengeDeliveryPort {
  readonly delivered = new Map<PairingChallengeId, OpaqueAuthoritySecret>();
  statusCalls = 0;
  publishCalls = 0;
  removeCalls = 0;
  failNextPublishBeforeWrite = false;
  loseNextPublishResponseAfterWrite = false;
  removeUnavailable = false;
  loseNextRemoveResponseAfterWrite = false;

  async status(challengeId: PairingChallengeId) {
    this.statusCalls += 1;
    return {
      status: this.delivered.has(challengeId) ? 'present' : 'missing',
    } as const;
  }

  async publish(input: {
    readonly challengeId: PairingChallengeId;
    readonly secret: OpaqueAuthoritySecret;
    readonly expiresAt: number;
  }) {
    this.publishCalls += 1;
    if (this.failNextPublishBeforeWrite) {
      this.failNextPublishBeforeWrite = false;
      return { status: 'unavailable' } as const;
    }
    this.delivered.set(input.challengeId, input.secret);
    if (this.loseNextPublishResponseAfterWrite) {
      this.loseNextPublishResponseAfterWrite = false;
      return { status: 'unavailable' } as const;
    }
    return { status: 'published' } as const;
  }

  async remove(challengeId: PairingChallengeId) {
    this.removeCalls += 1;
    if (this.removeUnavailable) return { status: 'unavailable' } as const;
    const existed = this.delivered.delete(challengeId);
    if (this.loseNextRemoveResponseAfterWrite) {
      this.loseNextRemoveResponseAfterWrite = false;
      return { status: 'unavailable' } as const;
    }
    return { status: existed ? 'removed' : 'already_missing' } as const;
  }

  secret(challengeId: PairingChallengeId): OpaqueAuthoritySecret {
    const secret = this.delivered.get(challengeId);
    if (secret === undefined) throw new Error('fixture challenge secret missing');
    return secret;
  }

  forcePresent(challengeId: PairingChallengeId, secret: OpaqueAuthoritySecret): void {
    this.delivered.set(challengeId, secret);
  }
}

class FakeRandom implements HostedAccessRandomPort {
  calls = 0;
  private idCounter = 0;
  private secretCounter = 0;

  async randomId(kind: Parameters<HostedAccessRandomPort['randomId']>[0]) {
    this.calls += 1;
    this.idCounter += 1;
    return `${kind}_${String(this.idCounter).padStart(8, '0')}`;
  }

  async randomSecret(kind: Parameters<HostedAccessRandomPort['randomSecret']>[0], _byteLength: 32) {
    this.calls += 1;
    this.secretCounter += 1;
    const value = `authority_${kind}_${String(this.secretCounter).padStart(
      8,
      '0'
    )}_abcdefghijklmnopqrstuvwxyz0123456789`;
    return kind === 'hash-key' || kind === 'csrf-key'
      ? parseAuthorityKeyMaterial(value)
      : parseOpaqueAuthoritySecret(value);
  }
}

class FakeCrypto implements HostedAccessCryptoPort {
  calls = 0;

  async keyedHash(input: {
    readonly key: string;
    readonly purpose: string;
    readonly secret: OpaqueAuthoritySecret;
  }): Promise<KeyedSecretHash> {
    this.calls += 1;
    return parseKeyedSecretHash(
      `hmac-sha256:${deterministicHex(`${input.key}\u0000${input.purpose}\u0000${input.secret}`)}`
    );
  }

  async deriveSecret(input: {
    readonly key: string;
    readonly purpose: string;
    readonly sourceSecret: OpaqueAuthoritySecret;
    readonly context: string;
  }): Promise<OpaqueAuthoritySecret> {
    this.calls += 1;
    return parseOpaqueAuthoritySecret(
      `derived_${input.purpose}_${deterministicHex(
        `${input.key}\u0000${input.purpose}\u0000${input.sourceSecret}\u0000${input.context}`
      )}`
    );
  }

  async deriveCsrf(input: {
    readonly key: string;
    readonly sessionId: string;
    readonly sessionSecret: OpaqueAuthoritySecret;
  }): Promise<CsrfToken> {
    this.calls += 1;
    return parseCsrfToken(
      `csrf_${deterministicHex(`${input.key}\u0000${input.sessionId}\u0000${input.sessionSecret}`)}`
    );
  }

  async secureEqual(left: string, right: string): Promise<boolean> {
    this.calls += 1;
    return left === right;
  }
}

class FakeDrainProof implements PairingDrainProofPort {
  calls = 0;
  unavailable = false;
  readonly queuedStatuses: Array<'drained' | 'residual' | 'unavailable'> = [];

  async confirmDrained() {
    this.calls += 1;
    const status = this.queuedStatuses.shift() ?? (this.unavailable ? 'unavailable' : 'drained');
    return status === 'drained'
      ? ({ status, evidenceRef: `drain-evidence-${this.calls}` } as const)
      : ({ status } as const);
  }
}

export interface AuthorityFixture {
  readonly authority: HostedAccessAuthority;
  readonly repository: FakeAuthorityRepository;
  readonly keyrings: FakeKeyrings;
  readonly delivery: FakeChallengeDelivery;
  readonly random: FakeRandom;
  readonly crypto: FakeCrypto;
  readonly drain: FakeDrainProof;
  readonly clock: { now(): number };
  setNow(now: number): void;
  state(): HostedAccessAuthorityState;
  effectCount(): number;
}

export function createAuthorityFixture(
  options: {
    readonly policy?: Partial<HostedAccessAuthorityPolicy>;
    readonly repository?: FakeAuthorityRepository;
    readonly keyrings?: FakeKeyrings;
    readonly delivery?: FakeChallengeDelivery;
    readonly now?: number;
  } = {}
): AuthorityFixture {
  let now = options.now ?? 1_000;
  const repository = options.repository ?? new FakeAuthorityRepository();
  const keyrings = options.keyrings ?? new FakeKeyrings();
  const delivery = options.delivery ?? new FakeChallengeDelivery();
  const random = new FakeRandom();
  const crypto = new FakeCrypto();
  const drain = new FakeDrainProof();
  const clock = { now: () => now };
  const dependencies: HostedAccessAuthorityDependencies = {
    clock,
    random,
    crypto,
    repository,
    keyrings,
    challengeDelivery: delivery,
    drainProof: drain,
    policy: Object.freeze({ ...DEFAULT_POLICY, ...options.policy }),
  };
  const authority = new HostedAccessAuthority(dependencies);
  return {
    authority,
    repository,
    keyrings,
    delivery,
    random,
    crypto,
    drain,
    clock,
    setNow(value) {
      now = value;
    },
    state() {
      if (repository.state === null) throw new Error('fixture state missing');
      return repository.state;
    },
    effectCount() {
      return (
        repository.loads +
        repository.initializes +
        repository.swaps +
        keyrings.loads +
        keyrings.stageCalls +
        keyrings.activateCalls +
        delivery.statusCalls +
        delivery.publishCalls +
        delivery.removeCalls +
        random.calls +
        crypto.calls +
        drain.calls
      );
    },
  };
}

export async function pairFixture(fixture: AuthorityFixture) {
  const initialized = await fixture.authority.initialize(BINDING);
  if (!initialized.ok) throw new Error(`fixture init failed: ${initialized.code}`);
  const issued = await fixture.authority.issueInitialChallenge(BINDING);
  if (!issued.ok) throw new Error(`fixture issue failed: ${issued.code}`);
  const pairingSecret = fixture.delivery.secret(issued.value.challengeId);
  const paired = await fixture.authority.pair(BINDING, pairingSecret);
  if (!paired.ok) throw new Error(`fixture pair failed: ${paired.code}`);
  return {
    ...paired.value,
    pairingSecret,
    challengeId: issued.value.challengeId,
  };
}

function deterministicHex(value: string): string {
  let result = '';
  for (let block = 0; block < 8; block += 1) {
    let hash = (0x811c9dc5 ^ block) >>> 0;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    result += hash.toString(16).padStart(8, '0');
  }
  return result;
}
