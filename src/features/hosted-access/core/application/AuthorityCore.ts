import {
  type AuthKeyringId,
  type AuthorityBinding,
  type HostedAccessAuthorityPolicy,
  type HostedAccessRejectionCode,
  parseAuthKeyringId,
  parseAuthorityKeyMaterial,
  parseOpaqueAuthoritySecret,
} from '../../contracts';
import {
  assertAuthorityBinding,
  assertHostedAccessAuthorityPolicy,
  type HostedAccessAuthorityState,
  isRecoverableAuthorityState,
  nextAuthorityState,
} from '../domain';

import type {
  AuthKeyringEnvelope,
  AuthKeyringPort,
  AuthoritySecretDerivationPurpose,
  HostedAccessAuthorityRepositoryPort,
  HostedAccessClockPort,
  HostedAccessCryptoPort,
  HostedAccessRandomPort,
  PairingChallengeDeliveryPort,
  PairingDrainProofPort,
} from './ports';

export interface HostedAccessAuthorityDependencies {
  readonly clock: HostedAccessClockPort;
  readonly random: HostedAccessRandomPort;
  readonly crypto: HostedAccessCryptoPort;
  readonly repository: HostedAccessAuthorityRepositoryPort;
  readonly keyrings: AuthKeyringPort;
  readonly challengeDelivery: PairingChallengeDeliveryPort;
  readonly drainProof: PairingDrainProofPort;
  readonly policy: HostedAccessAuthorityPolicy;
}

export type LoadedAuthority =
  | {
      readonly ok: true;
      readonly state: HostedAccessAuthorityState;
      readonly keyring: AuthKeyringEnvelope;
    }
  | { readonly ok: false; readonly code: HostedAccessRejectionCode };

export type LoadedState =
  | { readonly ok: true; readonly state: HostedAccessAuthorityState }
  | { readonly ok: false; readonly code: HostedAccessRejectionCode | 'authority_state_empty' };

export class AuthorityCore {
  readonly dependencies: HostedAccessAuthorityDependencies;

  constructor(dependencies: HostedAccessAuthorityDependencies) {
    assertHostedAccessAuthorityPolicy(dependencies.policy);
    this.dependencies = dependencies;
  }

  now(): number {
    const now = this.dependencies.clock.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError('hosted-access-clock-invalid');
    }
    return now;
  }

  async loadState(): Promise<LoadedState> {
    const result = await this.dependencies.repository.load();
    if (result.status !== 'available') {
      if (result.status === 'empty') {
        return {
          ok: false,
          code:
            result.rollbackFenceRevision === null
              ? 'authority_state_empty'
              : 'authority_state_corrupt',
        };
      }
      if (result.status === 'corrupt') {
        return { ok: false, code: 'authority_state_corrupt' };
      }
      return { ok: false, code: 'authority_store_unavailable' };
    }
    if (
      !Number.isSafeInteger(result.rollbackFenceRevision) ||
      result.rollbackFenceRevision < 0 ||
      result.rollbackFenceRevision !== result.state.revision ||
      !isRecoverableAuthorityState(result.state, this.dependencies.policy)
    ) {
      return { ok: false, code: 'authority_state_corrupt' };
    }
    return { ok: true, state: result.state };
  }

  async loadRegular(binding: AuthorityBinding): Promise<LoadedAuthority> {
    assertAuthorityBinding(binding);
    for (let attempt = 0; attempt < this.dependencies.policy.compareAndSwapAttempts; attempt += 1) {
      const loaded = await this.loadState();
      if (!loaded.ok) {
        return {
          ok: false,
          code: loaded.code === 'authority_state_empty' ? 'authority_state_corrupt' : loaded.code,
        };
      }
      if (loaded.state.resetIntent !== null) {
        return { ok: false, code: 'reset_in_progress' };
      }
      if (!bindingsEqual(loaded.state.binding, binding)) {
        return { ok: false, code: 'restore_binding_mismatch' };
      }
      const cleanup = await this.reconcileChallengeDeliveryCleanup(loaded.state);
      if (cleanup === 'conflict' || cleanup === 'committed') continue;
      if (cleanup === 'unavailable') {
        return { ok: false, code: 'challenge_delivery_unavailable' };
      }
      const keyring = await this.dependencies.keyrings.loadActive();
      if (keyring.status !== 'available') {
        return { ok: false, code: keyringReadCode(keyring.status) };
      }
      if (!isKeyringEnvelopeValid(keyring.envelope)) {
        return { ok: false, code: 'keyring_corrupt' };
      }
      if (!bindingsEqual(keyring.envelope.binding, binding)) {
        return { ok: false, code: 'restore_binding_mismatch' };
      }
      if (keyring.envelope.keyringId !== loaded.state.expectedKeyringId) {
        return { ok: false, code: 'keyring_mismatch' };
      }
      return { ok: true, state: loaded.state, keyring: keyring.envelope };
    }
    return { ok: false, code: 'authority_store_conflict' };
  }

  async createKeyring(
    binding: AuthorityBinding,
    reservedKeyringId?: AuthKeyringId
  ): Promise<AuthKeyringEnvelope> {
    assertAuthorityBinding(binding);
    const keyringId =
      reservedKeyringId ??
      parseAuthKeyringId(await this.dependencies.random.randomId('auth-keyring'));
    const hashKey = parseAuthorityKeyMaterial(
      await this.dependencies.random.randomSecret('hash-key', 32)
    );
    const csrfKey = parseAuthorityKeyMaterial(
      await this.dependencies.random.randomSecret('csrf-key', 32)
    );
    return Object.freeze({
      format: 'hosted-access-keyring/v1',
      keyringId,
      binding: Object.freeze({ ...binding }),
      createdAt: this.now(),
      hashKey,
      csrfKey,
    });
  }

  async randomAuthoritySecret(kind: 'device-grant' | 'pairing-challenge' | 'session') {
    return parseOpaqueAuthoritySecret(await this.dependencies.random.randomSecret(kind, 32));
  }

  async deriveAuthoritySecret(input: {
    readonly key: AuthKeyringEnvelope['hashKey'];
    readonly purpose: AuthoritySecretDerivationPurpose;
    readonly sourceSecret: import('../../contracts').OpaqueAuthoritySecret;
    readonly context: string;
  }) {
    return parseOpaqueAuthoritySecret(await this.dependencies.crypto.deriveSecret(input));
  }

  async commit(
    expected: HostedAccessAuthorityState,
    nextState: HostedAccessAuthorityState
  ): Promise<'committed' | 'conflict' | 'unavailable'> {
    if (nextState.revision !== expected.revision + 1) {
      throw new TypeError('hosted-access-revision-transition-invalid');
    }
    if (!isRecoverableAuthorityState(nextState, this.dependencies.policy)) {
      throw new TypeError('hosted-access-state-transition-invalid');
    }
    const result = await this.dependencies.repository.compareAndSwap({
      expectedRevision: expected.revision,
      expectedRollbackFenceRevision: expected.revision,
      nextState,
      nextRollbackFenceRevision: nextState.revision,
    });
    return result.status;
  }

  async reconcileChallengeDeliveryCleanup(
    state: HostedAccessAuthorityState
  ): Promise<'clean' | 'committed' | 'conflict' | 'unavailable'> {
    const pending = state.pairingChallenges.filter(
      ({ deliveryCleanupPending }) => deliveryCleanupPending
    );
    if (pending.length === 0) return 'clean';
    for (const challenge of pending) {
      const removed = await this.dependencies.challengeDelivery.remove(challenge.challengeId);
      if (removed.status === 'unavailable' || removed.status === 'conflict') {
        const observed = await this.dependencies.challengeDelivery.status(challenge.challengeId);
        if (observed.status !== 'missing') return 'unavailable';
      }
    }
    const next = nextAuthorityState(state, {
      pairingChallenges: state.pairingChallenges.map((challenge) =>
        challenge.deliveryCleanupPending
          ? Object.freeze({ ...challenge, deliveryCleanupPending: false })
          : challenge
      ),
    });
    const committed = await this.commit(state, next);
    if (committed !== 'unavailable') return committed;
    const recovered = await this.loadState();
    if (!recovered.ok) return 'unavailable';
    const pendingIds = new Set(pending.map(({ challengeId }) => challengeId));
    return recovered.state.pairingChallenges.some(
      ({ challengeId, deliveryCleanupPending }) =>
        pendingIds.has(challengeId) && deliveryCleanupPending
    )
      ? 'unavailable'
      : 'committed';
  }
}

export function bindingsEqual(left: AuthorityBinding, right: AuthorityBinding): boolean {
  return (
    left.deploymentId === right.deploymentId && left.restoreGeneration === right.restoreGeneration
  );
}

export function isKeyringEnvelopeValid(value: unknown): value is AuthKeyringEnvelope {
  try {
    if (
      !isExactRecord(value, [
        'format',
        'keyringId',
        'binding',
        'createdAt',
        'hashKey',
        'csrfKey',
      ]) ||
      !isExactRecord(value.binding, ['deploymentId', 'restoreGeneration'])
    ) {
      return false;
    }
    const envelope = value as unknown as AuthKeyringEnvelope;
    if (envelope.format !== 'hosted-access-keyring/v1') return false;
    parseAuthKeyringId(envelope.keyringId);
    assertAuthorityBinding(envelope.binding);
    parseAuthorityKeyMaterial(envelope.hashKey);
    parseAuthorityKeyMaterial(envelope.csrfKey);
    return Number.isSafeInteger(envelope.createdAt) && envelope.createdAt >= 0;
  } catch {
    return false;
  }
}

function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[]
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actualKeys = Reflect.ownKeys(value);
  if (actualKeys.length !== expectedKeys.length) return false;
  const expected = new Set(expectedKeys);
  return actualKeys.every((key) => typeof key === 'string' && expected.has(key));
}

export function keyringReadCode(
  status: 'missing' | 'corrupt' | 'unavailable'
): 'keyring_missing' | 'keyring_corrupt' | 'keyring_unavailable' {
  if (status === 'missing') return 'keyring_missing';
  if (status === 'corrupt') return 'keyring_corrupt';
  return 'keyring_unavailable';
}

export async function findHashMatch<T extends { readonly secretHash: string }>(
  crypto: HostedAccessCryptoPort,
  candidates: readonly T[],
  presentedHash: string
): Promise<T | null> {
  let match: T | null = null;
  for (const candidate of candidates) {
    if (await crypto.secureEqual(candidate.secretHash, presentedHash)) {
      match = candidate;
    }
  }
  return match;
}
