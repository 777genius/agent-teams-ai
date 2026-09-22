/* eslint-disable @typescript-eslint/require-await -- Async test doubles implement promise-based authority ports synchronously. */

import {
  type AuthorityBinding,
  type AuthResetStage,
  type HostedAccessAuthorityState,
  isRecoverableAuthorityState,
  parseAuthKeyringId,
  parseCsrfToken,
  parseDeviceFamilyId,
  parseDeviceGrantId,
  parseOpaqueAuthoritySecret,
  parseOperatorId,
} from '@features/hosted-access';
import { describe, expect, it } from 'vitest';

import {
  BINDING,
  createAuthorityFixture,
  DEFAULT_POLICY,
  pairFixture,
  REPLACEMENT_BINDING,
} from './authorityFixture';

describe('hosted access pairing authority', () => {
  it('revokes and reissues a challenge after a crash before plaintext publish', async () => {
    const fixture = createAuthorityFixture();
    await expect(fixture.authority.initialize(BINDING)).resolves.toMatchObject({
      ok: true,
    });
    fixture.delivery.failNextPublishBeforeWrite = true;

    const interrupted = await fixture.authority.issueInitialChallenge(BINDING);
    expect(interrupted).toEqual({
      ok: false,
      code: 'challenge_delivery_unavailable',
    });
    const abandonedId = fixture.state().pairingChallenges[0].challengeId;

    const recovered = await fixture.authority.issueInitialChallenge(BINDING);
    expect(recovered).toMatchObject({ ok: true, code: 'challenge_issued' });
    if (!recovered.ok) throw new Error('expected challenge recovery');
    expect(recovered.value.challengeId).not.toBe(abandonedId);
    expect(
      fixture.state().pairingChallenges.find(({ challengeId }) => challengeId === abandonedId)
    ).toMatchObject({
      status: 'revoked',
      revocationReason: 'publish_not_observed',
    });
    expect(fixture.delivery.delivered.size).toBe(1);
  });

  it('adopts a published challenge after the publish response is lost', async () => {
    const fixture = createAuthorityFixture();
    await fixture.authority.initialize(BINDING);
    fixture.delivery.loseNextPublishResponseAfterWrite = true;

    const interrupted = await fixture.authority.issueInitialChallenge(BINDING);
    expect(interrupted).toMatchObject({
      ok: false,
      code: 'challenge_delivery_unavailable',
    });
    const challengeId = fixture.state().pairingChallenges[0].challengeId;

    const recovered = await fixture.authority.issueInitialChallenge(BINDING);
    expect(recovered).toEqual({
      ok: true,
      code: 'challenge_issued',
      value: { challengeId },
    });
    expect(fixture.delivery.publishCalls).toBe(1);
  });

  it('reissues an issued challenge whose delivery is confirmed missing', async () => {
    const fixture = createAuthorityFixture();
    await fixture.authority.initialize(BINDING);
    const issued = await fixture.authority.issueInitialChallenge(BINDING);
    if (!issued.ok) throw new Error('expected issued fixture challenge');
    fixture.delivery.delivered.delete(issued.value.challengeId);

    const reissued = await fixture.authority.issueInitialChallenge(BINDING);
    expect(reissued).toMatchObject({ ok: true, code: 'challenge_issued' });
    if (!reissued.ok) throw new Error('expected reissued challenge');
    expect(reissued.value.challengeId).not.toBe(issued.value.challengeId);
    expect(fixture.state().pairingChallenges[0]).toMatchObject({
      status: 'revoked',
      revocationReason: 'issued_delivery_missing',
    });
  });

  it('does not create authority until plaintext removal is confirmed', async () => {
    const fixture = createAuthorityFixture();
    await fixture.authority.initialize(BINDING);
    const issued = await fixture.authority.issueInitialChallenge(BINDING);
    if (!issued.ok) throw new Error('expected issued fixture challenge');
    const pairingSecret = fixture.delivery.secret(issued.value.challengeId);
    fixture.delivery.removeUnavailable = true;

    const paired = await fixture.authority.pair(BINDING, pairingSecret);
    expect(paired).toEqual({
      ok: false,
      code: 'challenge_delivery_unavailable',
    });
    expect(fixture.state().pairingChallenges[0]).toMatchObject({
      status: 'issued',
      deliveryCleanupPending: false,
    });
    expect(fixture.state().deviceFamilies).toHaveLength(0);
    await expect(fixture.authority.initialize(BINDING)).resolves.toEqual({
      ok: true,
      code: 'authority_ready',
      value: { resetPending: false },
    });

    fixture.delivery.removeUnavailable = false;
    await expect(fixture.authority.pair(BINDING, pairingSecret)).resolves.toMatchObject({
      ok: true,
      code: 'paired',
    });
    expect(fixture.delivery.delivered.size).toBe(0);
    expect(fixture.state().pairingChallenges[0].deliveryCleanupPending).toBe(false);
  });

  it('persists keyed hashes only and never coordination plaintext', async () => {
    const fixture = createAuthorityFixture();
    const credentials = await pairFixture(fixture);
    const serialized = JSON.stringify(fixture.state());

    for (const plaintext of [
      credentials.pairingSecret,
      credentials.deviceSecret,
      credentials.sessionSecret,
      credentials.csrfToken,
    ]) {
      expect(serialized).not.toContain(plaintext);
    }
    expect(serialized).toContain('hmac-sha256:');
    expect(fixture.delivery.delivered.size).toBe(0);
  });

  it('converges concurrent challenge issuance and pairing to one family', async () => {
    const fixture = createAuthorityFixture();
    await fixture.authority.initialize(BINDING);
    const issued = await Promise.all([
      fixture.authority.issueInitialChallenge(BINDING),
      fixture.authority.issueInitialChallenge(BINDING),
    ]);
    expect(issued.every(({ ok }) => ok)).toBe(true);
    const challengeIds = new Set(
      issued.map((result) => (result.ok ? result.value.challengeId : 'rejected'))
    );
    expect(challengeIds.size).toBe(1);
    const challengeId = fixture.state().pairingChallenges[0].challengeId;
    const secret = fixture.delivery.secret(challengeId);

    const paired = await Promise.all([
      fixture.authority.pair(BINDING, secret),
      fixture.authority.pair(BINDING, secret),
    ]);
    expect(paired.filter(({ ok }) => ok)).toHaveLength(1);
    expect(paired.filter(({ ok }) => !ok)).toEqual([
      { ok: false, code: 'pairing_already_established' },
    ]);
    expect(fixture.state().deviceFamilies.filter(({ status }) => status === 'active')).toHaveLength(
      1
    );
  });

  it('confirms missing delivery and succeeds when cleanup removal loses its response', async () => {
    const fixture = createAuthorityFixture();
    await fixture.authority.initialize(BINDING);
    const issued = await fixture.authority.issueInitialChallenge(BINDING);
    if (!issued.ok) throw new Error('expected issued fixture challenge');
    const pairingSecret = fixture.delivery.secret(issued.value.challengeId);
    fixture.delivery.loseNextRemoveResponseAfterWrite = true;

    await expect(fixture.authority.pair(BINDING, pairingSecret)).resolves.toMatchObject({
      ok: true,
      code: 'paired',
    });
    expect(fixture.delivery.delivered.size).toBe(0);
    expect(fixture.state().pairingChallenges[0]).toMatchObject({
      status: 'consumed',
      deliveryCleanupPending: false,
    });
  });

  it('returns credentials when the pairing authority CAS response is lost after commit', async () => {
    const fixture = createAuthorityFixture();
    await fixture.authority.initialize(BINDING);
    const issued = await fixture.authority.issueInitialChallenge(BINDING);
    if (!issued.ok) throw new Error('expected issued fixture challenge');
    const pairingSecret = fixture.delivery.secret(issued.value.challengeId);
    fixture.repository.loseNextCasResponseAfterCommit = true;

    await expect(fixture.authority.pair(BINDING, pairingSecret)).resolves.toMatchObject({
      ok: true,
      code: 'paired',
    });
    expect(fixture.state().pairingChallenges[0].deliveryCleanupPending).toBe(false);
  });

  it('does not consume pairing authority or remove delivery before personal identity storage succeeds', async () => {
    const fixture = createAuthorityFixture();
    await fixture.authority.initialize(BINDING);
    const issued = await fixture.authority.issueInitialChallenge(BINDING);
    if (!issued.ok) throw new Error('expected issued fixture challenge');
    const pairingSecret = fixture.delivery.secret(issued.value.challengeId);
    const revisionBefore = fixture.state().revision;
    let storageAttempts = 0;

    await expect(
      fixture.authority.pair(BINDING, pairingSecret, {
        prepare: async () => {
          storageAttempts += 1;
          throw new Error('synthetic_identity_storage_failure');
        },
      })
    ).rejects.toThrow('synthetic_identity_storage_failure');
    expect(storageAttempts).toBe(1);
    expect(fixture.state()).toMatchObject({
      revision: revisionBefore,
      pairingChallenges: [{ status: 'issued' }],
      deviceFamilies: [],
      sessions: [],
    });
    expect(fixture.delivery.secret(issued.value.challengeId)).toBe(pairingSecret);

    const durableOperatorId = parseOperatorId('operator_durable-owner');
    await expect(
      fixture.authority.pair(BINDING, pairingSecret, {
        prepare: async () => durableOperatorId,
      })
    ).resolves.toMatchObject({
      ok: true,
      code: 'paired',
      value: { operatorId: durableOperatorId },
    });
  });

  it('never reissues committed credentials when a consumed pairing code is replayed', async () => {
    const fixture = createAuthorityFixture();
    await fixture.authority.initialize(BINDING);
    const issued = await fixture.authority.issueInitialChallenge(BINDING);
    if (!issued.ok) throw new Error('expected issued fixture challenge');
    const pairingSecret = fixture.delivery.secret(issued.value.challengeId);
    fixture.repository.loseNextCasResponseAfterCommit = true;

    const committed = await fixture.authority.pair(BINDING, pairingSecret);
    expect(committed).toMatchObject({ ok: true, code: 'paired' });
    if (!committed.ok) throw new Error('expected committed pairing');
    const serialized = JSON.stringify(fixture.state());
    for (const plaintext of [
      pairingSecret,
      committed.value.deviceSecret,
      committed.value.sessionSecret,
      committed.value.csrfToken,
    ]) {
      expect(serialized).not.toContain(plaintext);
    }

    const restarted = createAuthorityFixture({
      repository: fixture.repository,
      keyrings: fixture.keyrings,
      delivery: fixture.delivery,
      now: fixture.clock.now(),
    });
    await expect(restarted.authority.initialize(BINDING)).resolves.toMatchObject({
      ok: true,
      code: 'authority_ready',
    });
    await expect(restarted.authority.pair(BINDING, pairingSecret)).resolves.toEqual({
      ok: false,
      code: 'pairing_already_established',
    });
    expect(
      restarted.state().deviceFamilies.filter(({ status }) => status === 'active')
    ).toHaveLength(1);
  });

  it('expires and attempt-bounds a one-time pairing challenge', async () => {
    const fixture = createAuthorityFixture();
    await fixture.authority.initialize(BINDING);
    const issued = await fixture.authority.issueInitialChallenge(BINDING);
    if (!issued.ok) throw new Error('expected issued challenge');
    const wrong = parseOpaqueAuthoritySecret(
      'authority_wrong_abcdefghijklmnopqrstuvwxyz0123456789'
    );
    await expect(fixture.authority.pair(BINDING, wrong)).resolves.toEqual({
      ok: false,
      code: 'challenge_invalid',
    });
    await expect(fixture.authority.pair(BINDING, wrong)).resolves.toEqual({
      ok: false,
      code: 'challenge_invalid',
    });
    await expect(fixture.authority.pair(BINDING, wrong)).resolves.toEqual({
      ok: false,
      code: 'challenge_attempts_exhausted',
    });
    expect(fixture.state().pairingChallenges[0]).toMatchObject({
      status: 'revoked',
      failedAttempts: 3,
      deliveryCleanupPending: false,
    });

    const fresh = createAuthorityFixture();
    await fresh.authority.initialize(BINDING);
    const freshIssued = await fresh.authority.issueInitialChallenge(BINDING);
    if (!freshIssued.ok) throw new Error('expected fresh challenge');
    const secret = fresh.delivery.secret(freshIssued.value.challengeId);
    fresh.setNow(fresh.state().pairingChallenges[0].expiresAt);
    await expect(fresh.authority.pair(BINDING, secret)).resolves.toEqual({
      ok: false,
      code: 'challenge_expired',
    });
    expect(fresh.delivery.delivered.size).toBe(0);
  });

  it('reconciles revoked challenge cleanup on startup after unavailable and lost remove responses', async () => {
    const fixture = createAuthorityFixture();
    await fixture.authority.initialize(BINDING);
    await fixture.authority.issueInitialChallenge(BINDING);
    const wrong = parseOpaqueAuthoritySecret(
      'authority_wrong_abcdefghijklmnopqrstuvwxyz0123456789'
    );
    await fixture.authority.pair(BINDING, wrong);
    await fixture.authority.pair(BINDING, wrong);
    fixture.delivery.removeUnavailable = true;

    await expect(fixture.authority.pair(BINDING, wrong)).resolves.toEqual({
      ok: false,
      code: 'challenge_delivery_unavailable',
    });
    expect(fixture.state().pairingChallenges[0]).toMatchObject({
      status: 'revoked',
      deliveryCleanupPending: true,
    });
    await expect(fixture.authority.initialize(BINDING)).resolves.toEqual({
      ok: false,
      code: 'challenge_delivery_unavailable',
    });

    fixture.delivery.removeUnavailable = false;
    fixture.delivery.loseNextRemoveResponseAfterWrite = true;
    await expect(fixture.authority.initialize(BINDING)).resolves.toMatchObject({
      ok: true,
      code: 'authority_ready',
    });
    expect(fixture.state().pairingChallenges[0].deliveryCleanupPending).toBe(false);
  });
});

describe('hosted access reset recovery', () => {
  const PRE_REVOCATION_STAGES: readonly AuthResetStage[] = [
    'requested',
    'drain_confirmed',
    'key_stage_reserved',
    'new_key_staged',
  ];

  for (const stage of PRE_REVOCATION_STAGES) {
    it(`accepts the replacement binding after restart at ${stage}`, async () => {
      const fixture = createAuthorityFixture();
      await pairFixture(fixture);
      fixture.repository.loseAfterStage(stage);

      await expect(
        fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 1)
      ).resolves.toEqual({
        ok: false,
        code: 'authority_store_unavailable',
      });
      expect(fixture.state().resetIntent?.stage).toBe(stage);
      await expect(fixture.authority.initialize(REPLACEMENT_BINDING)).resolves.toEqual({
        ok: true,
        code: 'authority_reset_pending',
        value: { resetPending: true },
      });
      await expect(
        fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 1)
      ).resolves.toMatchObject({ ok: true, code: 'reset_completed' });
    });
  }

  it('adopts a staged keyring after a crash before the stage CAS', async () => {
    const fixture = createAuthorityFixture();
    await pairFixture(fixture);
    fixture.repository.loseBeforeStage('new_key_staged');

    await expect(fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 1)).resolves.toEqual(
      {
        ok: false,
        code: 'authority_store_unavailable',
      }
    );
    expect(fixture.state().resetIntent?.stage).toBe('key_stage_reserved');
    expect(fixture.keyrings.stageCalls).toBe(1);

    await expect(
      fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 1)
    ).resolves.toMatchObject({ ok: true, code: 'reset_completed' });
    expect(fixture.keyrings.stageCalls).toBe(1);
  });

  it('adopts a staged keyring when the staging response is lost', async () => {
    const fixture = createAuthorityFixture();
    await pairFixture(fixture);
    fixture.keyrings.loseNextStageResponseAfterWrite = true;

    await expect(
      fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 1)
    ).resolves.toMatchObject({ ok: true, code: 'reset_completed' });
    expect(fixture.keyrings.stageCalls).toBe(1);
  });

  it('adopts the active keyring when activation response is lost', async () => {
    const fixture = createAuthorityFixture();
    await pairFixture(fixture);
    fixture.keyrings.loseNextActivationResponseAfterWrite = true;

    await expect(
      fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 1)
    ).resolves.toMatchObject({ ok: true, code: 'reset_completed' });
    expect(fixture.keyrings.activateCalls).toBe(1);
    expect(fixture.keyrings.active?.binding).toEqual(REPLACEMENT_BINDING);
  });

  it('reissues reset delivery after publish failure and after completed delivery loss', async () => {
    const fixture = createAuthorityFixture();
    await pairFixture(fixture);
    fixture.delivery.failNextPublishBeforeWrite = true;

    await expect(fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 1)).resolves.toEqual(
      {
        ok: false,
        code: 'challenge_delivery_unavailable',
      }
    );
    const abandoned = fixture.state().resetIntent?.challengeId;
    expect(fixture.state().resetIntent?.stage).toBe('challenge_pending');

    const recovered = await fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 1);
    expect(recovered).toMatchObject({ ok: true, code: 'reset_completed' });
    if (!recovered.ok) throw new Error('expected reset recovery');
    expect(recovered.value.challengeId).not.toBe(abandoned);

    fixture.delivery.delivered.delete(recovered.value.challengeId);
    const reissued = await fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 1);
    expect(reissued).toMatchObject({ ok: true, code: 'reset_completed' });
    if (!reissued.ok) throw new Error('expected completed reset recovery');
    expect(reissued.value.challengeId).not.toBe(recovered.value.challengeId);
  });

  it('requires a fresh residual-runtime drain proof immediately before reset publication', async () => {
    const fixture = createAuthorityFixture();
    await pairFixture(fixture);
    const initialDrainCalls = fixture.drain.calls;
    fixture.drain.queuedStatuses.push('drained', 'residual');

    await expect(fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 1)).resolves.toEqual(
      {
        ok: false,
        code: 'pairing_drain_unconfirmed',
      }
    );
    expect(fixture.drain.calls).toBe(initialDrainCalls + 2);
    expect(fixture.delivery.delivered.size).toBe(0);
    expect(fixture.state().resetIntent).toMatchObject({
      stage: 'key_activated',
      drainEvidenceRef: `drain-evidence-${initialDrainCalls + 1}`,
    });

    await expect(
      fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 1)
    ).resolves.toMatchObject({ ok: true, code: 'reset_completed' });
    expect(fixture.drain.calls).toBe(initialDrainCalls + 3);
    expect(fixture.state().pairingChallenges.at(-1)).toMatchObject({
      status: 'issued',
      resetGeneration: 1,
    });
  });

  it('does not synthesize drain evidence while recovering completed-reset delivery loss', async () => {
    const fixture = createAuthorityFixture();
    await pairFixture(fixture);
    const completed = await fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 1);
    if (!completed.ok) throw new Error('expected completed reset');
    fixture.delivery.delivered.delete(completed.value.challengeId);
    const publishCalls = fixture.delivery.publishCalls;
    fixture.drain.unavailable = true;

    await expect(fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 1)).resolves.toEqual(
      {
        ok: false,
        code: 'pairing_drain_unconfirmed',
      }
    );
    expect(fixture.delivery.publishCalls).toBe(publishCalls);
    expect(fixture.state().resetIntent).toMatchObject({
      resetGeneration: 1,
      drainEvidenceRef: null,
      challengeId: null,
    });
    expect(JSON.stringify(fixture.state())).not.toContain('completed-reset-delivery-recovery');

    fixture.drain.unavailable = false;
    await expect(
      fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 1)
    ).resolves.toMatchObject({ ok: true, code: 'reset_completed' });
    expect(fixture.state().resetIntent).toBeNull();
  });

  it('removes every old pairing artifact before activating and publishing one reset artifact', async () => {
    const fixture = createAuthorityFixture();
    const paired = await pairFixture(fixture);
    fixture.delivery.forcePresent(paired.challengeId, paired.pairingSecret);
    fixture.delivery.removeUnavailable = true;
    const oldKeyringId = fixture.keyrings.active?.keyringId;

    await expect(fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 1)).resolves.toEqual(
      {
        ok: false,
        code: 'challenge_delivery_unavailable',
      }
    );
    expect(fixture.state().resetIntent?.stage).toBe('authority_revoked');
    expect(fixture.keyrings.active?.keyringId).toBe(oldKeyringId);
    expect(fixture.delivery.delivered.size).toBe(1);
    await expect(fixture.authority.initialize(REPLACEMENT_BINDING)).resolves.toEqual({
      ok: false,
      code: 'challenge_delivery_unavailable',
    });

    fixture.delivery.removeUnavailable = false;
    const completed = await fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 1);
    expect(completed).toMatchObject({ ok: true, code: 'reset_completed' });
    if (!completed.ok) throw new Error('expected reset completion');
    expect(fixture.delivery.delivered.size).toBe(1);
    expect(fixture.delivery.delivered.has(paired.challengeId)).toBe(false);
    expect(fixture.delivery.delivered.has(completed.value.challengeId)).toBe(true);
  });

  it('consumes reset generations monotonically and returns completed evidence idempotently', async () => {
    const fixture = createAuthorityFixture();
    await pairFixture(fixture);
    await expect(fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 0)).resolves.toEqual(
      { ok: false, code: 'reset_generation_not_newer' }
    );

    const completed = await fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 2);
    expect(completed).toMatchObject({ ok: true, code: 'reset_completed' });
    await expect(fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 2)).resolves.toEqual(
      completed
    );
    await expect(fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 1)).resolves.toEqual(
      { ok: false, code: 'reset_generation_not_newer' }
    );
  });

  it('recovers completed reset evidence after the completion CAS response is lost', async () => {
    const fixture = createAuthorityFixture();
    await pairFixture(fixture);
    fixture.repository.loseAfterCommitWhen = (state) =>
      state.resetIntent === null && state.consumedResetGeneration === 1;

    await expect(fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 1)).resolves.toEqual(
      {
        ok: false,
        code: 'authority_store_unavailable',
      }
    );
    await expect(
      fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 1)
    ).resolves.toMatchObject({ ok: true, code: 'reset_completed' });
  });

  it('does not report completed reset evidence after the active keyring disappears', async () => {
    const fixture = createAuthorityFixture();
    await pairFixture(fixture);
    await fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 1);
    fixture.keyrings.active = null;

    await expect(fixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 1)).resolves.toEqual(
      { ok: false, code: 'keyring_missing' }
    );
  });
});

describe('hosted access session authority', () => {
  it('caps session deadlines to family authority and revokes family expiry before auth', async () => {
    const fixture = createAuthorityFixture({
      policy: {
        deviceIdleTtlMs: 50,
        deviceAbsoluteTtlMs: 200,
        deviceRenewalTtlMs: 150,
        sessionIdleTtlMs: 100,
        sessionAbsoluteTtlMs: 500,
        sessionRenewalTtlMs: 300,
      },
    });
    const credentials = await pairFixture(fixture);
    const family = fixture.state().deviceFamilies[0];
    const session = fixture.state().sessions[0];
    expect(session.deadlines.absoluteExpiresAt).toBe(family.absoluteExpiresAt);
    expect(session.deadlines.renewalExpiresAt).toBe(family.absoluteExpiresAt);

    fixture.setNow(family.idleExpiresAt);
    await expect(
      fixture.authority.authenticate(BINDING, credentials.sessionSecret)
    ).resolves.toEqual({ ok: false, code: 'device_idle_expired' });
    expect(fixture.state().deviceFamilies[0].status).toBe('revoked');
    expect(fixture.state().sessions[0].status).toBe('revoked');
  });

  it('does not extend idle authority when CSRF comparison fails', async () => {
    const fixture = createAuthorityFixture();
    const credentials = await pairFixture(fixture);
    const before = fixture.state();
    fixture.setNow(before.sessions[0].lastUsedAt + 10);

    await expect(
      fixture.authority.verifyCsrf(
        BINDING,
        credentials.sessionSecret,
        parseCsrfToken('csrf_wrong_abcdefghijklmnopqrstuvwxyz0123456789abcdef')
      )
    ).resolves.toEqual({ ok: false, code: 'csrf_invalid' });
    expect(fixture.state().revision).toBe(before.revision);
    expect(fixture.state().sessions[0].lastUsedAt).toBe(before.sessions[0].lastUsedAt);
  });

  it('allows deterministic three-tab predecessor convergence on one successor generation', async () => {
    const fixture = createAuthorityFixture();
    const credentials = await pairFixture(fixture);

    const results = await Promise.all([
      fixture.authority.renew(BINDING, credentials.deviceSecret),
      fixture.authority.renew(BINDING, credentials.deviceSecret),
      fixture.authority.renew(BINDING, credentials.deviceSecret),
    ]);
    expect(results.every(({ ok }) => ok)).toBe(true);
    expect(
      results
        .map((result) => (result.ok ? result.value.deviceGeneration : -1))
        .sort((left, right) => left - right)
    ).toEqual([2, 2, 2]);
    const successful = results.filter((result) => result.ok);
    expect(new Set(successful.map(({ value }) => value.deviceSecret)).size).toBe(1);
    expect(new Set(successful.map(({ value }) => value.sessionSecret)).size).toBe(1);
    expect(fixture.state().deviceFamilies[0]).toMatchObject({
      status: 'active',
      currentGeneration: 2,
    });
    await expect(fixture.authority.renew(BINDING, credentials.deviceSecret)).resolves.toEqual({
      ok: false,
      code: 'device_family_revoked',
    });
  });

  it('does not rotate device or session credentials before personal identity storage succeeds', async () => {
    const fixture = createAuthorityFixture();
    const credentials = await pairFixture(fixture);
    const before = fixture.state();

    await expect(
      fixture.authority.renew(BINDING, credentials.deviceSecret, {
        prepare: async () => {
          throw new Error('synthetic_identity_storage_failure');
        },
      })
    ).rejects.toThrow('synthetic_identity_storage_failure');
    expect(fixture.state()).toEqual(before);
    await expect(
      fixture.authority.authenticate(BINDING, credentials.sessionSecret)
    ).resolves.toMatchObject({ ok: true, code: 'authenticated' });

    await expect(
      fixture.authority.renew(BINDING, credentials.deviceSecret, {
        prepare: async (operatorId) => operatorId,
      })
    ).resolves.toMatchObject({
      ok: true,
      code: 'renewed',
      value: { deviceGeneration: 2 },
    });
  });

  it('survives two consecutive lost renew responses within the predecessor budget', async () => {
    const fixture = createAuthorityFixture();
    const credentials = await pairFixture(fixture);

    fixture.repository.loseNextCasResponseAfterCommit = true;
    await expect(fixture.authority.renew(BINDING, credentials.deviceSecret)).resolves.toEqual({
      ok: false,
      code: 'authority_store_unavailable',
    });
    fixture.repository.loseNextCasResponseAfterCommit = true;
    await expect(fixture.authority.renew(BINDING, credentials.deviceSecret)).resolves.toEqual({
      ok: false,
      code: 'authority_store_unavailable',
    });
    await expect(fixture.authority.renew(BINDING, credentials.deviceSecret)).resolves.toMatchObject(
      {
        ok: true,
        code: 'renewed',
        value: { acceptedVia: 'predecessor', deviceGeneration: 2 },
      }
    );
    expect(fixture.state().deviceFamilies[0].status).toBe('active');
  });

  it('makes predecessor replay monotonic without refreshing grace or successor authority', async () => {
    const fixture = createAuthorityFixture();
    const credentials = await pairFixture(fixture);
    const renewed = await fixture.authority.renew(BINDING, credentials.deviceSecret);
    if (!renewed.ok) throw new Error('expected initial renewal');
    const predecessorBefore = fixture
      .state()
      .deviceGrants.find(({ generation }) => generation === 1)!;
    const successorBefore = fixture
      .state()
      .deviceGrants.find(({ generation }) => generation === 2)!;
    const familyBefore = fixture.state().deviceFamilies[0];
    const sessionBefore = fixture.state().sessions.find(({ status }) => status === 'active')!;

    fixture.setNow(familyBefore.lastUsedAt + 10);
    const firstReplay = await fixture.authority.renew(BINDING, credentials.deviceSecret);
    expect(firstReplay).toEqual({
      ...renewed,
      value: {
        ...renewed.value,
        acceptedDeviceGeneration: 1,
        acceptedVia: 'predecessor',
      },
    });
    const predecessorAfter = fixture
      .state()
      .deviceGrants.find(({ generation }) => generation === 1)!;
    expect(predecessorAfter.predecessorGraceExpiresAt).toBe(
      predecessorBefore.predecessorGraceExpiresAt
    );
    expect(predecessorAfter.predecessorUsesRemaining).toBe(
      predecessorBefore.predecessorUsesRemaining - 1
    );
    expect(fixture.state().deviceFamilies[0]).toEqual(familyBefore);
    expect(fixture.state().deviceGrants.find(({ generation }) => generation === 2)).toEqual(
      successorBefore
    );
    expect(fixture.state().sessions.find(({ status }) => status === 'active')).toEqual(
      sessionBefore
    );

    fixture.setNow(familyBefore.lastUsedAt + 20);
    await expect(fixture.authority.renew(BINDING, credentials.deviceSecret)).resolves.toEqual(
      firstReplay
    );
    expect(fixture.state().deviceFamilies[0].currentGeneration).toBe(2);
    expect(fixture.state().deviceGrants.find(({ generation }) => generation === 1)).toMatchObject({
      status: 'retired',
      predecessorGraceExpiresAt: null,
      predecessorUsesRemaining: 0,
    });
  });

  it('revokes a predecessor replay after authority advances beyond its direct successor', async () => {
    const fixture = createAuthorityFixture();
    const initial = await pairFixture(fixture);
    const second = await fixture.authority.renew(BINDING, initial.deviceSecret);
    if (!second.ok) throw new Error('expected second generation');
    const third = await fixture.authority.renew(BINDING, second.value.deviceSecret);
    if (!third.ok) throw new Error('expected third generation');

    await expect(fixture.authority.renew(BINDING, initial.deviceSecret)).resolves.toEqual({
      ok: false,
      code: 'device_family_revoked',
    });
    expect(fixture.state().deviceFamilies[0]).toMatchObject({
      status: 'revoked',
      currentGeneration: 3,
    });
  });

  it('revokes the family on predecessor replay at the grace boundary', async () => {
    const fixture = createAuthorityFixture();
    const credentials = await pairFixture(fixture);
    const renewed = await fixture.authority.renew(BINDING, credentials.deviceSecret);
    expect(renewed.ok).toBe(true);
    const predecessor = fixture.state().deviceGrants.find(({ generation }) => generation === 1)!;
    fixture.setNow(predecessor.predecessorGraceExpiresAt!);

    await expect(fixture.authority.renew(BINDING, credentials.deviceSecret)).resolves.toEqual({
      ok: false,
      code: 'device_family_revoked',
    });
    expect(fixture.state().deviceFamilies[0].status).toBe('revoked');
  });

  it('bounds revoked session retention under repeated renewal', async () => {
    const fixture = createAuthorityFixture();
    let credentials = await pairFixture(fixture);
    for (let index = 0; index < 80; index += 1) {
      const renewed = await fixture.authority.renew(BINDING, credentials.deviceSecret);
      if (!renewed.ok) throw new Error(`renew ${index} failed: ${renewed.code}`);
      credentials = { ...credentials, ...renewed.value };
    }
    expect(fixture.state().sessions).toHaveLength(64);
    expect(fixture.state().sessions.filter(({ status }) => status === 'active')).toHaveLength(1);
  });

  it('fails closed when the active keyring disappears after restart', async () => {
    const fixture = createAuthorityFixture();
    const credentials = await pairFixture(fixture);
    fixture.keyrings.active = null;

    await expect(
      fixture.authority.authenticate(BINDING, credentials.sessionSecret)
    ).resolves.toEqual({ ok: false, code: 'keyring_missing' });
  });

  it.each([
    {
      label: 'session idle',
      policy: {
        sessionIdleTtlMs: 50,
        sessionRenewalTtlMs: 150,
        sessionAbsoluteTtlMs: 200,
      },
      deadline: (state: HostedAccessAuthorityState) => state.sessions[0].deadlines.idleExpiresAt,
      code: 'session_idle_expired',
    },
    {
      label: 'session renewal',
      policy: {
        sessionIdleTtlMs: 150,
        sessionRenewalTtlMs: 50,
        sessionAbsoluteTtlMs: 200,
      },
      deadline: (state: HostedAccessAuthorityState) => state.sessions[0].deadlines.renewalExpiresAt,
      code: 'session_renewal_required',
    },
    {
      label: 'session absolute',
      policy: {
        sessionIdleTtlMs: 100,
        sessionRenewalTtlMs: 100,
        sessionAbsoluteTtlMs: 100,
      },
      deadline: (state: HostedAccessAuthorityState) =>
        state.sessions[0].deadlines.absoluteExpiresAt,
      code: 'session_absolute_expired',
    },
  ])('enforces the $label boundary server-side', async ({ policy, deadline, code }) => {
    const fixture = createAuthorityFixture({ policy });
    const credentials = await pairFixture(fixture);
    fixture.setNow(deadline(fixture.state()));
    await expect(
      fixture.authority.authenticate(BINDING, credentials.sessionSecret)
    ).resolves.toEqual({ ok: false, code });
    expect(fixture.state().sessions[0].status).toBe('revoked');
  });

  it('enforces family absolute and device-generation renewal boundaries', async () => {
    const absolute = createAuthorityFixture({
      policy: {
        deviceIdleTtlMs: 200,
        deviceAbsoluteTtlMs: 200,
        deviceRenewalTtlMs: 150,
      },
    });
    const absoluteCredentials = await pairFixture(absolute);
    absolute.setNow(absolute.state().deviceFamilies[0].absoluteExpiresAt);
    await expect(
      absolute.authority.authenticate(BINDING, absoluteCredentials.sessionSecret)
    ).resolves.toEqual({ ok: false, code: 'device_absolute_expired' });

    const renewal = createAuthorityFixture({
      policy: { deviceRenewalTtlMs: 50 },
    });
    const renewalCredentials = await pairFixture(renewal);
    renewal.setNow(renewal.state().deviceGrants[0].renewalExpiresAt);
    await expect(
      renewal.authority.renew(BINDING, renewalCredentials.deviceSecret)
    ).resolves.toEqual({ ok: false, code: 'device_invalid' });
    expect(renewal.state().deviceFamilies[0].status).toBe('revoked');
  });

  it('derives stable CSRF per session and rotates it with renewal', async () => {
    const fixture = createAuthorityFixture();
    const credentials = await pairFixture(fixture);
    const bootstrap = await fixture.authority.bootstrapSession(BINDING, credentials.sessionSecret);
    expect(bootstrap).toMatchObject({
      ok: true,
      value: { csrfToken: credentials.csrfToken },
    });

    const renewed = await fixture.authority.renew(BINDING, credentials.deviceSecret);
    if (!renewed.ok) throw new Error('expected renewal');
    expect(renewed.value.csrfToken).not.toBe(credentials.csrfToken);
    await expect(
      fixture.authority.verifyCsrf(BINDING, renewed.value.sessionSecret, credentials.csrfToken)
    ).resolves.toEqual({ ok: false, code: 'csrf_invalid' });
    await expect(
      fixture.authority.verifyCsrf(BINDING, renewed.value.sessionSecret, renewed.value.csrfToken)
    ).resolves.toMatchObject({ ok: true, code: 'csrf_verified' });
  });

  it('separates logout from whole-family device revocation', async () => {
    const logoutFixture = createAuthorityFixture();
    const loggedIn = await pairFixture(logoutFixture);
    await expect(
      logoutFixture.authority.logout(BINDING, loggedIn.sessionSecret)
    ).resolves.toMatchObject({ ok: true, code: 'logged_out' });
    expect(logoutFixture.state().deviceFamilies[0].status).toBe('active');
    expect(logoutFixture.state().sessions[0].status).toBe('revoked');

    const forgetFixture = createAuthorityFixture();
    const remembered = await pairFixture(forgetFixture);
    await expect(
      forgetFixture.authority.forgetDevice(BINDING, remembered.sessionSecret)
    ).resolves.toMatchObject({ ok: true, code: 'device_forgotten' });
    expect(forgetFixture.state().deviceFamilies[0].status).toBe('revoked');
    expect(forgetFixture.state().deviceGrants.every(({ status }) => status === 'revoked')).toBe(
      true
    );
  });
});

describe('hosted access restore and keyring fences', () => {
  it('rejects restore binding drift and active keyring mismatch/corruption', async () => {
    const fixture = createAuthorityFixture();
    const credentials = await pairFixture(fixture);
    await expect(fixture.authority.initialize(REPLACEMENT_BINDING)).resolves.toEqual({
      ok: false,
      code: 'restore_binding_mismatch',
    });

    const active = fixture.keyrings.active!;
    fixture.keyrings.active = {
      ...active,
      keyringId: parseAuthKeyringId('auth-keyring_99999999'),
    };
    await expect(
      fixture.authority.authenticate(BINDING, credentials.sessionSecret)
    ).resolves.toEqual({ ok: false, code: 'keyring_mismatch' });

    fixture.keyrings.active = {
      ...active,
      hashKey: 'invalid-key-material' as typeof active.hashKey,
    };
    await expect(
      fixture.authority.authenticate(BINDING, credentials.sessionSecret)
    ).resolves.toEqual({ ok: false, code: 'keyring_corrupt' });
  });

  it('rejects projection rollback after revocation or predecessor-use consumption', async () => {
    const revokedFixture = createAuthorityFixture();
    const revokedCredentials = await pairFixture(revokedFixture);
    const beforeLogout = structuredClone(revokedFixture.state());

    await expect(
      revokedFixture.authority.logout(BINDING, revokedCredentials.sessionSecret)
    ).resolves.toMatchObject({ ok: true, code: 'logged_out' });
    expect(revokedFixture.repository.rollbackFenceRevision).toBe(revokedFixture.state().revision);
    revokedFixture.repository.state = beforeLogout;

    await expect(
      revokedFixture.authority.authenticate(BINDING, revokedCredentials.sessionSecret)
    ).resolves.toEqual({ ok: false, code: 'authority_state_corrupt' });

    const useFixture = createAuthorityFixture();
    const initial = await pairFixture(useFixture);
    const renewed = await useFixture.authority.renew(BINDING, initial.deviceSecret);
    if (!renewed.ok) throw new Error('expected initial renewal');
    const beforeUse = structuredClone(useFixture.state());

    await expect(useFixture.authority.renew(BINDING, initial.deviceSecret)).resolves.toMatchObject({
      ok: true,
      value: { acceptedVia: 'predecessor' },
    });
    expect(
      useFixture.state().deviceGrants.find(({ status }) => status === 'predecessor')
        ?.predecessorUsesRemaining
    ).toBe(DEFAULT_POLICY.predecessorMaxUses - 1);
    useFixture.repository.state = beforeUse;

    await expect(useFixture.authority.renew(BINDING, initial.deviceSecret)).resolves.toEqual({
      ok: false,
      code: 'authority_state_corrupt',
    });
  });
});

describe('hosted access fail-closed persisted validation', () => {
  it('rejects persisted attempts, uses, and deadlines inflated beyond current policy', async () => {
    const fixture = createAuthorityFixture();
    const initial = await pairFixture(fixture);
    const renewed = await fixture.authority.renew(BINDING, initial.deviceSecret);
    if (!renewed.ok) throw new Error('expected renewal fixture');
    const valid = structuredClone(fixture.state());

    const inflations: readonly ((
      state: HostedAccessAuthorityState
    ) => HostedAccessAuthorityState)[] = [
      (state) =>
        ({
          ...state,
          pairingChallenges: state.pairingChallenges.map((challenge, index) =>
            index === 0
              ? { ...challenge, maxAttempts: DEFAULT_POLICY.pairingMaxAttempts + 1 }
              : challenge
          ),
        }) as HostedAccessAuthorityState,
      (state) =>
        ({
          ...state,
          pairingChallenges: state.pairingChallenges.map((challenge, index) =>
            index === 0
              ? {
                  ...challenge,
                  expiresAt: challenge.issuedAt + DEFAULT_POLICY.pairingChallengeTtlMs + 1,
                }
              : challenge
          ),
        }) as HostedAccessAuthorityState,
      (state) =>
        ({
          ...state,
          deviceFamilies: state.deviceFamilies.map((family, index) =>
            index === 0
              ? {
                  ...family,
                  idleExpiresAt: family.lastUsedAt + DEFAULT_POLICY.deviceIdleTtlMs + 1,
                }
              : family
          ),
        }) as HostedAccessAuthorityState,
      (state) =>
        ({
          ...state,
          deviceFamilies: state.deviceFamilies.map((family, index) =>
            index === 0
              ? {
                  ...family,
                  absoluteExpiresAt: family.issuedAt + DEFAULT_POLICY.deviceAbsoluteTtlMs + 1,
                }
              : family
          ),
        }) as HostedAccessAuthorityState,
      (state) =>
        ({
          ...state,
          deviceGrants: state.deviceGrants.map((grant) =>
            grant.status === 'current'
              ? {
                  ...grant,
                  renewalExpiresAt: grant.issuedAt + DEFAULT_POLICY.deviceRenewalTtlMs + 1,
                }
              : grant
          ),
        }) as HostedAccessAuthorityState,
      (state) =>
        ({
          ...state,
          deviceGrants: state.deviceGrants.map((grant) =>
            grant.status === 'predecessor'
              ? {
                  ...grant,
                  predecessorUsesRemaining: DEFAULT_POLICY.predecessorMaxUses + 1,
                }
              : grant
          ),
        }) as HostedAccessAuthorityState,
      (state) => {
        const successorIssuedAt = state.deviceGrants.find(
          ({ status }) => status === 'current'
        )!.issuedAt;
        return {
          ...state,
          deviceGrants: state.deviceGrants.map((grant) =>
            grant.status === 'predecessor'
              ? {
                  ...grant,
                  predecessorGraceExpiresAt:
                    successorIssuedAt + DEFAULT_POLICY.predecessorGraceMs + 1,
                }
              : grant
          ),
        } as HostedAccessAuthorityState;
      },
      (state) =>
        ({
          ...state,
          sessions: state.sessions.map((session) =>
            session.status === 'active'
              ? {
                  ...session,
                  deadlines: {
                    ...session.deadlines,
                    idleExpiresAt: session.lastUsedAt + DEFAULT_POLICY.sessionIdleTtlMs + 1,
                  },
                }
              : session
          ),
        }) as HostedAccessAuthorityState,
      (state) =>
        ({
          ...state,
          sessions: state.sessions.map((session) =>
            session.status === 'active'
              ? {
                  ...session,
                  deadlines: {
                    ...session.deadlines,
                    absoluteExpiresAt: session.issuedAt + DEFAULT_POLICY.sessionAbsoluteTtlMs + 1,
                  },
                }
              : session
          ),
        }) as HostedAccessAuthorityState,
      (state) =>
        ({
          ...state,
          sessions: state.sessions.map((session) =>
            session.status === 'active'
              ? {
                  ...session,
                  deadlines: {
                    ...session.deadlines,
                    renewalExpiresAt: session.issuedAt + DEFAULT_POLICY.sessionRenewalTtlMs + 1,
                  },
                }
              : session
          ),
        }) as HostedAccessAuthorityState,
    ];

    for (const inflate of inflations) {
      const state = inflate(structuredClone(valid));
      expect(isRecoverableAuthorityState(state, DEFAULT_POLICY)).toBe(false);
      fixture.repository.state = state;
      await expect(fixture.authority.initialize(BINDING)).resolves.toEqual({
        ok: false,
        code: 'authority_state_corrupt',
      });
    }
  });

  it('rejects unknown persisted properties, including plaintext-secret-shaped fields', async () => {
    const fixture = createAuthorityFixture();
    const credentials = await pairFixture(fixture);
    const valid = structuredClone(fixture.state());
    const plaintext = parseOpaqueAuthoritySecret(
      'authority_plaintext_abcdefghijklmnopqrstuvwxyz0123456789'
    );
    const unknownProperties: readonly ((
      state: HostedAccessAuthorityState
    ) => HostedAccessAuthorityState)[] = [
      (state) => ({ ...state, deviceSecret: plaintext }) as HostedAccessAuthorityState,
      (state) =>
        ({
          ...state,
          binding: { ...state.binding, sessionSecret: plaintext },
        }) as HostedAccessAuthorityState,
      (state) =>
        ({
          ...state,
          pairingChallenges: state.pairingChallenges.map((challenge, index) =>
            index === 0 ? { ...challenge, pairingSecret: plaintext } : challenge
          ),
        }) as HostedAccessAuthorityState,
      (state) =>
        ({
          ...state,
          deviceFamilies: state.deviceFamilies.map((family, index) =>
            index === 0 ? { ...family, deviceSecret: plaintext } : family
          ),
        }) as HostedAccessAuthorityState,
      (state) =>
        ({
          ...state,
          deviceGrants: state.deviceGrants.map((grant, index) =>
            index === 0 ? { ...grant, deviceSecret: plaintext } : grant
          ),
        }) as HostedAccessAuthorityState,
      (state) =>
        ({
          ...state,
          sessions: state.sessions.map((session, index) =>
            index === 0 ? { ...session, sessionSecret: plaintext } : session
          ),
        }) as HostedAccessAuthorityState,
      (state) =>
        ({
          ...state,
          sessions: state.sessions.map((session, index) =>
            index === 0
              ? {
                  ...session,
                  deadlines: { ...session.deadlines, csrfToken: plaintext },
                }
              : session
          ),
        }) as HostedAccessAuthorityState,
    ];

    for (const addUnknownProperty of unknownProperties) {
      const state = addUnknownProperty(structuredClone(valid));
      expect(isRecoverableAuthorityState(state, DEFAULT_POLICY)).toBe(false);
      fixture.repository.state = state;
      await expect(fixture.authority.initialize(BINDING)).resolves.toEqual({
        ok: false,
        code: 'authority_state_corrupt',
      });
    }

    fixture.repository.state = valid;
    const active = fixture.keyrings.active!;
    fixture.keyrings.active = {
      ...active,
      sessionSecret: plaintext,
    } as typeof active;
    await expect(
      fixture.authority.authenticate(BINDING, credentials.sessionSecret)
    ).resolves.toEqual({ ok: false, code: 'keyring_corrupt' });

    const resetFixture = createAuthorityFixture();
    await pairFixture(resetFixture);
    resetFixture.repository.loseAfterStage('requested');
    await expect(
      resetFixture.authority.consumeResetGeneration(REPLACEMENT_BINDING, 1)
    ).resolves.toEqual({ ok: false, code: 'authority_store_unavailable' });
    const resetState = {
      ...resetFixture.state(),
      resetIntent: {
        ...resetFixture.state().resetIntent!,
        deviceSecret: plaintext,
      },
    } as HostedAccessAuthorityState;
    expect(isRecoverableAuthorityState(resetState, DEFAULT_POLICY)).toBe(false);
    resetFixture.repository.state = resetState;
    await expect(resetFixture.authority.initialize(REPLACEMENT_BINDING)).resolves.toEqual({
      ok: false,
      code: 'authority_state_corrupt',
    });
  });

  it('rejects inconsistent security relationships and deadline/status states', async () => {
    const fixture = createAuthorityFixture();
    const credentials = await pairFixture(fixture);
    const valid = fixture.state();
    const alternateOperator = parseOperatorId('operator_99999999');
    const alternateKeyring = parseAuthKeyringId('auth-keyring_99999999');

    const corruptions: readonly ((
      state: HostedAccessAuthorityState
    ) => HostedAccessAuthorityState)[] = [
      (state) =>
        ({
          ...state,
          deviceFamilies: state.deviceFamilies.map((family, index) =>
            index === 0 ? { ...family, lastUsedAt: family.idleExpiresAt + 1 } : family
          ),
        }) as HostedAccessAuthorityState,
      (state) =>
        ({
          ...state,
          sessions: state.sessions.map((session, index) =>
            index === 0
              ? {
                  ...session,
                  deadlines: {
                    ...session.deadlines,
                    renewalExpiresAt: session.deadlines.absoluteExpiresAt + 1,
                  },
                }
              : session
          ),
        }) as HostedAccessAuthorityState,
      (state) =>
        ({
          ...state,
          sessions: state.sessions.map((session, index) =>
            index === 0 ? { ...session, operatorId: alternateOperator } : session
          ),
        }) as HostedAccessAuthorityState,
      (state) =>
        ({
          ...state,
          sessions: state.sessions.map((session, index) =>
            index === 0 ? { ...session, keyringId: alternateKeyring } : session
          ),
        }) as HostedAccessAuthorityState,
      (state) => {
        const family = state.deviceFamilies[0];
        const grant = state.deviceGrants.find(({ status }) => status === 'current')!;
        const familyId = parseDeviceFamilyId('device-family_99999999');
        return {
          ...state,
          deviceFamilies: [...state.deviceFamilies, { ...family, familyId }],
          deviceGrants: [
            ...state.deviceGrants,
            {
              ...grant,
              grantId: parseDeviceGrantId('device-grant_99999999'),
              familyId,
            },
          ],
        } as HostedAccessAuthorityState;
      },
      (state) =>
        ({
          ...state,
          deviceFamilies: state.deviceFamilies.map((family, index) =>
            index === 0
              ? {
                  ...family,
                  revokedAt: family.issuedAt,
                  revocationReason: 'impossible_active_revocation',
                }
              : family
          ),
        }) as HostedAccessAuthorityState,
      (state) =>
        ({
          ...state,
          sessions: state.sessions.map((session, index) =>
            index === 0 ? { ...session, deviceGeneration: 999 } : session
          ),
        }) as HostedAccessAuthorityState,
      (state) =>
        ({
          ...state,
          pairingChallenges: state.pairingChallenges.map((challenge, index) =>
            index === 0
              ? {
                  ...challenge,
                  pairedSessionId: 'session_99999999',
                }
              : challenge
          ),
        }) as HostedAccessAuthorityState,
      (state) =>
        ({
          ...state,
          deviceGrants: state.deviceGrants.map((grant, index) =>
            index === 0
              ? {
                  ...grant,
                  renewedFromGrantId: parseDeviceGrantId('device-grant_99999999'),
                }
              : grant
          ),
        }) as HostedAccessAuthorityState,
    ];

    for (const corrupt of corruptions) {
      const state = corrupt(structuredClone(valid));
      expect(isRecoverableAuthorityState(state, DEFAULT_POLICY)).toBe(false);
      fixture.repository.state = state;
      await expect(
        fixture.authority.authenticate(BINDING, credentials.sessionSecret)
      ).resolves.toEqual({ ok: false, code: 'authority_state_corrupt' });
    }
  });
});

describe('hosted access public binding validation', () => {
  it('rejects malformed bindings before every public read or effect', async () => {
    const secret = parseOpaqueAuthoritySecret(
      'authority_secret_abcdefghijklmnopqrstuvwxyz0123456789'
    );
    const csrf = parseCsrfToken('csrf_token_abcdefghijklmnopqrstuvwxyz0123456789');
    const malformed = {
      deploymentId: 'not-valid',
      restoreGeneration: -1,
    } as AuthorityBinding;
    const fixture = createAuthorityFixture();
    const calls = [
      () => fixture.authority.initialize(malformed),
      () => fixture.authority.issueInitialChallenge(malformed),
      () => fixture.authority.pair(malformed, secret),
      () => fixture.authority.renew(malformed, secret),
      () => fixture.authority.authenticate(malformed, secret),
      () => fixture.authority.bootstrapSession(malformed, secret),
      () => fixture.authority.verifyCsrf(malformed, secret, csrf),
      () => fixture.authority.logout(malformed, secret),
      () => fixture.authority.forgetDevice(malformed, secret),
      () => fixture.authority.consumeResetGeneration(malformed, 1),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toThrow('hosted-access-authority-deployment-id-invalid');
    }
    expect(fixture.effectCount()).toBe(0);
  });
});
