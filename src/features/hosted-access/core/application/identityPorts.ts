import type {
  AuditEventId,
  AuthKeyringId,
  BeginLoginResult,
  CompleteLoginInput,
  HostedAuthMode,
  HostedRole,
  HostedSessionId,
  HostedWorkspace,
  HostedWorkspaceId,
  IdentityProviderLogoutResult,
  OidcLoginAttemptId,
  OperatorId,
  UserId,
} from '../../contracts';
import type { HostedAccessAuthorityState } from '../domain';

export interface HostedUserRecord {
  readonly userId: UserId;
  readonly displayName: string;
  readonly status: 'active' | 'disabled';
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface HostedPersonalOwnerRecord {
  readonly operatorId: OperatorId;
  readonly user: HostedUserRecord;
}

export interface ExternalIdentityRecord {
  readonly issuer: string;
  readonly subject: string;
  readonly userId: UserId;
  readonly providerId: string;
  readonly createdAt: number;
  readonly lastAuthenticatedAt: number;
}

export interface HostedRoleSnapshot {
  readonly role: HostedRole;
  readonly source: 'personal-owner' | 'oidc-claim' | 'local-cli';
  readonly capturedAt: number;
}

export interface HostedLocalRoleAssignment {
  readonly userId: UserId;
  readonly role: HostedRole;
  readonly assignedAt: number;
  readonly assignedBy: 'local-cli';
}

export interface HostedWorkspaceRegistration extends HostedWorkspace {
  /** Local scanner identifier. It is never serialized to HTTP or SSE. */
  readonly runtimeWorkspaceId: string;
  readonly status: 'active' | 'disabled';
}

export interface HostedWorkspaceGrant {
  readonly userId: UserId;
  readonly workspaceId: HostedWorkspaceId;
  readonly runtimeWorkspaceId: string;
  readonly displayName: string;
  readonly grantGeneration: number;
  /** Fresh random revision on every grant/regrant; prevents revoke/regrant ABA. */
  readonly grantRevision: string;
  readonly grantedAt: number;
  readonly grantedBy: 'local-cli';
}

export interface HostedOperatorSessionRecord {
  readonly sessionId: HostedSessionId;
  readonly userId: UserId;
  readonly secretHash: string;
  readonly authenticationMethod: 'oidc';
  readonly providerId: string;
  readonly providerIssuer: string;
  readonly providerSubject: string;
  readonly providerSessionId: string | null;
  readonly roleSnapshot: HostedRoleSnapshot;
  readonly issuedAt: number;
  readonly lastUsedAt: number;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
  readonly status: 'active' | 'revoked';
  readonly revokedAt: number | null;
  readonly revocationReason: string | null;
}

export interface OidcLoginAttemptRecord {
  readonly attemptId: OidcLoginAttemptId;
  readonly providerId: string;
  readonly stateHash: string;
  readonly nonce: string;
  readonly pkceVerifierCiphertext: string;
  readonly returnTo: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly consumedAt: number | null;
}

export interface HostedAuditEvent {
  readonly eventId: AuditEventId;
  readonly occurredAt: number;
  readonly userId: UserId | null;
  readonly sessionId: HostedSessionId | null;
  readonly action: string;
  readonly outcome: 'success' | 'denied' | 'failure';
  readonly sourceIpHash: string | null;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export interface HostedAuthConfiguration {
  readonly mode: HostedAuthMode;
  readonly configuredAt: number;
  readonly resetGeneration: number;
  readonly secretsRotatedGeneration: number;
  readonly pendingPersonalKeyringId: AuthKeyringId | null;
}

export type HostedAuthModeResetResult =
  | 'committed'
  | 'mode_mismatch'
  | 'generation_not_newer'
  | 'authority_conflict';

export interface HostedIdentityRepositoryPort {
  readAuthConfiguration(): Promise<HostedAuthConfiguration | null>;
  resetAuthMode(input: {
    readonly currentMode: HostedAuthMode;
    readonly targetMode: HostedAuthMode;
    readonly resetGeneration: number;
    readonly resetAt: number;
    readonly expectedAuthorityRevision: number | null;
    readonly nextAuthorityState: HostedAccessAuthorityState;
    readonly pendingPersonalKeyringId: AuthKeyringId;
    readonly auditEvent: HostedAuditEvent;
  }): Promise<HostedAuthModeResetResult>;
  markAuthSecretsRotated(input: {
    readonly mode: HostedAuthMode;
    readonly resetGeneration: number;
    readonly pendingPersonalKeyringId: AuthKeyringId;
  }): Promise<boolean>;
  createOidcLoginAttempt(
    attempt: OidcLoginAttemptRecord
  ): Promise<'created' | 'conflict' | 'capacity'>;
  consumeOidcLoginAttempt(input: {
    readonly attemptId: OidcLoginAttemptId;
    readonly providerId: string;
    readonly stateHash: string;
    readonly now: number;
  }): Promise<OidcLoginAttemptRecord | null>;
  bindExternalIdentity(input: {
    readonly identity: Omit<ExternalIdentityRecord, 'userId'>;
    readonly proposedUser: HostedUserRecord;
  }): Promise<{ readonly user: HostedUserRecord; readonly identity: ExternalIdentityRecord }>;
  ensurePersonalOwner(input: {
    readonly user: HostedUserRecord;
    readonly operatorId: OperatorId;
  }): Promise<HostedPersonalOwnerRecord>;
  createSession(session: HostedOperatorSessionRecord): Promise<void>;
  findSessionBySecretHash(secretHash: string): Promise<HostedOperatorSessionRecord | null>;
  touchSession(input: {
    readonly sessionId: HostedSessionId;
    readonly expectedLastUsedAt: number;
    readonly lastUsedAt: number;
    readonly idleExpiresAt: number;
  }): Promise<boolean>;
  revokeSession(input: {
    readonly sessionId: HostedSessionId;
    readonly now: number;
    readonly reason: string;
  }): Promise<void>;
  applyBackchannelLogout(input: {
    readonly providerId: string;
    readonly issuer: string;
    readonly subject?: string;
    readonly providerSessionId?: string;
    readonly jti: string;
    readonly expiresAt: number;
    readonly consumedAt: number;
    readonly reason: string;
  }): Promise<{ readonly consumed: boolean; readonly revoked: number }>;
  getUser(userId: UserId): Promise<HostedUserRecord | null>;
  listUsers(): Promise<readonly HostedUserRecord[]>;
  setUserStatus(input: {
    readonly userId: UserId;
    readonly status: 'active' | 'disabled';
    readonly now: number;
  }): Promise<boolean>;
  getLocalRoleAssignment(userId: UserId): Promise<HostedLocalRoleAssignment | null>;
  setLocalRoleAssignment(assignment: HostedLocalRoleAssignment): Promise<void>;
  clearLocalRoleAssignment(userId: UserId): Promise<boolean>;
  isWorkspaceRegistered(runtimeWorkspaceId: string): Promise<boolean>;
  listWorkspaces(): Promise<readonly HostedWorkspaceRegistration[]>;
  registerWorkspace(input: {
    readonly runtimeWorkspaceId: string;
    readonly workspaceId: HostedWorkspaceId;
    readonly displayName: string;
    readonly registeredAt: number;
    readonly registeredBy: UserId | null;
  }): Promise<HostedWorkspaceRegistration>;
  disableWorkspace(runtimeWorkspaceId: string): Promise<boolean>;
  listWorkspaceGrants(input: {
    readonly userId: UserId;
    readonly grantGeneration: number;
  }): Promise<readonly HostedWorkspaceGrant[]>;
  grantWorkspace(input: {
    readonly userId: UserId;
    readonly runtimeWorkspaceId: string;
    readonly grantGeneration: number;
    readonly grantedAt: number;
    readonly grantedBy: 'local-cli';
  }): Promise<HostedWorkspaceGrant>;
  revokeWorkspaceGrant(input: {
    readonly userId: UserId;
    readonly runtimeWorkspaceId: string;
  }): Promise<boolean>;
  appendAudit(event: HostedAuditEvent): Promise<void>;
}

export interface HostedIdentityCryptoPort {
  randomId(
    kind: 'user' | 'session' | 'oidc-attempt' | 'audit-event' | 'workspace'
  ): Promise<string>;
  randomSecret(kind: 'session' | 'csrf'): Promise<string>;
  hashSecret(purpose: 'session' | 'oidc-state' | 'source-ip', secret: string): Promise<string>;
  deriveCsrf(sessionId: HostedSessionId, sessionSecret: string): Promise<string>;
  encryptLoginSecret(secret: string): Promise<string>;
  decryptLoginSecret(ciphertext: string): Promise<string>;
  secureEqual(left: string, right: string): Promise<boolean>;
}

export interface HostedAuthPathStat {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSocket(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * Process-owned host capabilities used by the production adapters. Keeping
 * these operations behind a port leaves feature composition independent of
 * Node and Electron while preserving durable file and cryptographic behavior.
 */
export interface HostedAuthHostPlatform {
  readonly uid: number | undefined;
  readonly pid: number;
  join(...segments: readonly string[]): string;
  dirname(path: string): string;
  isAbsolute(path: string): boolean;
  byteLength(value: string): number;
  mkdir(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<HostedAuthPathStat>;
  openReadOnlyNoFollow(path: string): Promise<HostedAuthReadHandle>;
  chmod(path: string, mode: number): Promise<void>;
  writeTextDurable(
    path: string,
    body: string,
    options: { readonly exclusive: boolean; readonly mode: number }
  ): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  remove(
    path: string,
    options?: { readonly force?: boolean; readonly recursive?: boolean }
  ): Promise<void>;
  randomBytes(size: number): Uint8Array;
  base64UrlEncode(bytes: Uint8Array): string;
  base64UrlDecode(value: string): Uint8Array;
  hmacSha256(key: Uint8Array, parts: readonly string[], encoding: 'hex' | 'base64url'): string;
  hkdfSha256(input: Uint8Array, salt: Uint8Array, info: string, length: number): Uint8Array;
  sha256Base64Url(value: string): string;
  verifyOidcSignature(input: {
    readonly algorithm: string;
    readonly jwk: Readonly<Record<string, unknown>>;
    readonly signingInput: string;
    readonly signature: Uint8Array;
  }): boolean;
  encryptAes256Gcm(input: {
    readonly key: Uint8Array;
    readonly nonce: Uint8Array;
    readonly aad: string;
    readonly plaintext: string;
  }): { readonly ciphertext: Uint8Array; readonly tag: Uint8Array };
  decryptAes256Gcm(input: {
    readonly key: Uint8Array;
    readonly nonce: Uint8Array;
    readonly aad: string;
    readonly ciphertext: Uint8Array;
    readonly tag: Uint8Array;
  }): string;
  secureEqual(left: string, right: string): boolean;
}

export interface HostedAuthReadHandle {
  stat(): Promise<HostedAuthPathStat>;
  readTextBounded(maximumBytes: number): Promise<string>;
  close(): Promise<void>;
}

export interface HostedAuthLocalControlTransport {
  start(handler: (requestBody: string) => Promise<string>): Promise<void>;
  close(): Promise<void>;
}

export interface HostedAuthLocalControlTransportFactory {
  create(options: {
    readonly socketPath: string;
    readonly maximumRequestBytes: number;
    readonly requestTimeoutMs: number;
  }): HostedAuthLocalControlTransport;
}

export interface IdentityProviderClaims {
  readonly issuer: string;
  readonly subject: string;
  readonly displayName: string;
  readonly role: HostedRole;
  readonly providerSessionId: string | null;
}

export interface IdentityProviderBeginContext {
  readonly attemptId: OidcLoginAttemptId;
  readonly returnTo: string;
}

export interface IdentityProviderBeginResult extends BeginLoginResult {
  readonly nonce: string;
  readonly pkceVerifier: string;
}

export interface IdentityProviderCompleteContext extends CompleteLoginInput {
  readonly nonce: string;
  readonly pkceVerifier: string;
}

export interface IdentityProviderLogoutContext {
  readonly session: HostedOperatorSessionRecord;
  readonly postLogoutRedirectUri: string;
}

export interface IdentityProviderBackchannelLogout {
  readonly issuer: string;
  readonly subject?: string;
  readonly providerSessionId?: string;
  readonly jti: string;
  readonly expiresAt: number;
}

/**
 * Provider-neutral boundary. Keycloak uses the same OIDC implementation as any
 * standards-compliant external provider.
 */
export interface OidcIdentityProvider {
  readonly id: string;
  readonly displayName: string;
  beginLogin(context: IdentityProviderBeginContext): Promise<IdentityProviderBeginResult>;
  completeLogin(context: IdentityProviderCompleteContext): Promise<IdentityProviderClaims>;
  logout(context: IdentityProviderLogoutContext): Promise<IdentityProviderLogoutResult>;
  verifyBackchannelLogout(token: string): Promise<IdentityProviderBackchannelLogout>;
}
