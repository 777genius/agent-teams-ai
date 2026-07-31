declare const hostedIdentityBrand: unique symbol;

type HostedIdentityString<Name extends string> = string & {
  readonly [hostedIdentityBrand]: Name;
};

export type UserId = HostedIdentityString<'UserId'>;
export type HostedSessionId = HostedIdentityString<'HostedSessionId'>;
export type OidcLoginAttemptId = HostedIdentityString<'OidcLoginAttemptId'>;
export type AuditEventId = HostedIdentityString<'AuditEventId'>;
export type HostedWorkspaceId = HostedIdentityString<'HostedWorkspaceId'>;

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]*_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

function parseHostedIdentityId<Name extends string>(
  value: unknown,
  errorName: string
): HostedIdentityString<Name> {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`hosted-access-${errorName}-invalid`);
  }
  return value as HostedIdentityString<Name>;
}

export const parseUserId = (value: unknown): UserId =>
  parseHostedIdentityId<'UserId'>(value, 'user-id');
export const parseHostedSessionId = (value: unknown): HostedSessionId =>
  parseHostedIdentityId<'HostedSessionId'>(value, 'hosted-session-id');
export const parseOidcLoginAttemptId = (value: unknown): OidcLoginAttemptId =>
  parseHostedIdentityId<'OidcLoginAttemptId'>(value, 'oidc-login-attempt-id');
export const parseAuditEventId = (value: unknown): AuditEventId =>
  parseHostedIdentityId<'AuditEventId'>(value, 'audit-event-id');
export const parseHostedWorkspaceId = (value: unknown): HostedWorkspaceId => {
  if (typeof value !== 'string' || !/^workspace_[a-f0-9]{32}$/.test(value)) {
    throw new TypeError('hosted-access-workspace-id-invalid');
  }
  return value as HostedWorkspaceId;
};

export const HOSTED_AUTH_MODES = Object.freeze(['personal', 'oidc'] as const);
export type HostedAuthMode = (typeof HOSTED_AUTH_MODES)[number];

export const HOSTED_ROLES = Object.freeze(['owner', 'admin', 'member', 'viewer'] as const);
export type HostedRole = (typeof HOSTED_ROLES)[number];

export const HOSTED_PERMISSIONS = Object.freeze([
  'hosted.query',
  'hosted.events',
  'hosted.command',
  'hosted.manage',
  'workspace.manage',
  'identity.manage',
] as const);
export type HostedPermission = (typeof HOSTED_PERMISSIONS)[number];

export interface HostedPrincipal {
  readonly userId: UserId;
  readonly displayName: string;
  readonly role: HostedRole;
  readonly permissions: readonly HostedPermission[];
  readonly authenticationMethod: 'desktop-local-owner' | 'personal' | 'oidc';
  readonly sessionId: HostedSessionId | null;
}

export interface HostedAuthStatus {
  readonly mode: HostedAuthMode;
  readonly authenticated: boolean;
  readonly principal: HostedPrincipal | null;
  /**
   * Returned only in a JSON response after authentication. The renderer keeps
   * this value in module memory and never persists it.
   */
  readonly csrfToken: string | null;
  readonly oidcProviderName: string | null;
}

export interface PersonalPairingRequest {
  readonly pairingCode: string;
}

export interface HostedWorkspace {
  /** Opaque, immutable identifier safe to expose to a hosted browser. */
  readonly workspaceId: HostedWorkspaceId;
  readonly displayName: string;
  readonly registeredAt: number;
  readonly registeredBy: UserId | null;
}

export interface BeginLoginResult {
  readonly redirectUrl: string;
  readonly attemptId: OidcLoginAttemptId;
  readonly state: string;
}

export interface CompleteLoginInput {
  readonly callbackUrl: URL;
  readonly expectedState: string;
  readonly attemptId: OidcLoginAttemptId;
}

export interface IdentityProviderLogoutResult {
  readonly redirectUrl: string | null;
}

export const HOSTED_AUTH_ROUTES = Object.freeze({
  status: '/api/auth/status',
  pair: '/api/auth/personal/pair',
  login: '/api/auth/oidc/login',
  callback: '/api/auth/oidc/callback',
  logout: '/api/auth/logout',
  forgetDevice: '/api/auth/personal/forget-device',
  backchannelLogout: '/api/auth/oidc/backchannel-logout',
} as const);

export const HOSTED_AUTH_HEADERS = Object.freeze({
  csrf: 'x-agent-teams-csrf',
} as const);
