import {
  type AuthorityBinding,
  type HostedAccessResult,
  type OpaqueAuthoritySecret,
  type PairingChallengeId,
  type PairingCredentials,
  parseDeviceFamilyId,
  parseDeviceGrantId,
  parseOperatorId,
  parseOperatorSessionId,
  parsePairingChallengeId,
} from '../../contracts';
import {
  addDuration,
  assertAuthorityBinding,
  createInitialAuthorityState,
  extendIdleDeadline,
  type HostedAccessAuthorityState,
  nextAuthorityState,
  type OperatorDeviceFamily,
  type OperatorDeviceGrant,
  type OperatorSession,
  type PairingChallenge,
} from '../domain';

import {
  AuthorityCore,
  bindingsEqual,
  findHashMatch,
  isKeyringEnvelopeValid,
  keyringReadCode,
} from './AuthorityCore';
import { accepted, rejected } from './results';

import type { PersonalOwnerPreparationPort } from './ports';

interface ChallengeReference {
  readonly challengeId: PairingChallengeId;
}

export class PairingAuthority {
  constructor(private readonly core: AuthorityCore) {}

  async initialize(
    binding: AuthorityBinding
  ): Promise<
    HostedAccessResult<
      { readonly resetPending: boolean },
      'authority_ready' | 'authority_reset_pending'
    >
  > {
    assertAuthorityBinding(binding);
    for (
      let attempt = 0;
      attempt < this.core.dependencies.policy.compareAndSwapAttempts;
      attempt += 1
    ) {
      const loaded = await this.core.loadState();
      if (loaded.ok) {
        if (loaded.state.resetIntent !== null) {
          if (!bindingsEqual(loaded.state.resetIntent.requestedBinding, binding)) {
            return rejected('restore_binding_mismatch');
          }
          const cleanup = await this.core.reconcileChallengeDeliveryCleanup(loaded.state);
          if (cleanup === 'conflict' || cleanup === 'committed') continue;
          if (cleanup === 'unavailable') {
            return rejected('challenge_delivery_unavailable');
          }
          return accepted('authority_reset_pending', { resetPending: true });
        }
        if (!bindingsEqual(loaded.state.binding, binding)) {
          return rejected('restore_binding_mismatch');
        }
        const regular = await this.core.loadRegular(binding);
        if (!regular.ok) return regular;
        return accepted('authority_ready', { resetPending: false });
      }
      if (loaded.code !== 'authority_state_empty') return rejected(loaded.code);

      let activeKeyring = await this.core.dependencies.keyrings.loadActive();
      if (activeKeyring.status === 'missing') {
        const envelope = await this.core.createKeyring(binding);
        const created = await this.core.dependencies.keyrings.createInitial(envelope);
        if (created.status === 'unavailable') {
          activeKeyring = await this.core.dependencies.keyrings.loadActive();
          if (activeKeyring.status === 'missing') {
            return rejected('keyring_unavailable');
          }
        } else if (created.status === 'conflict') {
          activeKeyring = await this.core.dependencies.keyrings.loadActive();
        } else {
          activeKeyring = { status: 'available', envelope };
        }
      }
      if (activeKeyring.status !== 'available') {
        return rejected(keyringReadCode(activeKeyring.status));
      }
      if (!isKeyringEnvelopeValid(activeKeyring.envelope)) {
        return rejected('keyring_corrupt');
      }
      if (!bindingsEqual(activeKeyring.envelope.binding, binding)) {
        return rejected('restore_binding_mismatch');
      }
      const initial = createInitialAuthorityState({
        binding,
        keyringId: activeKeyring.envelope.keyringId,
      });
      const initialized = await this.core.dependencies.repository.initialize(initial);
      if (initialized.status === 'unavailable') {
        const recovered = await this.core.loadState();
        if (!recovered.ok) return rejected('authority_store_unavailable');
        continue;
      }
      if (initialized.status === 'conflict') continue;
      return accepted('authority_ready', { resetPending: false });
    }
    return rejected('authority_store_conflict');
  }

  async issueInitialChallenge(
    binding: AuthorityBinding
  ): Promise<
    HostedAccessResult<ChallengeReference, 'challenge_issued' | 'challenge_already_issued'>
  > {
    assertAuthorityBinding(binding);
    const { compareAndSwapAttempts } = this.core.dependencies.policy;
    for (let attempt = 0; attempt < compareAndSwapAttempts; attempt += 1) {
      const loaded = await this.core.loadRegular(binding);
      if (!loaded.ok) return loaded;
      const state = loaded.state;
      if (state.deviceFamilies.some(({ status }) => status === 'active')) {
        return rejected('pairing_already_established');
      }
      const existing = newestOpenChallenge(state);
      if (existing !== null) {
        const recovered = await this.recoverExistingChallenge(binding, state, existing);
        if (recovered === 'retry') continue;
        return recovered;
      }
      const drain = await this.core.dependencies.drainProof.confirmDrained({
        binding,
        purpose: 'initial_pairing',
        resetGeneration: state.consumedResetGeneration,
      });
      if (drain.status !== 'drained') return rejected('pairing_drain_unconfirmed');

      const challengeId = parsePairingChallengeId(
        await this.core.dependencies.random.randomId('pairing-challenge')
      );
      const secret = await this.core.randomAuthoritySecret('pairing-challenge');
      const secretHash = await this.core.dependencies.crypto.keyedHash({
        key: loaded.keyring.hashKey,
        purpose: 'pairing-challenge',
        secret,
      });
      const now = this.core.now();
      const challenge: PairingChallenge = Object.freeze({
        challengeId,
        secretHash,
        keyringId: loaded.keyring.keyringId,
        resetGeneration: state.consumedResetGeneration,
        issuedAt: now,
        expiresAt: addDuration(now, this.core.dependencies.policy.pairingChallengeTtlMs),
        failedAttempts: 0,
        maxAttempts: this.core.dependencies.policy.pairingMaxAttempts,
        status: 'pending_delivery',
        consumedAt: null,
        revokedAt: null,
        revocationReason: null,
        pairedDeviceFamilyId: null,
        pairedDeviceGrantId: null,
        pairedSessionId: null,
        deliveryCleanupPending: false,
      });
      const next = nextAuthorityState(state, {
        pairingChallenges: [...state.pairingChallenges, challenge],
      });
      const committed = await this.core.commit(state, next);
      if (committed === 'conflict') continue;
      if (committed === 'unavailable') return rejected('authority_store_unavailable');
      const published = await this.core.dependencies.challengeDelivery.publish({
        challengeId,
        secret,
        expiresAt: challenge.expiresAt,
      });
      if (published.status === 'unavailable' || published.status === 'conflict') {
        return rejected('challenge_delivery_unavailable');
      }
      return await this.markChallengeIssued(binding, challengeId);
    }
    return rejected('authority_store_conflict');
  }

  async pair(
    binding: AuthorityBinding,
    presentedSecret: OpaqueAuthoritySecret,
    ownerPreparation?: PersonalOwnerPreparationPort
  ): Promise<HostedAccessResult<PairingCredentials, 'paired'>> {
    assertAuthorityBinding(binding);
    const { compareAndSwapAttempts, policy } = {
      compareAndSwapAttempts: this.core.dependencies.policy.compareAndSwapAttempts,
      policy: this.core.dependencies.policy,
    };
    for (let attempt = 0; attempt < compareAndSwapAttempts; attempt += 1) {
      const loaded = await this.core.loadRegular(binding);
      if (!loaded.ok) return loaded;
      const state = loaded.state;
      const presentedHash = await this.core.dependencies.crypto.keyedHash({
        key: loaded.keyring.hashKey,
        purpose: 'pairing-challenge',
        secret: presentedSecret,
      });
      if (state.deviceFamilies.some(({ status }) => status === 'active')) {
        return rejected('pairing_already_established');
      }
      const challenge = await findHashMatch(
        this.core.dependencies.crypto,
        state.pairingChallenges,
        presentedHash
      );
      if (challenge === null || challenge.status !== 'issued') {
        const failed = await this.recordFailedPairingAttempt(state);
        if (failed === 'conflict') continue;
        if (failed === 'unavailable') return rejected('authority_store_unavailable');
        if (failed === 'exhausted' || failed === 'expired') {
          const reconciled = await this.core.loadRegular(binding);
          if (!reconciled.ok) return reconciled;
        }
        if (failed === 'expired') return rejected('challenge_expired');
        return rejected(
          failed === 'exhausted' ? 'challenge_attempts_exhausted' : 'challenge_invalid'
        );
      }
      const now = this.core.now();
      if (now >= challenge.expiresAt) {
        const expired = revokeChallenge(challenge, now, 'expired', true);
        const next = replaceChallenge(state, expired);
        const committed = await this.core.commit(state, next);
        if (committed === 'conflict') continue;
        if (committed === 'unavailable') return rejected('authority_store_unavailable');
        const reconciled = await this.core.loadRegular(binding);
        return reconciled.ok ? rejected('challenge_expired') : rejected(reconciled.code);
      }

      const proposedOperatorId =
        state.operatorId ??
        parseOperatorId(await this.core.dependencies.random.randomId('operator'));
      const operatorId =
        ownerPreparation === undefined
          ? proposedOperatorId
          : await ownerPreparation.prepare(proposedOperatorId);
      const familyId = parseDeviceFamilyId(
        await this.core.dependencies.random.randomId('device-family')
      );
      const grantId = parseDeviceGrantId(
        await this.core.dependencies.random.randomId('device-grant')
      );
      const sessionId = parseOperatorSessionId(
        await this.core.dependencies.random.randomId('session')
      );
      const deviceSecret = await this.core.deriveAuthoritySecret({
        key: loaded.keyring.hashKey,
        purpose: 'pairing-device-grant',
        sourceSecret: presentedSecret,
        context: `${challenge.challengeId}:${grantId}`,
      });
      const sessionSecret = await this.core.deriveAuthoritySecret({
        key: loaded.keyring.hashKey,
        purpose: 'pairing-session',
        sourceSecret: presentedSecret,
        context: `${challenge.challengeId}:${sessionId}`,
      });
      const deviceHash = await this.core.dependencies.crypto.keyedHash({
        key: loaded.keyring.hashKey,
        purpose: 'device-grant',
        secret: deviceSecret,
      });
      const sessionHash = await this.core.dependencies.crypto.keyedHash({
        key: loaded.keyring.hashKey,
        purpose: 'operator-session',
        secret: sessionSecret,
      });
      const csrfToken = await this.core.dependencies.crypto.deriveCsrf({
        key: loaded.keyring.csrfKey,
        sessionId,
        sessionSecret,
      });
      const family: OperatorDeviceFamily = Object.freeze({
        familyId,
        operatorId,
        issuedAt: now,
        lastUsedAt: now,
        idleExpiresAt: addDuration(now, policy.deviceIdleTtlMs),
        absoluteExpiresAt: addDuration(now, policy.deviceAbsoluteTtlMs),
        currentGeneration: 1,
        status: 'active',
        revokedAt: null,
        revocationReason: null,
      });
      const grant: OperatorDeviceGrant = Object.freeze({
        grantId,
        familyId,
        generation: 1,
        renewedFromGrantId: null,
        secretHash: deviceHash,
        keyringId: loaded.keyring.keyringId,
        issuedAt: now,
        renewalExpiresAt: addDuration(now, policy.deviceRenewalTtlMs),
        status: 'current',
        predecessorGraceExpiresAt: null,
        predecessorUsesRemaining: 0,
        retiredAt: null,
        revokedAt: null,
        revocationReason: null,
      });
      const session = createSession({
        sessionId,
        operatorId,
        familyId,
        deviceGeneration: 1,
        secretHash: sessionHash,
        keyringId: loaded.keyring.keyringId,
        now,
        familyAbsoluteExpiresAt: family.absoluteExpiresAt,
        policy,
      });
      const removed = await this.core.dependencies.challengeDelivery.remove(challenge.challengeId);
      if (removed.status === 'unavailable' || removed.status === 'conflict') {
        const observed = await this.core.dependencies.challengeDelivery.status(
          challenge.challengeId
        );
        if (observed.status !== 'missing') {
          return rejected('challenge_delivery_unavailable');
        }
      }
      const consumed: PairingChallenge = Object.freeze({
        ...challenge,
        status: 'consumed',
        consumedAt: now,
        pairedDeviceFamilyId: familyId,
        pairedDeviceGrantId: grantId,
        pairedSessionId: sessionId,
        deliveryCleanupPending: false,
      });
      const next = nextAuthorityState(state, {
        operatorId,
        pairingChallenges: state.pairingChallenges.map((item) =>
          item.challengeId === challenge.challengeId ? consumed : item
        ),
        deviceFamilies: [...state.deviceFamilies, family],
        deviceGrants: [...state.deviceGrants, grant],
        sessions: [...state.sessions, session],
      });
      const committed = await this.core.commit(state, next);
      if (committed === 'conflict') continue;
      if (committed === 'unavailable') {
        const recovered = await this.core.loadState();
        if (
          !recovered.ok ||
          !recovered.state.sessions.some(({ sessionId: id }) => id === sessionId)
        ) {
          return rejected('authority_store_unavailable');
        }
      }
      return accepted('paired', {
        operatorId,
        deviceFamilyId: familyId,
        deviceGeneration: 1,
        deviceSecret,
        sessionId,
        sessionSecret,
        csrfToken,
      });
    }
    return rejected('authority_store_conflict');
  }

  private async recoverExistingChallenge(
    binding: AuthorityBinding,
    state: HostedAccessAuthorityState,
    challenge: PairingChallenge
  ): Promise<
    | HostedAccessResult<ChallengeReference, 'challenge_issued' | 'challenge_already_issued'>
    | 'retry'
  > {
    const now = this.core.now();
    if (now >= challenge.expiresAt) {
      const next = replaceChallenge(state, revokeChallenge(challenge, now, 'expired', true));
      const committed = await this.core.commit(state, next);
      if (committed === 'conflict') return 'retry';
      if (committed === 'unavailable') return rejected('authority_store_unavailable');
      return 'retry';
    }
    const delivery = await this.core.dependencies.challengeDelivery.status(challenge.challengeId);
    if (delivery.status === 'unavailable') {
      return rejected('challenge_delivery_unavailable');
    }
    if (delivery.status === 'missing') {
      const revoked = revokeChallenge(
        challenge,
        now,
        challenge.status === 'pending_delivery'
          ? 'publish_not_observed'
          : 'issued_delivery_missing',
        false
      );
      const committed = await this.core.commit(state, replaceChallenge(state, revoked));
      if (committed === 'conflict') return 'retry';
      if (committed === 'unavailable') return rejected('authority_store_unavailable');
      return 'retry';
    }
    if (challenge.status === 'issued') {
      return accepted('challenge_already_issued', {
        challengeId: challenge.challengeId,
      });
    }
    return await this.markChallengeIssued(binding, challenge.challengeId);
  }

  private async markChallengeIssued(
    binding: AuthorityBinding,
    challengeId: PairingChallengeId
  ): Promise<HostedAccessResult<ChallengeReference, 'challenge_issued'>> {
    for (
      let attempt = 0;
      attempt < this.core.dependencies.policy.compareAndSwapAttempts;
      attempt += 1
    ) {
      const loaded = await this.core.loadRegular(binding);
      if (!loaded.ok) return loaded;
      const challenge = loaded.state.pairingChallenges.find(
        (item) => item.challengeId === challengeId
      );
      if (challenge?.status === 'issued') {
        return accepted('challenge_issued', { challengeId });
      }
      if (challenge?.status !== 'pending_delivery') {
        return rejected('challenge_invalid');
      }
      const issued: PairingChallenge = Object.freeze({
        ...challenge,
        status: 'issued',
      });
      const next = replaceChallenge(loaded.state, issued);
      const committed = await this.core.commit(loaded.state, next);
      if (committed === 'conflict') continue;
      if (committed === 'unavailable') return rejected('authority_store_unavailable');
      return accepted('challenge_issued', { challengeId });
    }
    return rejected('authority_store_conflict');
  }

  private async recordFailedPairingAttempt(
    state: HostedAccessAuthorityState
  ): Promise<'recorded' | 'expired' | 'exhausted' | 'conflict' | 'unavailable'> {
    const challenge = newestOpenChallenge(state);
    if (challenge?.status !== 'issued') return 'recorded';
    const now = this.core.now();
    if (now >= challenge.expiresAt) {
      const committed = await this.core.commit(
        state,
        replaceChallenge(state, revokeChallenge(challenge, now, 'expired', true))
      );
      return committed === 'committed' ? 'expired' : committed;
    }
    const failedAttempts = challenge.failedAttempts + 1;
    const exhausted = failedAttempts >= challenge.maxAttempts;
    const updated: PairingChallenge = Object.freeze({
      ...challenge,
      failedAttempts,
      status: exhausted ? 'revoked' : challenge.status,
      revokedAt: exhausted ? now : challenge.revokedAt,
      revocationReason: exhausted ? 'attempts_exhausted' : challenge.revocationReason,
      deliveryCleanupPending: exhausted,
    });
    const committed = await this.core.commit(state, replaceChallenge(state, updated));
    if (committed !== 'committed') return committed;
    if (exhausted) {
      return 'exhausted';
    }
    return 'recorded';
  }
}

function newestOpenChallenge(state: HostedAccessAuthorityState): PairingChallenge | null {
  return (
    [...state.pairingChallenges]
      .reverse()
      .find(({ status }) => status === 'pending_delivery' || status === 'issued') ?? null
  );
}

function replaceChallenge(
  state: HostedAccessAuthorityState,
  challenge: PairingChallenge
): HostedAccessAuthorityState {
  return nextAuthorityState(state, {
    pairingChallenges: state.pairingChallenges.map((item) =>
      item.challengeId === challenge.challengeId ? challenge : item
    ),
  });
}

function revokeChallenge(
  challenge: PairingChallenge,
  now: number,
  reason: string,
  deliveryCleanupPending: boolean
): PairingChallenge {
  return Object.freeze({
    ...challenge,
    status: 'revoked',
    revokedAt: now,
    revocationReason: reason,
    deliveryCleanupPending,
  });
}

export function createSession(input: {
  readonly sessionId: OperatorSession['sessionId'];
  readonly operatorId: OperatorSession['operatorId'];
  readonly familyId: OperatorSession['familyId'];
  readonly deviceGeneration: number;
  readonly secretHash: OperatorSession['secretHash'];
  readonly keyringId: OperatorSession['keyringId'];
  readonly now: number;
  readonly familyAbsoluteExpiresAt: number;
  readonly policy: import('../../contracts').HostedAccessAuthorityPolicy;
}): OperatorSession {
  return Object.freeze({
    sessionId: input.sessionId,
    operatorId: input.operatorId,
    familyId: input.familyId,
    deviceGeneration: input.deviceGeneration,
    secretHash: input.secretHash,
    keyringId: input.keyringId,
    issuedAt: input.now,
    lastUsedAt: input.now,
    deadlines: Object.freeze({
      idleExpiresAt: extendIdleDeadline(
        input.now,
        input.policy.sessionIdleTtlMs,
        Math.min(
          addDuration(input.now, input.policy.sessionAbsoluteTtlMs),
          input.familyAbsoluteExpiresAt
        )
      ),
      absoluteExpiresAt: Math.min(
        addDuration(input.now, input.policy.sessionAbsoluteTtlMs),
        input.familyAbsoluteExpiresAt
      ),
      renewalExpiresAt: Math.min(
        addDuration(input.now, input.policy.sessionRenewalTtlMs),
        input.familyAbsoluteExpiresAt
      ),
    }),
    status: 'active',
    revokedAt: null,
    revocationReason: null,
  });
}
