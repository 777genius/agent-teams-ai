import {
  type HostedAccessRejectionCode,
  type HostedAuthMode,
  type HostedPrincipal,
  type OidcLoginAttemptId,
  type OpaqueAuthoritySecret,
  parseCsrfToken,
  parseOpaqueAuthoritySecret,
} from '../../contracts';

import { principal } from './HostedIdentityService';

import type { AuthorityBinding, PairingCredentials } from '../../contracts';
import type { HostedAccessAuthority } from './HostedAccessAuthority';
import type {
  AuthenticateHostedSessionResult,
  HostedIdentityService,
  IssuedHostedSession,
} from './HostedIdentityService';
import type { HostedAuditEvent, HostedPersonalOwnerRecord } from './identityPorts';

export interface HostedAuthenticationContext {
  readonly principal: HostedPrincipal;
  readonly sessionSecret: string;
  readonly csrfToken: string;
}

export type HostedProviderAuthenticationResult =
  | {
      readonly authenticated: true;
      readonly context: HostedAuthenticationContext;
      readonly replacementDeviceSecret: string | null;
    }
  | {
      readonly authenticated: false;
      readonly reason: string;
    };

export interface HostedAuthenticationProvider {
  readonly mode: HostedAuthMode;
  readonly displayName: string;
  authenticate(input: {
    readonly sessionSecret?: string;
    readonly deviceSecret?: string;
    readonly allowRenewal: boolean;
    readonly sourceIp?: string;
  }): Promise<HostedProviderAuthenticationResult>;
  verifyCsrf(context: HostedAuthenticationContext, presented: string): Promise<boolean>;
  logout(input: {
    readonly context: HostedAuthenticationContext;
    readonly global: boolean;
    readonly postLogoutRedirectUri: string;
    readonly sourceIp?: string;
  }): Promise<{ readonly redirectUrl: string | null }>;
  auditAuthorization(
    input: Parameters<HostedIdentityService['auditAuthorization']>[0]
  ): Promise<void>;
}

export type HostedPersonalPairResult =
  | {
      readonly ok: true;
      readonly code: 'paired';
      readonly value: PairingCredentials & {
        readonly principal: HostedPrincipal;
      };
    }
  | {
      readonly ok: false;
      readonly code: string;
    };

export interface PersonalAuthenticationCapability extends HostedAuthenticationProvider {
  readonly mode: 'personal';
  pair(pairingSecret: OpaqueAuthoritySecret): Promise<HostedPersonalPairResult>;
  forgetDevice(
    context: HostedAuthenticationContext
  ): ReturnType<HostedAccessAuthority['forgetDevice']>;
  auditPersonalAuthentication(input: {
    readonly userId: HostedPrincipal['userId'] | null;
    readonly action:
      | 'auth.personal.pair'
      | 'auth.personal.renew'
      | 'auth.personal.logout'
      | 'auth.personal.forget-device';
    readonly outcome: HostedAuditEvent['outcome'];
    readonly sourceIp?: string;
    readonly reason?: string;
  }): Promise<void>;
}

export interface OidcAuthenticationCapability extends HostedAuthenticationProvider {
  readonly mode: 'oidc';
  beginLogin(returnTo: string): ReturnType<HostedIdentityService['beginOidcLogin']>;
  completeLogin(input: {
    readonly callbackUrl: URL;
    readonly expectedState: string;
    readonly attemptId: OidcLoginAttemptId;
    readonly sourceIp?: string;
  }): Promise<IssuedHostedSession>;
  backchannelLogout(token: string): Promise<number>;
}

function personalPrincipal(owner: HostedPersonalOwnerRecord): HostedPrincipal {
  return principal(owner.user.userId, owner.user.displayName, 'owner', null, 'personal');
}

function assertPersonalOwnerActive(owner: HostedPersonalOwnerRecord): void {
  if (owner.user.status !== 'active') throw new Error('personal_user_disabled');
}

function assertPersonalOwnerBinding(
  owner: HostedPersonalOwnerRecord,
  expectedOperatorId: HostedPersonalOwnerRecord['operatorId']
): void {
  if (owner.operatorId !== expectedOperatorId) {
    throw new Error('personal_identity_binding_mismatch');
  }
}

const PERSONAL_AUTHORITY_UNAVAILABLE_CODES = new Set<HostedAccessRejectionCode>([
  'authority_state_corrupt',
  'authority_store_conflict',
  'authority_store_unavailable',
  'challenge_delivery_unavailable',
  'keyring_corrupt',
  'keyring_missing',
  'keyring_mismatch',
  'keyring_unavailable',
  'pairing_drain_unconfirmed',
  'reset_in_progress',
  'reset_stage_unavailable',
  'restore_binding_mismatch',
]);

function personalAuthorityUnavailable(code: HostedAccessRejectionCode): boolean {
  return PERSONAL_AUTHORITY_UNAVAILABLE_CODES.has(code);
}

function throwPersonalAuthorityUnavailable(cause: unknown): never {
  throw new Error('personal_authority_unavailable', {
    cause: cause instanceof Error ? cause : new Error(String(cause)),
  });
}

export class HostedPersonalAuthenticationProvider implements PersonalAuthenticationCapability {
  readonly mode = 'personal' as const;
  readonly displayName = 'Personal pairing';

  constructor(
    private readonly binding: AuthorityBinding,
    private readonly authority: HostedAccessAuthority,
    private readonly identities: HostedIdentityService
  ) {}

  async pair(pairingSecret: OpaqueAuthoritySecret): Promise<HostedPersonalPairResult> {
    let owner: HostedPersonalOwnerRecord | null = null;
    let result: Awaited<ReturnType<HostedAccessAuthority['pair']>>;
    try {
      result = await this.authority.pair(this.binding, pairingSecret, {
        prepare: async (proposedOperatorId) => {
          try {
            owner = await this.identities.ensurePersonalOwner(proposedOperatorId);
            assertPersonalOwnerActive(owner);
            return owner.operatorId;
          } catch (error) {
            if (error instanceof Error && error.message === 'personal_user_disabled') throw error;
            throw new Error('personal_identity_storage_unavailable', { cause: error });
          }
        },
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'personal_identity_storage_unavailable' ||
          error.message === 'personal_user_disabled')
      ) {
        throw error;
      }
      throwPersonalAuthorityUnavailable(error);
    }
    if (!result.ok) {
      if (personalAuthorityUnavailable(result.code)) {
        throwPersonalAuthorityUnavailable(new Error(result.code));
      }
      return result;
    }
    if (owner === null) throw new Error('personal_identity_storage_unavailable');
    return Object.freeze({
      ...result,
      value: Object.freeze({
        ...result.value,
        principal: personalPrincipal(owner),
      }),
    });
  }

  async authenticate(input: {
    readonly sessionSecret?: string;
    readonly deviceSecret?: string;
    readonly allowRenewal: boolean;
  }): Promise<HostedProviderAuthenticationResult> {
    if (input.sessionSecret) {
      let parsedSessionSecret: OpaqueAuthoritySecret | null = null;
      try {
        parsedSessionSecret = parseOpaqueAuthoritySecret(input.sessionSecret);
      } catch {
        // An invalid short-session cookie may still be recovered by a valid
        // durable device credential.
      }
      if (parsedSessionSecret !== null) {
        let result: Awaited<ReturnType<HostedAccessAuthority['bootstrapSession']>>;
        try {
          result = await this.authority.bootstrapSession(
            this.binding,
            parsedSessionSecret,
            input.allowRenewal
          );
        } catch (error) {
          throwPersonalAuthorityUnavailable(error);
        }
        if (result.ok) {
          let owner: HostedPersonalOwnerRecord;
          try {
            owner = await this.identities.ensurePersonalOwner(result.value.operatorId);
            assertPersonalOwnerBinding(owner, result.value.operatorId);
          } catch (error) {
            throw new Error('personal_identity_storage_unavailable', { cause: error });
          }
          if (owner.user.status !== 'active') {
            return Object.freeze({ authenticated: false, reason: 'user-disabled' });
          }
          return Object.freeze({
            authenticated: true,
            context: Object.freeze({
              principal: personalPrincipal(owner),
              sessionSecret: input.sessionSecret,
              csrfToken: result.value.csrfToken,
            }),
            replacementDeviceSecret: null,
          });
        }
        if (personalAuthorityUnavailable(result.code)) {
          throwPersonalAuthorityUnavailable(new Error(result.code));
        }
      }
    }
    if (!input.allowRenewal || !input.deviceSecret) {
      return Object.freeze({ authenticated: false, reason: 'session_invalid' });
    }
    let parsedDeviceSecret: OpaqueAuthoritySecret;
    try {
      parsedDeviceSecret = parseOpaqueAuthoritySecret(input.deviceSecret);
    } catch {
      return Object.freeze({ authenticated: false, reason: 'device_invalid' });
    }
    let owner: HostedPersonalOwnerRecord | null = null;
    try {
      const renewed = await this.authority.renew(this.binding, parsedDeviceSecret, {
        prepare: async (operatorId) => {
          try {
            owner = await this.identities.ensurePersonalOwner(operatorId);
            assertPersonalOwnerBinding(owner, operatorId);
            assertPersonalOwnerActive(owner);
            return owner.operatorId;
          } catch (error) {
            if (error instanceof Error && error.message === 'personal_user_disabled') throw error;
            throw new Error('personal_identity_storage_unavailable', { cause: error });
          }
        },
      });
      if (!renewed.ok) {
        if (personalAuthorityUnavailable(renewed.code)) {
          throwPersonalAuthorityUnavailable(new Error(renewed.code));
        }
        return Object.freeze({ authenticated: false, reason: renewed.code });
      }
      if (owner === null) throw new Error('personal_identity_storage_unavailable');
      return Object.freeze({
        authenticated: true,
        context: Object.freeze({
          principal: personalPrincipal(owner),
          sessionSecret: renewed.value.sessionSecret,
          csrfToken: renewed.value.csrfToken,
        }),
        replacementDeviceSecret: renewed.value.deviceSecret,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'personal_identity_storage_unavailable') {
        throw error;
      }
      if (error instanceof Error && error.message === 'personal_user_disabled') {
        return Object.freeze({ authenticated: false, reason: 'user-disabled' });
      }
      if (error instanceof Error && error.message === 'personal_authority_unavailable') {
        throw error;
      }
      throwPersonalAuthorityUnavailable(error);
    }
  }

  async verifyCsrf(context: HostedAuthenticationContext, presented: string): Promise<boolean> {
    let sessionSecret: OpaqueAuthoritySecret;
    let csrfToken: ReturnType<typeof parseCsrfToken>;
    try {
      sessionSecret = parseOpaqueAuthoritySecret(context.sessionSecret);
      csrfToken = parseCsrfToken(presented);
    } catch {
      return false;
    }
    let result: Awaited<ReturnType<HostedAccessAuthority['verifyCsrf']>>;
    try {
      result = await this.authority.verifyCsrf(this.binding, sessionSecret, csrfToken);
    } catch (error) {
      throwPersonalAuthorityUnavailable(error);
    }
    if (!result.ok && personalAuthorityUnavailable(result.code)) {
      throwPersonalAuthorityUnavailable(new Error(result.code));
    }
    return result.ok;
  }

  async logout(input: {
    readonly context: HostedAuthenticationContext;
  }): Promise<{ readonly redirectUrl: null }> {
    const result = await this.authority.logout(
      this.binding,
      parseOpaqueAuthoritySecret(input.context.sessionSecret)
    );
    if (!result.ok && result.code !== 'session_invalid') {
      throw new Error('personal_logout_unavailable', {
        cause: new Error(result.code),
      });
    }
    return Object.freeze({ redirectUrl: null });
  }

  forgetDevice(
    context: HostedAuthenticationContext
  ): ReturnType<HostedAccessAuthority['forgetDevice']> {
    return this.authority.forgetDevice(
      this.binding,
      parseOpaqueAuthoritySecret(context.sessionSecret)
    );
  }

  auditAuthorization(
    input: Parameters<HostedIdentityService['auditAuthorization']>[0]
  ): Promise<void> {
    return this.identities.auditAuthorization(input);
  }

  auditPersonalAuthentication(
    input: Parameters<HostedIdentityService['auditPersonalAuthentication']>[0]
  ): Promise<void> {
    return this.identities.auditPersonalAuthentication(input);
  }
}

export class HostedOidcAuthenticationProvider implements OidcAuthenticationCapability {
  readonly mode = 'oidc' as const;

  constructor(
    readonly displayName: string,
    private readonly identities: HostedIdentityService
  ) {}

  beginLogin(returnTo: string): ReturnType<HostedIdentityService['beginOidcLogin']> {
    return this.identities.beginOidcLogin(returnTo);
  }

  completeLogin(
    input: Parameters<HostedIdentityService['completeOidcLogin']>[0]
  ): Promise<IssuedHostedSession> {
    return this.identities.completeOidcLogin(input);
  }

  backchannelLogout(token: string): Promise<number> {
    return this.identities.backchannelLogout(token);
  }

  async authenticate(input: {
    readonly sessionSecret?: string;
    readonly sourceIp?: string;
    readonly allowRenewal?: boolean;
  }): Promise<HostedProviderAuthenticationResult> {
    if (!input.sessionSecret) {
      return Object.freeze({ authenticated: false, reason: 'invalid' });
    }
    let result: AuthenticateHostedSessionResult;
    try {
      result = await this.identities.authenticate(
        input.sessionSecret,
        input.sourceIp,
        input.allowRenewal ?? true
      );
    } catch (error) {
      // Invalid, expired and revoked credentials are result values. Any throw
      // means the local authentication subsystem could not make a trustworthy
      // decision, so the HTTP boundary must fail unavailable instead of
      // silently treating an outage as an anonymous session.
      throw new Error('oidc_authentication_unavailable', { cause: error });
    }
    if (!result.authenticated) return result;
    return Object.freeze({
      authenticated: true,
      context: Object.freeze({
        principal: result.principal,
        sessionSecret: input.sessionSecret,
        csrfToken: result.csrfToken,
      }),
      replacementDeviceSecret: null,
    });
  }

  verifyCsrf(context: HostedAuthenticationContext, presented: string): Promise<boolean> {
    if (context.principal.sessionId === null) return Promise.resolve(false);
    return this.identities.verifyCsrf(
      context.principal.sessionId,
      context.sessionSecret,
      presented
    );
  }

  logout(input: {
    readonly context: HostedAuthenticationContext;
    readonly global: boolean;
    readonly postLogoutRedirectUri: string;
    readonly sourceIp?: string;
  }): Promise<{ readonly redirectUrl: string | null }> {
    return this.identities.logout({
      sessionSecret: input.context.sessionSecret,
      global: input.global,
      postLogoutRedirectUri: input.postLogoutRedirectUri,
      sourceIp: input.sourceIp,
    });
  }

  auditAuthorization(
    input: Parameters<HostedIdentityService['auditAuthorization']>[0]
  ): Promise<void> {
    return this.identities.auditAuthorization(input);
  }
}
