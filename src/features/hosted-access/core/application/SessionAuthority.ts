import {
  type AuthenticatedOperator,
  type AuthorityBinding,
  type CsrfToken,
  type HostedAccessRejectionCode,
  type HostedAccessResult,
  type OpaqueAuthoritySecret,
  parseDeviceGrantId,
  parseOperatorSessionId,
  type RenewedCredentials,
} from '../../contracts';
import {
  addDuration,
  assertAuthorityBinding,
  extendIdleDeadline,
  type HostedAccessAuthorityState,
  nextAuthorityState,
  type OperatorDeviceFamily,
  type OperatorDeviceGrant,
  type OperatorSession,
} from '../domain';

import { AuthorityCore, findHashMatch } from './AuthorityCore';
import { createSession } from './PairingAuthority';
import { accepted, rejected } from './results';

export class SessionAuthority {
  constructor(private readonly core: AuthorityCore) {}

  async renew(
    binding: AuthorityBinding,
    deviceSecret: OpaqueAuthoritySecret
  ): Promise<HostedAccessResult<RenewedCredentials, 'renewed'>> {
    assertAuthorityBinding(binding);
    const policy = this.core.dependencies.policy;
    for (let attempt = 0; attempt < policy.compareAndSwapAttempts; attempt += 1) {
      const loaded = await this.core.loadRegular(binding);
      if (!loaded.ok) return loaded;
      const presentedHash = await this.core.dependencies.crypto.keyedHash({
        key: loaded.keyring.hashKey,
        purpose: 'device-grant',
        secret: deviceSecret,
      });
      const presentedGrant = await findHashMatch(
        this.core.dependencies.crypto,
        loaded.state.deviceGrants,
        presentedHash
      );
      if (presentedGrant === null) return rejected('device_invalid');
      const family = loaded.state.deviceFamilies.find(
        ({ familyId }) => familyId === presentedGrant.familyId
      );
      if (family?.status !== 'active') return rejected('device_family_revoked');
      const now = this.core.now();
      const familyExpiry = classifyFamilyExpiry(family, now);
      if (familyExpiry !== null) {
        const next = revokeDeviceFamily(loaded.state, family.familyId, now, familyExpiry);
        const committed = await this.core.commit(loaded.state, next);
        if (committed === 'conflict') continue;
        if (committed === 'unavailable') return rejected('authority_store_unavailable');
        return rejected(familyExpiry);
      }

      const acceptedVia = classifyPresentedGrant(presentedGrant, now);
      if (acceptedVia === null) {
        const next = revokeDeviceFamily(
          loaded.state,
          family.familyId,
          now,
          'predecessor_replay_outside_grace'
        );
        const committed = await this.core.commit(loaded.state, next);
        if (committed === 'conflict') continue;
        if (committed === 'unavailable') return rejected('authority_store_unavailable');
        return rejected('device_family_revoked');
      }
      if (now >= presentedGrant.renewalExpiresAt) {
        const next = revokeDeviceFamily(
          loaded.state,
          family.familyId,
          now,
          'device_generation_renewal_expired'
        );
        const committed = await this.core.commit(loaded.state, next);
        if (committed === 'conflict') continue;
        if (committed === 'unavailable') return rejected('authority_store_unavailable');
        return rejected('device_invalid');
      }
      if (acceptedVia === 'predecessor') {
        const recovered = await this.recoverPredecessorRenewal(
          loaded,
          family,
          presentedGrant,
          deviceSecret,
          now
        );
        if (recovered === 'retry') continue;
        return recovered;
      }

      const generation = family.currentGeneration + 1;
      const grantId = parseDeviceGrantId(
        await this.core.dependencies.random.randomId('device-grant')
      );
      const sessionId = parseOperatorSessionId(
        await this.core.dependencies.random.randomId('session')
      );
      const nextDeviceSecret = await this.core.deriveAuthoritySecret({
        key: loaded.keyring.hashKey,
        purpose: 'renewed-device-grant',
        sourceSecret: deviceSecret,
        context: `${grantId}:${generation}`,
      });
      const sessionSecret = await this.core.deriveAuthoritySecret({
        key: loaded.keyring.hashKey,
        purpose: 'renewed-session',
        sourceSecret: deviceSecret,
        context: `${sessionId}:${generation}`,
      });
      const grantHash = await this.core.dependencies.crypto.keyedHash({
        key: loaded.keyring.hashKey,
        purpose: 'device-grant',
        secret: nextDeviceSecret,
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
      const nextGrant: OperatorDeviceGrant = Object.freeze({
        grantId,
        familyId: family.familyId,
        generation,
        renewedFromGrantId: presentedGrant.grantId,
        secretHash: grantHash,
        keyringId: loaded.keyring.keyringId,
        issuedAt: now,
        renewalExpiresAt: Math.min(
          addDuration(now, policy.deviceRenewalTtlMs),
          family.absoluteExpiresAt
        ),
        status: 'current',
        predecessorGraceExpiresAt: null,
        predecessorUsesRemaining: 0,
        retiredAt: null,
        revokedAt: null,
        revocationReason: null,
      });
      const rotatedGrants = rotateCurrentGeneration(
        loaded.state.deviceGrants,
        family.familyId,
        presentedGrant.grantId,
        now,
        policy.predecessorGraceMs,
        policy.predecessorMaxUses
      );
      const retainedGrants = retainRecentGenerations(
        [...rotatedGrants, nextGrant],
        family.familyId,
        policy.retainedDeviceGenerations
      );
      const nextFamily: OperatorDeviceFamily = Object.freeze({
        ...family,
        lastUsedAt: now,
        idleExpiresAt: extendIdleDeadline(now, policy.deviceIdleTtlMs, family.absoluteExpiresAt),
        currentGeneration: generation,
      });
      const session = createSession({
        sessionId,
        operatorId: family.operatorId,
        familyId: family.familyId,
        deviceGeneration: generation,
        secretHash: sessionHash,
        keyringId: loaded.keyring.keyringId,
        now,
        familyAbsoluteExpiresAt: family.absoluteExpiresAt,
        policy,
      });
      const rotatedSessions = loaded.state.sessions.map((item) =>
        item.familyId === family.familyId && item.status === 'active'
          ? revokeSession(item, now, 'session_rotation')
          : item
      );
      const next = nextAuthorityState(loaded.state, {
        deviceFamilies: loaded.state.deviceFamilies.map((item) =>
          item.familyId === family.familyId ? nextFamily : item
        ),
        deviceGrants: retainedGrants,
        sessions: pruneSessionHistory([...rotatedSessions, session]),
      });
      const committed = await this.core.commit(loaded.state, next);
      if (committed === 'conflict') continue;
      if (committed === 'unavailable') return rejected('authority_store_unavailable');
      return accepted('renewed', {
        operatorId: family.operatorId,
        deviceFamilyId: family.familyId,
        acceptedDeviceGeneration: presentedGrant.generation,
        acceptedVia,
        deviceGeneration: generation,
        deviceSecret: nextDeviceSecret,
        sessionId,
        sessionSecret,
        csrfToken,
      });
    }
    return rejected('authority_store_conflict');
  }

  private async recoverPredecessorRenewal(
    loaded: Extract<Awaited<ReturnType<AuthorityCore['loadRegular']>>, { ok: true }>,
    family: OperatorDeviceFamily,
    predecessor: OperatorDeviceGrant,
    presentedSecret: OpaqueAuthoritySecret,
    now: number
  ): Promise<HostedAccessResult<RenewedCredentials, 'renewed'> | 'retry'> {
    const current = loaded.state.deviceGrants.find(
      ({ familyId, status }) => familyId === family.familyId && status === 'current'
    );
    const session = loaded.state.sessions.find(
      ({ familyId, deviceGeneration, status }) =>
        familyId === family.familyId &&
        deviceGeneration === current?.generation &&
        status === 'active'
    );
    if (
      current === undefined ||
      current.renewedFromGrantId !== predecessor.grantId ||
      current.generation !== predecessor.generation + 1 ||
      session === undefined
    ) {
      const committed = await this.core.commit(
        loaded.state,
        revokeDeviceFamily(loaded.state, family.familyId, now, 'predecessor_replay_non_monotonic')
      );
      if (committed === 'conflict') return 'retry';
      if (committed === 'unavailable') return rejected('authority_store_unavailable');
      return rejected('device_family_revoked');
    }

    const deviceSecret = await this.core.deriveAuthoritySecret({
      key: loaded.keyring.hashKey,
      purpose: 'renewed-device-grant',
      sourceSecret: presentedSecret,
      context: `${current.grantId}:${current.generation}`,
    });
    const sessionSecret = await this.core.deriveAuthoritySecret({
      key: loaded.keyring.hashKey,
      purpose: 'renewed-session',
      sourceSecret: presentedSecret,
      context: `${session.sessionId}:${session.deviceGeneration}`,
    });
    const [deviceHash, sessionHash] = await Promise.all([
      this.core.dependencies.crypto.keyedHash({
        key: loaded.keyring.hashKey,
        purpose: 'device-grant',
        secret: deviceSecret,
      }),
      this.core.dependencies.crypto.keyedHash({
        key: loaded.keyring.hashKey,
        purpose: 'operator-session',
        secret: sessionSecret,
      }),
    ]);
    if (
      !(await this.core.dependencies.crypto.secureEqual(deviceHash, current.secretHash)) ||
      !(await this.core.dependencies.crypto.secureEqual(sessionHash, session.secretHash))
    ) {
      return rejected('authority_state_corrupt');
    }

    const remaining = predecessor.predecessorUsesRemaining - 1;
    const consumedPredecessor: OperatorDeviceGrant =
      remaining === 0
        ? Object.freeze({
            ...predecessor,
            status: 'retired',
            predecessorGraceExpiresAt: null,
            predecessorUsesRemaining: 0,
            retiredAt: now,
          })
        : Object.freeze({
            ...predecessor,
            predecessorUsesRemaining: remaining,
          });
    const next = nextAuthorityState(loaded.state, {
      deviceGrants: loaded.state.deviceGrants.map((grant) =>
        grant.grantId === predecessor.grantId ? consumedPredecessor : grant
      ),
    });
    const committed = await this.core.commit(loaded.state, next);
    if (committed === 'conflict') return 'retry';
    if (committed === 'unavailable') return rejected('authority_store_unavailable');
    const csrfToken = await this.core.dependencies.crypto.deriveCsrf({
      key: loaded.keyring.csrfKey,
      sessionId: session.sessionId,
      sessionSecret,
    });
    return accepted('renewed', {
      operatorId: family.operatorId,
      deviceFamilyId: family.familyId,
      acceptedDeviceGeneration: predecessor.generation,
      acceptedVia: 'predecessor',
      deviceGeneration: current.generation,
      deviceSecret,
      sessionId: session.sessionId,
      sessionSecret,
      csrfToken,
    });
  }

  async authenticate(
    binding: AuthorityBinding,
    sessionSecret: OpaqueAuthoritySecret
  ): Promise<HostedAccessResult<AuthenticatedOperator, 'authenticated'>> {
    assertAuthorityBinding(binding);
    const result = await this.authenticateAndTouch(binding, sessionSecret);
    if (!result.ok) return result;
    return accepted('authenticated', result.value.identity);
  }

  async bootstrapSession(
    binding: AuthorityBinding,
    sessionSecret: OpaqueAuthoritySecret
  ): Promise<
    HostedAccessResult<
      AuthenticatedOperator & { readonly csrfToken: CsrfToken },
      'session_bootstrapped'
    >
  > {
    assertAuthorityBinding(binding);
    const result = await this.authenticateAndTouch(binding, sessionSecret);
    if (!result.ok) return result;
    const loaded = await this.core.loadRegular(binding);
    if (!loaded.ok) return loaded;
    const current = loaded.state.sessions.find(
      ({ sessionId, status }) =>
        sessionId === result.value.identity.sessionId && status === 'active'
    );
    if (current === undefined) return rejected('session_invalid');
    const csrfToken = await this.core.dependencies.crypto.deriveCsrf({
      key: loaded.keyring.csrfKey,
      sessionId: current.sessionId,
      sessionSecret,
    });
    return accepted('session_bootstrapped', {
      ...result.value.identity,
      csrfToken,
    });
  }

  async verifyCsrf(
    binding: AuthorityBinding,
    sessionSecret: OpaqueAuthoritySecret,
    presentedCsrf: CsrfToken
  ): Promise<HostedAccessResult<AuthenticatedOperator, 'csrf_verified'>> {
    assertAuthorityBinding(binding);
    const validated = await this.validateSessionWithoutTouch(binding, sessionSecret);
    if (!validated.ok) return validated;
    const expectedCsrf = await this.core.dependencies.crypto.deriveCsrf({
      key: validated.value.keyring.csrfKey,
      sessionId: validated.value.session.sessionId,
      sessionSecret,
    });
    if (!(await this.core.dependencies.crypto.secureEqual(expectedCsrf, presentedCsrf))) {
      return rejected('csrf_invalid');
    }
    const touched = await this.authenticateAndTouch(binding, sessionSecret);
    if (!touched.ok) return touched;
    return accepted('csrf_verified', touched.value.identity);
  }

  async logout(
    binding: AuthorityBinding,
    sessionSecret: OpaqueAuthoritySecret
  ): Promise<HostedAccessResult<{ readonly sessionId: string }, 'logged_out'>> {
    assertAuthorityBinding(binding);
    for (
      let attempt = 0;
      attempt < this.core.dependencies.policy.compareAndSwapAttempts;
      attempt += 1
    ) {
      const loaded = await this.core.loadRegular(binding);
      if (!loaded.ok) return loaded;
      const session = await this.findSession(loaded, sessionSecret);
      if (session?.status !== 'active') return rejected('session_invalid');
      const next = nextAuthorityState(loaded.state, {
        sessions: loaded.state.sessions.map((item) =>
          item.sessionId === session.sessionId
            ? revokeSession(item, this.core.now(), 'logout')
            : item
        ),
      });
      const committed = await this.core.commit(loaded.state, next);
      if (committed === 'conflict') continue;
      if (committed === 'unavailable') return rejected('authority_store_unavailable');
      return accepted('logged_out', { sessionId: session.sessionId });
    }
    return rejected('authority_store_conflict');
  }

  async forgetDevice(
    binding: AuthorityBinding,
    sessionSecret: OpaqueAuthoritySecret
  ): Promise<HostedAccessResult<{ readonly deviceFamilyId: string }, 'device_forgotten'>> {
    assertAuthorityBinding(binding);
    for (
      let attempt = 0;
      attempt < this.core.dependencies.policy.compareAndSwapAttempts;
      attempt += 1
    ) {
      const loaded = await this.core.loadRegular(binding);
      if (!loaded.ok) return loaded;
      const session = await this.findSession(loaded, sessionSecret);
      if (session?.status !== 'active') return rejected('session_invalid');
      const next = revokeDeviceFamily(
        loaded.state,
        session.familyId,
        this.core.now(),
        'forget_device'
      );
      const committed = await this.core.commit(loaded.state, next);
      if (committed === 'conflict') continue;
      if (committed === 'unavailable') return rejected('authority_store_unavailable');
      return accepted('device_forgotten', { deviceFamilyId: session.familyId });
    }
    return rejected('authority_store_conflict');
  }

  private async authenticateAndTouch(
    binding: AuthorityBinding,
    sessionSecret: OpaqueAuthoritySecret
  ): Promise<
    HostedAccessResult<
      {
        readonly identity: AuthenticatedOperator;
        readonly session: OperatorSession;
      },
      'authenticated'
    >
  > {
    for (
      let attempt = 0;
      attempt < this.core.dependencies.policy.compareAndSwapAttempts;
      attempt += 1
    ) {
      const loaded = await this.core.loadRegular(binding);
      if (!loaded.ok) return loaded;
      const session = await this.findSession(loaded, sessionSecret);
      if (session?.status !== 'active') return rejected('session_invalid');
      const family = loaded.state.deviceFamilies.find(
        ({ familyId }) => familyId === session.familyId
      );
      if (family?.status !== 'active') return rejected('device_family_revoked');
      const now = this.core.now();
      const familyExpiry = classifyFamilyExpiry(family, now);
      if (familyExpiry !== null) {
        const next = revokeDeviceFamily(loaded.state, family.familyId, now, familyExpiry);
        const committed = await this.core.commit(loaded.state, next);
        if (committed === 'conflict') continue;
        if (committed === 'unavailable') {
          return rejected('authority_store_unavailable');
        }
        return rejected(familyExpiry);
      }
      const expiry = classifySessionExpiry(session, now);
      if (expiry !== null) {
        const next = nextAuthorityState(loaded.state, {
          sessions: loaded.state.sessions.map((item) =>
            item.sessionId === session.sessionId ? revokeSession(item, now, expiry) : item
          ),
        });
        const committed = await this.core.commit(loaded.state, next);
        if (committed === 'conflict') continue;
        if (committed === 'unavailable') return rejected('authority_store_unavailable');
        return rejected(expiry);
      }
      const touched: OperatorSession = Object.freeze({
        ...session,
        lastUsedAt: now,
        deadlines: Object.freeze({
          ...session.deadlines,
          idleExpiresAt: extendIdleDeadline(
            now,
            this.core.dependencies.policy.sessionIdleTtlMs,
            session.deadlines.absoluteExpiresAt
          ),
        }),
      });
      const next = nextAuthorityState(loaded.state, {
        sessions: loaded.state.sessions.map((item) =>
          item.sessionId === session.sessionId ? touched : item
        ),
      });
      const committed = await this.core.commit(loaded.state, next);
      if (committed === 'conflict') continue;
      if (committed === 'unavailable') return rejected('authority_store_unavailable');
      return accepted('authenticated', {
        identity: {
          operatorId: session.operatorId,
          deviceFamilyId: session.familyId,
          sessionId: session.sessionId,
        },
        session: touched,
      });
    }
    return rejected('authority_store_conflict');
  }

  private async validateSessionWithoutTouch(
    binding: AuthorityBinding,
    sessionSecret: OpaqueAuthoritySecret
  ): Promise<
    HostedAccessResult<
      {
        readonly identity: AuthenticatedOperator;
        readonly session: OperatorSession;
        readonly keyring: Extract<
          Awaited<ReturnType<AuthorityCore['loadRegular']>>,
          { ok: true }
        >['keyring'];
      },
      'authenticated'
    >
  > {
    for (
      let attempt = 0;
      attempt < this.core.dependencies.policy.compareAndSwapAttempts;
      attempt += 1
    ) {
      const loaded = await this.core.loadRegular(binding);
      if (!loaded.ok) return loaded;
      const session = await this.findSession(loaded, sessionSecret);
      if (session?.status !== 'active') return rejected('session_invalid');
      const family = loaded.state.deviceFamilies.find(
        ({ familyId }) => familyId === session.familyId
      );
      if (family?.status !== 'active') return rejected('device_family_revoked');
      const now = this.core.now();
      const familyExpiry = classifyFamilyExpiry(family, now);
      if (familyExpiry !== null) {
        const committed = await this.core.commit(
          loaded.state,
          revokeDeviceFamily(loaded.state, family.familyId, now, familyExpiry)
        );
        if (committed === 'conflict') continue;
        if (committed === 'unavailable') {
          return rejected('authority_store_unavailable');
        }
        return rejected(familyExpiry);
      }
      const expiry = classifySessionExpiry(session, now);
      if (expiry !== null) {
        const committed = await this.core.commit(
          loaded.state,
          nextAuthorityState(loaded.state, {
            sessions: loaded.state.sessions.map((item) =>
              item.sessionId === session.sessionId ? revokeSession(item, now, expiry) : item
            ),
          })
        );
        if (committed === 'conflict') continue;
        if (committed === 'unavailable') {
          return rejected('authority_store_unavailable');
        }
        return rejected(expiry);
      }
      return accepted('authenticated', {
        identity: {
          operatorId: session.operatorId,
          deviceFamilyId: session.familyId,
          sessionId: session.sessionId,
        },
        session,
        keyring: loaded.keyring,
      });
    }
    return rejected('authority_store_conflict');
  }

  private async findSession(
    loaded: Extract<Awaited<ReturnType<AuthorityCore['loadRegular']>>, { ok: true }>,
    sessionSecret: OpaqueAuthoritySecret
  ): Promise<OperatorSession | null> {
    const presentedHash = await this.core.dependencies.crypto.keyedHash({
      key: loaded.keyring.hashKey,
      purpose: 'operator-session',
      secret: sessionSecret,
    });
    return await findHashMatch(this.core.dependencies.crypto, loaded.state.sessions, presentedHash);
  }
}

function classifyFamilyExpiry(
  family: OperatorDeviceFamily,
  now: number
): 'device_absolute_expired' | 'device_idle_expired' | null {
  if (now >= family.absoluteExpiresAt) return 'device_absolute_expired';
  if (now >= family.idleExpiresAt) return 'device_idle_expired';
  return null;
}

function classifySessionExpiry(
  session: OperatorSession,
  now: number
): 'session_absolute_expired' | 'session_idle_expired' | 'session_renewal_required' | null {
  if (now >= session.deadlines.absoluteExpiresAt) return 'session_absolute_expired';
  if (now >= session.deadlines.idleExpiresAt) return 'session_idle_expired';
  if (now >= session.deadlines.renewalExpiresAt) return 'session_renewal_required';
  return null;
}

function classifyPresentedGrant(
  grant: OperatorDeviceGrant,
  now: number
): 'current' | 'predecessor' | null {
  if (grant.status === 'current') return 'current';
  if (
    grant.status === 'predecessor' &&
    grant.predecessorGraceExpiresAt !== null &&
    now < grant.predecessorGraceExpiresAt &&
    grant.predecessorUsesRemaining > 0
  ) {
    return 'predecessor';
  }
  return null;
}

function rotateCurrentGeneration(
  grants: readonly OperatorDeviceGrant[],
  familyId: string,
  presentedGrantId: string,
  now: number,
  predecessorGraceMs: number,
  predecessorMaxUses: number
): readonly OperatorDeviceGrant[] {
  return grants.map((grant) => {
    if (grant.familyId !== familyId) return grant;
    if (grant.status === 'current' && grant.grantId === presentedGrantId) {
      return Object.freeze({
        ...grant,
        status: 'predecessor' as const,
        predecessorGraceExpiresAt: Math.min(
          addDuration(now, predecessorGraceMs),
          grant.renewalExpiresAt
        ),
        predecessorUsesRemaining: predecessorMaxUses,
      });
    }
    if (grant.status === 'predecessor') {
      return Object.freeze({
        ...grant,
        status: 'retired' as const,
        predecessorGraceExpiresAt: null,
        predecessorUsesRemaining: 0,
        retiredAt: now,
      });
    }
    return grant;
  });
}

const MAX_RETAINED_SESSION_RECORDS = 64;

function pruneSessionHistory(sessions: readonly OperatorSession[]): readonly OperatorSession[] {
  if (sessions.length <= MAX_RETAINED_SESSION_RECORDS) return sessions;
  const active = sessions.filter(({ status }) => status === 'active');
  const inactive = [...sessions]
    .reverse()
    .filter(({ status }) => status !== 'active')
    .sort((left, right) => right.issuedAt - left.issuedAt);
  return [
    ...inactive.slice(0, Math.max(0, MAX_RETAINED_SESSION_RECORDS - active.length)),
    ...active,
  ];
}

function retainRecentGenerations(
  grants: readonly OperatorDeviceGrant[],
  familyId: string,
  retainedCount: number
): readonly OperatorDeviceGrant[] {
  const familyGrants = grants
    .filter((grant) => grant.familyId === familyId)
    .sort((left, right) => right.generation - left.generation);
  const retainedIds = new Set(familyGrants.slice(0, retainedCount).map(({ grantId }) => grantId));
  return grants.filter((grant) => grant.familyId !== familyId || retainedIds.has(grant.grantId));
}

export function revokeDeviceFamily(
  state: HostedAccessAuthorityState,
  familyId: string,
  now: number,
  reason: string | HostedAccessRejectionCode
): HostedAccessAuthorityState {
  return nextAuthorityState(state, {
    deviceFamilies: state.deviceFamilies.map((family) =>
      family.familyId === familyId
        ? Object.freeze({
            ...family,
            status: 'revoked' as const,
            revokedAt: now,
            revocationReason: reason,
          })
        : family
    ),
    deviceGrants: state.deviceGrants.map((grant) =>
      grant.familyId === familyId
        ? Object.freeze({
            ...grant,
            status: 'revoked' as const,
            predecessorGraceExpiresAt: null,
            predecessorUsesRemaining: 0,
            revokedAt: now,
            revocationReason: reason,
          })
        : grant
    ),
    sessions: state.sessions.map((session) =>
      session.familyId === familyId && session.status === 'active'
        ? revokeSession(session, now, reason)
        : session
    ),
  });
}

function revokeSession(session: OperatorSession, now: number, reason: string): OperatorSession {
  return Object.freeze({
    ...session,
    status: 'revoked',
    revokedAt: now,
    revocationReason: reason,
  });
}
