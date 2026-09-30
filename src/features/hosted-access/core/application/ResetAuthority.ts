import {
  type AuthorityBinding,
  type HostedAccessRejectionCode,
  type HostedAccessResult,
  type PairingChallengeId,
  parseAuthKeyringId,
  parsePairingChallengeId,
} from '../../contracts';
import {
  addDuration,
  assertAuthorityBinding,
  type AuthResetIntent,
  type HostedAccessAuthorityState,
  nextAuthorityState,
  type PairingChallenge,
} from '../domain';

import {
  AuthorityCore,
  bindingsEqual,
  isKeyringEnvelopeValid,
  keyringReadCode,
} from './AuthorityCore';
import { accepted, rejected } from './results';

interface ResetCompletion {
  readonly resetGeneration: number;
  readonly challengeId: PairingChallengeId;
}

export class ResetAuthority {
  constructor(private readonly core: AuthorityCore) {}

  async consumeResetGeneration(
    binding: AuthorityBinding,
    resetGeneration: number
  ): Promise<HostedAccessResult<ResetCompletion, 'reset_completed'>> {
    assertAuthorityBinding(binding);
    if (!Number.isSafeInteger(resetGeneration) || resetGeneration <= 0) {
      return rejected('reset_generation_not_newer');
    }
    const maxSteps = this.core.dependencies.policy.compareAndSwapAttempts * 4;
    for (let step = 0; step < maxSteps; step += 1) {
      const loaded = await this.core.loadState();
      if (!loaded.ok) {
        return rejected(
          loaded.code === 'authority_state_empty' ? 'authority_state_corrupt' : loaded.code
        );
      }
      const state = loaded.state;
      const intent = state.resetIntent;
      if (intent === null) {
        if (resetGeneration < state.consumedResetGeneration) {
          return rejected('reset_generation_not_newer');
        }
        if (resetGeneration === state.consumedResetGeneration) {
          const recovered = await this.recoverCompletedReset(state, binding);
          if (recovered === 'retry') continue;
          return recovered;
        }
        const requested: AuthResetIntent = Object.freeze({
          resetGeneration,
          requestedBinding: Object.freeze({ ...binding }),
          requestedAt: this.core.now(),
          stage: 'requested',
          drainEvidenceRef: null,
          stagedKeyringId: null,
          challengeId: null,
        });
        const committed = await this.core.commit(
          state,
          nextAuthorityState(state, { resetIntent: requested })
        );
        if (committed === 'conflict') continue;
        if (committed === 'unavailable') return rejected('authority_store_unavailable');
        continue;
      }
      if (intent.resetGeneration !== resetGeneration) {
        return rejected('reset_in_progress');
      }
      if (!bindingsEqual(intent.requestedBinding, binding)) {
        return rejected('restore_binding_mismatch');
      }

      const transition = await this.advanceReset(state, intent);
      if (transition === 'retry') continue;
      if (!transition.ok) return transition;
      if (transition.code === 'reset_completed') return transition;
    }
    return rejected('authority_store_conflict');
  }

  private async advanceReset(
    state: HostedAccessAuthorityState,
    intent: AuthResetIntent
  ): Promise<HostedAccessResult<ResetCompletion, 'reset_completed'> | 'retry'> {
    switch (intent.stage) {
      case 'requested':
        return await this.confirmDrain(state, intent);
      case 'drain_confirmed':
        return await this.reserveKeyringStage(state, intent);
      case 'key_stage_reserved':
        return await this.stageKeyring(state, intent);
      case 'new_key_staged':
        return await this.revokeOldAuthority(state, intent);
      case 'authority_revoked':
        return await this.activateKeyring(state, intent);
      case 'key_activated':
      case 'delivery_recovery':
        return await this.createResetChallenge(state, intent);
      case 'challenge_pending':
        return await this.recoverPendingChallenge(state, intent);
      case 'challenge_issued':
        return await this.completeReset(state, intent);
    }
  }

  private async reserveKeyringStage(
    state: HostedAccessAuthorityState,
    intent: AuthResetIntent
  ): Promise<HostedAccessResult<never, never> | 'retry'> {
    const stagedKeyringId = parseAuthKeyringId(
      await this.core.dependencies.random.randomId('auth-keyring')
    );
    return await this.commitForRetry(
      state,
      Object.freeze({
        ...intent,
        stage: 'key_stage_reserved',
        stagedKeyringId,
      })
    );
  }

  private async confirmDrain(
    state: HostedAccessAuthorityState,
    intent: AuthResetIntent
  ): Promise<HostedAccessResult<never, never> | 'retry'> {
    const drain = await this.core.dependencies.drainProof.confirmDrained({
      binding: intent.requestedBinding,
      purpose: 'host_reset',
      resetGeneration: intent.resetGeneration,
    });
    if (drain.status !== 'drained') return rejected('pairing_drain_unconfirmed');
    if (drain.evidenceRef.length === 0 || drain.evidenceRef.length > 256) {
      return rejected('pairing_drain_unconfirmed');
    }
    const nextIntent: AuthResetIntent = Object.freeze({
      ...intent,
      stage: 'drain_confirmed',
      drainEvidenceRef: drain.evidenceRef,
    });
    return await this.commitForRetry(state, nextIntent);
  }

  private async stageKeyring(
    state: HostedAccessAuthorityState,
    intent: AuthResetIntent
  ): Promise<HostedAccessResult<never, never> | 'retry'> {
    if (intent.stagedKeyringId === null) {
      return rejected('authority_state_corrupt');
    }
    const existing = await this.core.dependencies.keyrings.loadStaged(intent.stagedKeyringId);
    if (existing.status === 'available') {
      if (!this.isExpectedStagedKeyring(existing.envelope, intent)) {
        return rejected('reset_stage_unavailable');
      }
      return await this.commitForRetry(
        state,
        Object.freeze({ ...intent, stage: 'new_key_staged' })
      );
    }
    if (existing.status !== 'missing') {
      return rejected('reset_stage_unavailable');
    }
    const envelope = await this.core.createKeyring(intent.requestedBinding, intent.stagedKeyringId);
    const staged = await this.core.dependencies.keyrings.stageReplacement(envelope);
    if (staged.status === 'unavailable' || staged.status === 'conflict') {
      const recovered = await this.core.dependencies.keyrings.loadStaged(intent.stagedKeyringId);
      if (
        recovered.status !== 'available' ||
        !this.isExpectedStagedKeyring(recovered.envelope, intent)
      ) {
        return rejected('reset_stage_unavailable');
      }
    }
    const nextIntent: AuthResetIntent = Object.freeze({
      ...intent,
      stage: 'new_key_staged',
    });
    return await this.commitForRetry(state, nextIntent);
  }

  private async revokeOldAuthority(
    state: HostedAccessAuthorityState,
    intent: AuthResetIntent
  ): Promise<HostedAccessResult<never, never> | 'retry'> {
    if (intent.stagedKeyringId === null) return rejected('authority_state_corrupt');
    const staged = await this.core.dependencies.keyrings.loadStaged(intent.stagedKeyringId);
    if (
      staged.status !== 'available' ||
      !isKeyringEnvelopeValid(staged.envelope) ||
      staged.envelope.keyringId !== intent.stagedKeyringId ||
      !bindingsEqual(staged.envelope.binding, intent.requestedBinding)
    ) {
      return rejected('reset_stage_unavailable');
    }
    const now = this.core.now();
    const nextIntent: AuthResetIntent = Object.freeze({
      ...intent,
      stage: 'authority_revoked',
    });
    const next = nextAuthorityState(state, {
      binding: intent.requestedBinding,
      expectedKeyringId: intent.stagedKeyringId,
      consumedResetGeneration: intent.resetGeneration,
      pairingChallenges: state.pairingChallenges.map((challenge) =>
        challenge.status === 'consumed' || challenge.status === 'revoked'
          ? Object.freeze({
              ...challenge,
              deliveryCleanupPending: true,
            })
          : Object.freeze({
              ...challenge,
              status: 'revoked' as const,
              revokedAt: now,
              revocationReason: 'host_reset',
              deliveryCleanupPending: true,
            })
      ),
      deviceFamilies: state.deviceFamilies.map((family) =>
        Object.freeze({
          ...family,
          status: 'revoked' as const,
          revokedAt: family.revokedAt ?? now,
          revocationReason: family.revocationReason ?? 'host_reset',
        })
      ),
      deviceGrants: state.deviceGrants.map((grant) =>
        Object.freeze({
          ...grant,
          status: 'revoked' as const,
          predecessorGraceExpiresAt: null,
          predecessorUsesRemaining: 0,
          revokedAt: grant.revokedAt ?? now,
          revocationReason: grant.revocationReason ?? 'host_reset',
        })
      ),
      sessions: state.sessions.map((session) =>
        Object.freeze({
          ...session,
          status: 'revoked' as const,
          revokedAt: session.revokedAt ?? now,
          revocationReason: session.revocationReason ?? 'host_reset',
        })
      ),
      resetIntent: nextIntent,
    });
    const committed = await this.core.commit(state, next);
    if (committed === 'conflict') return 'retry';
    if (committed === 'unavailable') return rejected('authority_store_unavailable');
    return 'retry';
  }

  private async activateKeyring(
    state: HostedAccessAuthorityState,
    intent: AuthResetIntent
  ): Promise<HostedAccessResult<never, never> | 'retry'> {
    if (intent.stagedKeyringId === null) return rejected('authority_state_corrupt');
    const cleanup = await this.core.reconcileChallengeDeliveryCleanup(state);
    if (cleanup === 'conflict' || cleanup === 'committed') return 'retry';
    if (cleanup === 'unavailable') {
      return rejected('challenge_delivery_unavailable');
    }
    const activated = await this.core.dependencies.keyrings.activateStaged(intent.stagedKeyringId);
    if (activated.status === 'unavailable' || activated.status === 'conflict') {
      const recovered = await this.core.dependencies.keyrings.loadActive();
      if (
        recovered.status !== 'available' ||
        !this.isExpectedStagedKeyring(recovered.envelope, intent)
      ) {
        return rejected('reset_stage_unavailable');
      }
    }
    const active = await this.core.dependencies.keyrings.loadActive();
    if (
      active.status !== 'available' ||
      !isKeyringEnvelopeValid(active.envelope) ||
      active.envelope.keyringId !== intent.stagedKeyringId ||
      !bindingsEqual(active.envelope.binding, intent.requestedBinding)
    ) {
      return rejected('reset_stage_unavailable');
    }
    return await this.commitForRetry(state, Object.freeze({ ...intent, stage: 'key_activated' }));
  }

  private async createResetChallenge(
    state: HostedAccessAuthorityState,
    intent: AuthResetIntent
  ): Promise<HostedAccessResult<never, never> | 'retry'> {
    const cleanup = await this.core.reconcileChallengeDeliveryCleanup(state);
    if (cleanup === 'conflict' || cleanup === 'committed') return 'retry';
    if (cleanup === 'unavailable') {
      return rejected('challenge_delivery_unavailable');
    }
    const drain = await this.core.dependencies.drainProof.confirmDrained({
      binding: intent.requestedBinding,
      purpose: 'host_reset',
      resetGeneration: intent.resetGeneration,
    });
    if (
      drain.status !== 'drained' ||
      drain.evidenceRef.length === 0 ||
      drain.evidenceRef.length > 256
    ) {
      return rejected('pairing_drain_unconfirmed');
    }
    const active = await this.core.dependencies.keyrings.loadActive();
    if (
      active.status !== 'available' ||
      !isKeyringEnvelopeValid(active.envelope) ||
      active.envelope.keyringId !== state.expectedKeyringId ||
      !bindingsEqual(active.envelope.binding, intent.requestedBinding)
    ) {
      return rejected('keyring_mismatch');
    }
    const challengeId = parsePairingChallengeId(
      await this.core.dependencies.random.randomId('pairing-challenge')
    );
    const secret = await this.core.randomAuthoritySecret('pairing-challenge');
    const secretHash = await this.core.dependencies.crypto.keyedHash({
      key: active.envelope.hashKey,
      purpose: 'pairing-challenge',
      secret,
    });
    const now = this.core.now();
    const challenge: PairingChallenge = Object.freeze({
      challengeId,
      secretHash,
      keyringId: active.envelope.keyringId,
      resetGeneration: intent.resetGeneration,
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
    const nextIntent: AuthResetIntent = Object.freeze({
      ...intent,
      stage: 'challenge_pending',
      drainEvidenceRef: drain.evidenceRef,
      challengeId,
    });
    const next = nextAuthorityState(state, {
      pairingChallenges: [...state.pairingChallenges, challenge],
      resetIntent: nextIntent,
    });
    const committed = await this.core.commit(state, next);
    if (committed === 'conflict') return 'retry';
    if (committed === 'unavailable') return rejected('authority_store_unavailable');
    const published = await this.core.dependencies.challengeDelivery.publish({
      challengeId,
      secret,
      expiresAt: challenge.expiresAt,
    });
    if (published.status === 'unavailable' || published.status === 'conflict') {
      return rejected('challenge_delivery_unavailable');
    }
    return 'retry';
  }

  private async recoverPendingChallenge(
    state: HostedAccessAuthorityState,
    intent: AuthResetIntent
  ): Promise<HostedAccessResult<never, never> | 'retry'> {
    if (intent.challengeId === null) return rejected('authority_state_corrupt');
    const challenge = state.pairingChallenges.find(
      ({ challengeId }) => challengeId === intent.challengeId
    );
    if (challenge?.status !== 'pending_delivery') {
      return rejected('authority_state_corrupt');
    }
    const now = this.core.now();
    if (now >= challenge.expiresAt) {
      return await this.returnToChallengeCreation(state, intent, challenge, now, 'expired', true);
    }
    const delivery = await this.core.dependencies.challengeDelivery.status(intent.challengeId);
    if (delivery.status === 'unavailable') {
      return rejected('challenge_delivery_unavailable');
    }
    if (delivery.status === 'missing') {
      return await this.returnToChallengeCreation(
        state,
        intent,
        challenge,
        now,
        'publish_not_observed',
        false
      );
    }
    const issued: PairingChallenge = Object.freeze({
      ...challenge,
      status: 'issued',
    });
    const nextIntent: AuthResetIntent = Object.freeze({
      ...intent,
      stage: 'challenge_issued',
    });
    const next = nextAuthorityState(state, {
      pairingChallenges: state.pairingChallenges.map((item) =>
        item.challengeId === issued.challengeId ? issued : item
      ),
      resetIntent: nextIntent,
    });
    const committed = await this.core.commit(state, next);
    if (committed === 'conflict') return 'retry';
    if (committed === 'unavailable') return rejected('authority_store_unavailable');
    return 'retry';
  }

  private async completeReset(
    state: HostedAccessAuthorityState,
    intent: AuthResetIntent
  ): Promise<HostedAccessResult<ResetCompletion, 'reset_completed'> | 'retry'> {
    if (intent.challengeId === null) return rejected('authority_state_corrupt');
    const keyringError = await this.activeKeyringError(state, intent.requestedBinding);
    if (keyringError !== null) return rejected(keyringError);
    const challenge = state.pairingChallenges.find(
      ({ challengeId }) => challengeId === intent.challengeId
    );
    if (challenge?.status !== 'issued') return rejected('authority_state_corrupt');
    const delivery = await this.core.dependencies.challengeDelivery.status(challenge.challengeId);
    if (delivery.status === 'unavailable') {
      return rejected('challenge_delivery_unavailable');
    }
    if (delivery.status === 'missing') {
      return await this.returnToChallengeCreation(
        state,
        intent,
        challenge,
        this.core.now(),
        'issued_delivery_missing',
        false
      );
    }
    const committed = await this.core.commit(
      state,
      nextAuthorityState(state, { resetIntent: null })
    );
    if (committed === 'conflict') return 'retry';
    if (committed === 'unavailable') return rejected('authority_store_unavailable');
    return accepted('reset_completed', {
      resetGeneration: intent.resetGeneration,
      challengeId: intent.challengeId,
    });
  }

  private async commitForRetry(
    state: HostedAccessAuthorityState,
    resetIntent: AuthResetIntent
  ): Promise<HostedAccessResult<never, never> | 'retry'> {
    const committed = await this.core.commit(state, nextAuthorityState(state, { resetIntent }));
    if (committed === 'unavailable') return rejected('authority_store_unavailable');
    return 'retry';
  }

  private isExpectedStagedKeyring(
    envelope: import('./ports').AuthKeyringEnvelope,
    intent: AuthResetIntent
  ): boolean {
    return (
      intent.stagedKeyringId !== null &&
      isKeyringEnvelopeValid(envelope) &&
      envelope.keyringId === intent.stagedKeyringId &&
      bindingsEqual(envelope.binding, intent.requestedBinding)
    );
  }

  private async returnToChallengeCreation(
    state: HostedAccessAuthorityState,
    intent: AuthResetIntent,
    challenge: PairingChallenge,
    now: number,
    reason: string,
    deliveryCleanupPending: boolean
  ): Promise<HostedAccessResult<never, never> | 'retry'> {
    const revoked: PairingChallenge = Object.freeze({
      ...challenge,
      status: 'revoked',
      consumedAt: null,
      revokedAt: now,
      revocationReason: reason,
      deliveryCleanupPending,
    });
    const resetIntent: AuthResetIntent = Object.freeze({
      ...intent,
      stage: 'key_activated',
      challengeId: null,
    });
    const committed = await this.core.commit(
      state,
      nextAuthorityState(state, {
        pairingChallenges: state.pairingChallenges.map((item) =>
          item.challengeId === challenge.challengeId ? revoked : item
        ),
        resetIntent,
      })
    );
    if (committed === 'unavailable') {
      return rejected('authority_store_unavailable');
    }
    return 'retry';
  }

  private async recoverCompletedReset(
    state: HostedAccessAuthorityState,
    binding: AuthorityBinding
  ): Promise<HostedAccessResult<ResetCompletion, 'reset_completed'> | 'retry'> {
    if (!bindingsEqual(state.binding, binding)) {
      return rejected('restore_binding_mismatch');
    }
    const keyringError = await this.activeKeyringError(state, binding);
    if (keyringError !== null) return rejected(keyringError);
    const challenge = [...state.pairingChallenges]
      .reverse()
      .find(
        (item) => item.resetGeneration === state.consumedResetGeneration && item.status === 'issued'
      );
    if (challenge !== undefined) {
      const delivery = await this.core.dependencies.challengeDelivery.status(challenge.challengeId);
      if (delivery.status === 'unavailable') {
        return rejected('challenge_delivery_unavailable');
      }
      if (delivery.status === 'present') {
        return accepted('reset_completed', {
          resetGeneration: state.consumedResetGeneration,
          challengeId: challenge.challengeId,
        });
      }
      const now = this.core.now();
      const revoked: PairingChallenge = Object.freeze({
        ...challenge,
        status: 'revoked',
        consumedAt: null,
        revokedAt: now,
        revocationReason: 'issued_delivery_missing',
        deliveryCleanupPending: false,
      });
      const recoveryIntent: AuthResetIntent = Object.freeze({
        resetGeneration: state.consumedResetGeneration,
        requestedBinding: Object.freeze({ ...binding }),
        requestedAt: now,
        stage: 'delivery_recovery',
        drainEvidenceRef: null,
        stagedKeyringId: state.expectedKeyringId,
        challengeId: null,
      });
      const committed = await this.core.commit(
        state,
        nextAuthorityState(state, {
          pairingChallenges: state.pairingChallenges.map((item) =>
            item.challengeId === challenge.challengeId ? revoked : item
          ),
          resetIntent: recoveryIntent,
        })
      );
      if (committed === 'unavailable') {
        return rejected('authority_store_unavailable');
      }
      return 'retry';
    }
    return rejected('reset_generation_not_newer');
  }

  private async activeKeyringError(
    state: HostedAccessAuthorityState,
    binding: AuthorityBinding
  ): Promise<HostedAccessRejectionCode | null> {
    const active = await this.core.dependencies.keyrings.loadActive();
    if (active.status !== 'available') return keyringReadCode(active.status);
    if (!isKeyringEnvelopeValid(active.envelope)) return 'keyring_corrupt';
    if (!bindingsEqual(active.envelope.binding, binding)) {
      return 'restore_binding_mismatch';
    }
    return active.envelope.keyringId === state.expectedKeyringId ? null : 'keyring_mismatch';
  }
}
