// @vitest-environment node

import { execFile } from 'node:child_process';
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm as remove,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

import {
  createHostedAccessFeature,
  type CreateHostedAccessFeatureDependencies,
  type HostedAccessFeature,
} from '@features/hosted-access/main';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import Database from 'better-sqlite3-node';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  HostedAuthStorageGateway,
  HostedAuthStorageOperation,
} from '@features/internal-storage/contracts';
import type { FastifyInstance } from 'fastify';
import type { JsonWebKey } from 'node:crypto';
import type { OutgoingHttpHeaders } from 'node:http';

function hostPlatform(): CreateHostedAccessFeatureDependencies['hostPlatform'] {
  return {
    uid: process.getuid?.(),
    pid: process.pid,
    join,
    dirname,
    isAbsolute,
    byteLength: Buffer.byteLength,
    mkdir: async (path, mode) => {
      await mkdir(path, { recursive: true, mode });
    },
    lstat,
    openReadOnlyNoFollow: async (path) => {
      const handle = await open(path, 'r');
      return {
        stat: () => handle.stat(),
        readTextBounded: async (maximumBytes) => {
          const stat = await handle.stat();
          if (stat.size > maximumBytes) throw new Error('test_secret_too_large');
          return handle.readFile('utf8');
        },
        close: () => handle.close(),
      };
    },
    chmod,
    writeTextDurable: async (path, body, options) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const handle = await open(path, options.exclusive ? 'wx' : 'w', options.mode);
      try {
        await handle.writeFile(body, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    rename,
    remove,
    randomBytes,
    base64UrlEncode: (bytes) => Buffer.from(bytes).toString('base64url'),
    base64UrlDecode: (value) => Buffer.from(value, 'base64url'),
    hmacSha256: (key, parts, encoding) => {
      const hmac = createHmac('sha256', key);
      for (const part of parts) hmac.update(part);
      return hmac.digest(encoding);
    },
    hkdfSha256: (input, salt, info, length) =>
      new Uint8Array(hkdfSync('sha256', input, salt, Buffer.from(info), length)),
    sha256Base64Url: (value) => createHash('sha256').update(value).digest('base64url'),
    verifyOidcSignature: (input) => {
      const publicKeyValue = createPublicKey({
        key: input.jwk as JsonWebKey,
        format: 'jwk',
      });
      let verificationKey: Parameters<typeof verifySignature>[2] = publicKeyValue;
      if (input.algorithm.startsWith('PS')) {
        verificationKey = {
          key: publicKeyValue,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: Number(input.algorithm.slice(-3)) / 8,
        };
      } else if (input.algorithm.startsWith('ES')) {
        verificationKey = { key: publicKeyValue, dsaEncoding: 'ieee-p1363' as const };
      }
      return verifySignature(
        `sha${input.algorithm.slice(-3)}`,
        Buffer.from(input.signingInput),
        verificationKey,
        input.signature
      );
    },
    encryptAes256Gcm: (input) => {
      const cipher = createCipheriv('aes-256-gcm', input.key, input.nonce);
      cipher.setAAD(Buffer.from(input.aad));
      return {
        ciphertext: Buffer.concat([cipher.update(input.plaintext, 'utf8'), cipher.final()]),
        tag: cipher.getAuthTag(),
      };
    },
    decryptAes256Gcm: (input) => {
      const decipher = createDecipheriv('aes-256-gcm', input.key, input.nonce);
      decipher.setAAD(Buffer.from(input.aad));
      decipher.setAuthTag(Buffer.from(input.tag));
      return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]).toString('utf8');
    },
    secureEqual: (left, right) => {
      const leftBytes = Buffer.from(left);
      const rightBytes = Buffer.from(right);
      return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
    },
  };
}

const unusedLocalControlTransport: CreateHostedAccessFeatureDependencies['localControlTransportFactory'] =
  {
    create: () => ({
      start: () => Promise.resolve(undefined),
      close: () => Promise.resolve(undefined),
    }),
  };

const NOW = 1_800_000_000_000;
const ISSUER = 'http://idp.test/realms/agent-teams';
const CLIENT_ID = 'agent-teams-hosted';
const PUBLIC_ORIGIN = 'http://agent-teams.test';
const WORKSPACE_ID = 'project_synthetic-oidc-1';
const KEYCLOAK_MEMBER_WORKSPACE_ID = 'project_synthetic-keycloak-member-1';
const KEYCLOAK_OWNER_WORKSPACE_ID = 'project_synthetic-keycloak-owner-1';
// eslint-disable-next-line sonarjs/no-clear-text-protocols -- Registered OIDC claim name, not a request.
const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' });
const directories: string[] = [];
const apps: FastifyInstance[] = [];
const storageCores: InternalStorageWorkerCore[] = [];
const dockerCleanups: (() => Promise<void>)[] = [];
const execFileAsync = promisify(execFile);

const keycloakE2eImage = process.env.HOSTED_KEYCLOAK_E2E_KEYCLOAK_IMAGE?.trim();
const postgresE2eImage = process.env.HOSTED_KEYCLOAK_E2E_POSTGRES_IMAGE?.trim();
const keycloakE2eImageReference = /^quay\.io\/keycloak\/keycloak:26\.3\.2@sha256:[a-f0-9]{64}$/u;
const postgresE2eImageReference = /^postgres:17\.5-alpine@sha256:[a-f0-9]{64}$/u;
const keycloakE2eConfigured = keycloakE2eImage !== undefined || postgresE2eImage !== undefined;
if (
  keycloakE2eConfigured &&
  (keycloakE2eImage === undefined ||
    postgresE2eImage === undefined ||
    !keycloakE2eImageReference.test(keycloakE2eImage) ||
    !postgresE2eImageReference.test(postgresE2eImage))
) {
  throw new Error('hosted_keycloak_e2e_requires_pinned_immutable_image_references');
}
const runKeycloakE2e = keycloakE2eConfigured;
const KEYCLOAK_E2E_PORT = 18_080;
const HOSTED_APP_E2E_PORT = 18_443;
const KEYCLOAK_E2E_DOCKER_TIMEOUT_MS = 45_000;
const KEYCLOAK_E2E_HTTP_TIMEOUT_MS = 30_000;
const KEYCLOAK_E2E_PHASE_TIMEOUT_MS = 60_000;
const KEYCLOAK_E2E_STARTUP_TIMEOUT_MS = 180_000;

type Row = Record<string, unknown>;

function createKeycloakE2eDirectory(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

class SyntheticOidcStorage implements HostedAuthStorageGateway {
  private mode: string | null = null;
  private readonly attempts = new Map<string, Row>();
  private readonly identities = new Map<string, { user: Row; identity: Row }>();
  private readonly users = new Map<string, Row>();
  private readonly sessions = new Map<string, Row>();
  private readonly localRoles = new Map<string, Row>();
  private readonly workspaces = new Map<string, Row>();
  private readonly workspaceGrants = new Map<string, Row>();
  private readonly logoutReplay = new Set<string>();
  readonly audits: Row[] = [];

  hostedAuthCall(operation: HostedAuthStorageOperation, payloadValue: unknown): Promise<unknown> {
    return Promise.resolve(this.call(operation, payloadValue as Row));
  }

  // eslint-disable-next-line sonarjs/cognitive-complexity -- Exhaustive in-memory protocol test double.
  private call(operation: HostedAuthStorageOperation, payload: Row): unknown {
    switch (operation) {
      case 'configuration.claimMode':
        this.mode ??= String(payload.mode);
        return this.mode === payload.mode;
      case 'configuration.read':
        return {
          authMode: this.mode,
          configuredAt: 1,
          resetGeneration: 0,
          secretsRotatedGeneration: 0,
          pendingPersonalKeyringId: null,
        };
      case 'oidcAttempt.create': {
        const attemptId = String(payload.attemptId);
        if (this.attempts.has(attemptId)) return 'conflict';
        this.attempts.set(attemptId, { ...payload });
        return 'created';
      }
      case 'oidcAttempt.consume': {
        const attemptId = String(payload.attemptId);
        const attempt = this.attempts.get(attemptId);
        if (attempt === undefined) return null;
        if (
          attempt.consumedAt !== null ||
          attempt.providerId !== payload.providerId ||
          attempt.stateHash !== payload.stateHash ||
          Number(payload.now) >= Number(attempt.expiresAt)
        ) {
          return null;
        }
        const consumed = { ...attempt, consumedAt: Number(payload.now) };
        this.attempts.set(attemptId, consumed);
        return consumed;
      }
      case 'identity.bind': {
        const identity = payload.identity as Row;
        const proposedUser = payload.proposedUser as Row;
        const key = `${String(identity.issuer)}\0${String(identity.subject)}`;
        const existing = this.identities.get(key);
        if (existing) {
          const updated = {
            ...existing,
            user: this.users.get(String(existing.user.userId)) ?? existing.user,
            identity: {
              ...existing.identity,
              lastAuthenticatedAt: identity.lastAuthenticatedAt,
            },
          };
          this.identities.set(key, updated);
          return updated;
        }
        const bound = {
          user: { ...proposedUser },
          identity: { ...identity, userId: proposedUser.userId },
        };
        this.users.set(String(proposedUser.userId), bound.user);
        this.identities.set(key, bound);
        return bound;
      }
      case 'session.create': {
        const session = payload.session as Row;
        this.sessions.set(String(session.secretHash), {
          ...session,
          roleSnapshot: { ...(session.roleSnapshot as Row) },
        });
        return null;
      }
      case 'session.findByHash': {
        const session = this.sessions.get(String(payload.secretHash));
        if (!session) return null;
        const role = session.roleSnapshot as Row;
        return {
          ...session,
          role: role.role,
          roleSource: role.source,
          roleCapturedAt: role.capturedAt,
        };
      }
      case 'session.touch': {
        for (const [hash, session] of this.sessions) {
          if (
            session.sessionId === payload.sessionId &&
            session.lastUsedAt === payload.expectedLastUsedAt &&
            session.status === 'active'
          ) {
            this.sessions.set(hash, {
              ...session,
              lastUsedAt: payload.lastUsedAt,
              idleExpiresAt: payload.idleExpiresAt,
            });
            return true;
          }
        }
        return false;
      }
      case 'session.revoke':
        this.revokeSession(String(payload.sessionId), Number(payload.now), String(payload.reason));
        return null;
      case 'backchannel.apply':
        return this.applyBackchannel(payload);
      case 'user.get':
        return this.users.get(String(payload.userId)) ?? null;
      case 'user.list':
        return [...this.users.values()];
      case 'user.setStatus': {
        const userId = String(payload.userId);
        const user = this.users.get(userId);
        if (!user) return false;
        this.users.set(userId, {
          ...user,
          status: payload.status,
          updatedAt: payload.now,
        });
        if (payload.status === 'disabled') {
          for (const session of this.sessions.values()) {
            if (session.userId === userId && session.status === 'active') {
              this.revokeSession(String(session.sessionId), Number(payload.now), 'user_disabled');
            }
          }
        }
        return true;
      }
      case 'role.getLocal':
        return this.localRoles.get(String(payload.userId)) ?? null;
      case 'role.setLocal': {
        const assignment = payload.assignment as Row;
        this.localRoles.set(String(assignment.userId), { ...assignment });
        return null;
      }
      case 'role.clearLocal':
        return this.localRoles.delete(String(payload.userId));
      case 'workspace.seed': {
        const runtimeWorkspaceId = String(payload.runtimeWorkspaceId);
        this.workspaces.set(runtimeWorkspaceId, {
          runtimeWorkspaceId,
          workspaceId: payload.workspaceId,
          displayName: payload.displayName,
          status: 'active',
          registeredAt: payload.registeredAt,
          registeredBy: null,
        });
        return null;
      }
      case 'workspace.isRegistered':
        return this.workspaces.get(String(payload.runtimeWorkspaceId))?.status === 'active';
      case 'workspace.list':
        return [...this.workspaces.values()];
      case 'workspace.register': {
        const workspace = { ...payload, status: 'active' };
        this.workspaces.set(String(payload.runtimeWorkspaceId), workspace);
        return workspace;
      }
      case 'workspace.disable': {
        const runtimeWorkspaceId = String(payload.runtimeWorkspaceId);
        const workspace = this.workspaces.get(runtimeWorkspaceId);
        if (workspace === undefined) return false;
        if (workspace.status !== 'active') return false;
        this.workspaces.set(runtimeWorkspaceId, { ...workspace, status: 'disabled' });
        return true;
      }
      case 'workspace.grant.list':
        return [...this.workspaceGrants.values()].filter(
          (grant) =>
            grant.userId === payload.userId && grant.grantGeneration === payload.grantGeneration
        );
      case 'workspace.grant.set': {
        const workspace = this.workspaces.get(String(payload.runtimeWorkspaceId));
        if (workspace?.status !== 'active') {
          throw new Error('hosted-workspace-not-registered');
        }
        const grant = { ...workspace, ...payload };
        this.workspaceGrants.set(
          `${String(payload.userId)}\0${String(payload.runtimeWorkspaceId)}`,
          grant
        );
        return grant;
      }
      case 'workspace.grant.revoke':
        return this.workspaceGrants.delete(
          `${String(payload.userId)}\0${String(payload.runtimeWorkspaceId)}`
        );
      case 'audit.append':
        this.audits.push({ ...(payload.event as Row) });
        return null;
      default:
        throw new Error(`unexpected_synthetic_oidc_storage_operation:${operation}`);
    }
  }

  private revokeSession(sessionId: string, now: number, reason: string): void {
    for (const [hash, session] of this.sessions) {
      if (session.sessionId === sessionId && session.status === 'active') {
        this.sessions.set(hash, {
          ...session,
          status: 'revoked',
          revokedAt: now,
          revocationReason: reason,
        });
      }
    }
  }

  private applyBackchannel(payload: Row): { consumed: boolean; revoked: number } {
    const replayKey = `${String(payload.providerId)}\0${String(payload.issuer)}\0${String(payload.jti)}`;
    if (this.logoutReplay.has(replayKey)) return { consumed: false, revoked: 0 };
    this.logoutReplay.add(replayKey);
    let revoked = 0;
    for (const [hash, session] of this.sessions) {
      const subjectMatches =
        payload.subject === undefined || session.providerSubject === payload.subject;
      const sidMatches =
        payload.providerSessionId === undefined ||
        session.providerSessionId === payload.providerSessionId;
      if (
        session.status === 'active' &&
        session.providerId === payload.providerId &&
        session.providerIssuer === payload.issuer &&
        subjectMatches &&
        sidMatches
      ) {
        revoked += 1;
        this.sessions.set(hash, {
          ...session,
          status: 'revoked',
          revokedAt: payload.consumedAt,
          revocationReason: payload.reason,
        });
      }
    }
    return { consumed: true, revoked };
  }
}

class SyntheticOidcServer {
  offline = false;
  role = 'agent-teams-member';
  tokenExchangeCount = 0;
  private expectedNonce = '';
  private expectedChallenge = '';

  readonly fetch: typeof globalThis.fetch = (input, init) => {
    if (this.offline) return Promise.reject(new Error('synthetic_idp_offline'));
    let url: string;
    if (typeof input === 'string') url = input;
    else if (input instanceof URL) url = input.href;
    else url = input.url;
    if (url.endsWith('/.well-known/openid-configuration')) {
      return Promise.resolve(
        jsonResponse({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
          token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
          jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
          end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
        })
      );
    }
    if (url.endsWith('/protocol/openid-connect/certs')) {
      return Promise.resolve(
        jsonResponse({
          keys: [{ ...publicJwk, kid: 'synthetic-key', alg: 'RS256', use: 'sig' }],
        })
      );
    }
    if (url.endsWith('/protocol/openid-connect/token')) {
      if (!(init?.body instanceof URLSearchParams)) {
        return Promise.reject(new Error('synthetic_idp_token_body_invalid'));
      }
      const body = init.body;
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('client_id')).toBe(CLIENT_ID);
      expect(body.get('redirect_uri')).toBe(`${PUBLIC_ORIGIN}/api/auth/oidc/callback`);
      expect(
        createHash('sha256')
          .update(String(body.get('code_verifier')))
          .digest('base64url')
      ).toBe(this.expectedChallenge);
      this.tokenExchangeCount += 1;
      return Promise.resolve(
        jsonResponse({
          id_token: signedJwt({
            iss: ISSUER,
            sub: 'subject-synthetic-1',
            aud: CLIENT_ID,
            exp: NOW / 1000 + 300,
            iat: NOW / 1000,
            nonce: this.expectedNonce,
            sid: 'provider-session-synthetic-1',
            name: 'Synthetic OIDC User',
            realm_access: { roles: [this.role] },
          }),
        })
      );
    }
    return Promise.reject(new Error(`unexpected_synthetic_idp_url:${url}`));
  };

  observeAuthorization(location: string): URL {
    const authorization = new URL(location);
    this.expectedNonce = String(authorization.searchParams.get('nonce'));
    this.expectedChallenge = String(authorization.searchParams.get('code_challenge'));
    return authorization;
  }
}

interface KeycloakSandbox {
  readonly issuer: string;
  readonly member: { readonly username: string; readonly password: string };
  readonly owner: { readonly username: string; readonly password: string };
  stop(): Promise<void>;
  start(): Promise<void>;
  removeUserSessions(username: string): Promise<void>;
}

interface BrowserCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly hostOnly: boolean;
  readonly path: string;
  readonly secure: boolean;
  readonly expiresAt: number | null;
}

interface MutableBrowserCookieAttributes {
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  expiresAt: number | null;
}

function defaultCookiePath(url: URL): string {
  const lastSlash = url.pathname.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : url.pathname.slice(0, lastSlash);
}

function cookieDomainMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function cookiePathMatches(pathname: string, cookiePath: string): boolean {
  return (
    pathname === cookiePath ||
    (pathname.startsWith(cookiePath) &&
      (cookiePath.endsWith('/') || pathname.charAt(cookiePath.length) === '/'))
  );
}

function permitsSecureCookieTransport(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const hostname = url.hostname.toLowerCase();
  return hostname === '127.0.0.1' || hostname === '[::1]';
}

function applyBrowserCookieAttribute(
  attributes: MutableBrowserCookieAttributes,
  segment: string,
  responseUrl: URL
): boolean {
  const attribute = segment.trim();
  const separator = attribute.indexOf('=');
  const name = (separator < 0 ? attribute : attribute.slice(0, separator)).toLowerCase();
  const value = separator < 0 ? '' : attribute.slice(separator + 1).trim();
  if (name === 'domain') {
    const candidate = value.replace(/^\./u, '').toLowerCase();
    if (!candidate || !cookieDomainMatches(responseUrl.hostname.toLowerCase(), candidate)) {
      return false;
    }
    attributes.domain = candidate;
    attributes.hostOnly = false;
  } else if (name === 'path' && value.startsWith('/')) {
    attributes.path = value;
  } else if (name === 'secure') {
    attributes.secure = true;
  } else if (name === 'max-age' && /^-?\d+$/u.test(value)) {
    attributes.expiresAt = Date.now() + Number(value) * 1_000;
  } else if (name === 'expires') {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) attributes.expiresAt = timestamp;
  }
  return true;
}

function parseBrowserCookie(value: string, responseUrl: URL): BrowserCookie | null {
  const segments = value.split(';');
  const pair = segments.shift()?.trim();
  const separator = pair?.indexOf('=') ?? -1;
  if (!pair || separator <= 0) return null;
  const attributes: MutableBrowserCookieAttributes = {
    domain: responseUrl.hostname.toLowerCase(),
    hostOnly: true,
    path: defaultCookiePath(responseUrl),
    secure: false,
    expiresAt: null,
  };
  for (const segment of segments) {
    if (!applyBrowserCookieAttribute(attributes, segment, responseUrl)) return null;
  }
  if (attributes.secure && !permitsSecureCookieTransport(responseUrl)) return null;
  return Object.freeze({
    name: pair.slice(0, separator),
    value: pair.slice(separator + 1),
    ...attributes,
  });
}

class BrowserCookieJar {
  private readonly values = new Map<string, BrowserCookie>();

  absorb(response: Response, responseUrl: URL): void {
    const headers = response.headers as Headers & { getSetCookie(): string[] };
    for (const value of headers.getSetCookie()) {
      const cookie = parseBrowserCookie(value, responseUrl);
      if (cookie === null) continue;
      const key = `${cookie.name}\0${cookie.domain}\0${cookie.path}`;
      if (
        cookie.value.length === 0 ||
        (cookie.expiresAt !== null && cookie.expiresAt <= Date.now())
      ) {
        this.values.delete(key);
      } else {
        this.values.set(key, cookie);
      }
    }
  }

  header(requestUrl: URL): string {
    const now = Date.now();
    const hostname = requestUrl.hostname.toLowerCase();
    const cookies: BrowserCookie[] = [];
    for (const [key, cookie] of this.values) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
        this.values.delete(key);
        continue;
      }
      if (
        (cookie.secure && !permitsSecureCookieTransport(requestUrl)) ||
        (cookie.hostOnly
          ? cookie.domain !== hostname
          : !cookieDomainMatches(hostname, cookie.domain)) ||
        !cookiePathMatches(requestUrl.pathname, cookie.path)
      ) {
        continue;
      }
      cookies.push(cookie);
    }
    return cookies
      .toSorted((left, right) => right.path.length - left.path.length)
      .map(({ name, value }) => `${name}=${value}`)
      .join('; ');
  }
}

describe('OIDC browser cookie test transport', () => {
  /* eslint-disable sonarjs/no-clear-text-protocols -- Exact HTTP transports are the security boundary under test. */
  it.each([
    ['IPv4 loopback', 'http://127.0.0.1:18080', true],
    ['IPv6 loopback', 'http://[::1]:18080', true],
    ['localhost alias', 'http://localhost:18080', false],
    ['arbitrary HTTP host', 'http://idp.test:18080', false],
  ])(
    'sends Secure cookies over %s only when it is an exact loopback address',
    (_name, origin, sent) => {
      const jar = new BrowserCookieJar();
      const url = new URL(`${origin}/realms/agent-teams`);
      jar.absorb(
        new Response(null, {
          headers: { 'set-cookie': 'KEYCLOAK_SESSION=opaque; Path=/; HttpOnly; Secure' },
        }),
        url
      );

      expect(jar.header(url)).toBe(sent ? 'KEYCLOAK_SESSION=opaque' : '');
      const secureUrl = new URL(url);
      secureUrl.protocol = 'https:';
      expect(jar.header(secureUrl)).toBe(sent ? 'KEYCLOAK_SESSION=opaque' : '');
    }
  );
  /* eslint-enable sonarjs/no-clear-text-protocols */
});

async function docker(label: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync('docker', [...args], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: KEYCLOAK_E2E_DOCKER_TIMEOUT_MS,
    });
    return String(result.stdout).trim();
  } catch (cause) {
    throw new Error(`hosted_keycloak_e2e_docker_operation_failed:${label}`, { cause });
  }
}

async function keycloakHttpRequest(
  label: string,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      redirect: init.redirect ?? 'error',
      signal: init.signal ?? AbortSignal.timeout(KEYCLOAK_E2E_HTTP_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new Error(`hosted_keycloak_e2e_http_operation_failed:${label}`, { cause });
  }
}

async function runKeycloakE2ePhase<T>(
  label: string,
  operation: () => Promise<T>,
  timeoutMs = KEYCLOAK_E2E_PHASE_TIMEOUT_MS
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`hosted_keycloak_e2e_phase_timeout:${label}:${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(), expired]);
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('hosted_keycloak_e2e_phase_timeout:')) {
      throw cause;
    }
    throw new Error(`hosted_keycloak_e2e_phase_failed:${label}`, { cause });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitFor(
  label: string,
  check: () => Promise<boolean>,
  timeoutMs = 150_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`hosted_keycloak_e2e_wait_timeout:${label}:${timeoutMs}ms`, {
    cause: lastError,
  });
}

async function waitForKeycloak(issuer: string, label: string): Promise<void> {
  await waitFor(label, async () => {
    const response = await keycloakHttpRequest(
      `${label}_discovery`,
      `${issuer}/.well-known/openid-configuration`
    );
    return response.ok;
  });
}

async function startKeycloakSandbox(input: {
  readonly directory: string;
  readonly keycloakPort: number;
  readonly publicOrigin: string;
  readonly backchannelUrl: string;
}): Promise<KeycloakSandbox> {
  if (!keycloakE2eImage || !postgresE2eImage) {
    throw new Error('hosted_keycloak_e2e_images_missing');
  }
  const sandboxDirectory = join(input.directory, 'keycloak-sandbox');
  await mkdir(sandboxDirectory, { recursive: true, mode: 0o700 });
  const id = randomBytes(8).toString('hex');
  const networkName = `hosted-auth-e2e-${id}`;
  const postgresName = `hosted-auth-e2e-postgres-${id}`;
  const keycloakName = `hosted-auth-e2e-keycloak-${id}`;
  const databasePasswordPath = join(sandboxDirectory, 'database-password');
  const adminPasswordPath = join(sandboxDirectory, 'admin-password');
  const clientSecretPath = join(sandboxDirectory, 'client-secret');
  const realmPath = join(sandboxDirectory, 'realm-agent-teams-e2e.json');
  const databasePassword = randomBytes(32).toString('base64url');
  const adminPassword = randomBytes(32).toString('base64url');
  const clientSecret = randomBytes(32).toString('base64url');
  const member = {
    username: `member-${id}`,
    password: randomBytes(32).toString('base64url'),
  };
  const owner = {
    username: `owner-${id}`,
    password: randomBytes(32).toString('base64url'),
  };
  await Promise.all([
    // These disposable bind-mounted fixtures must be readable by the
    // non-root Keycloak uid. Their containing mkdtemp/sandbox directories are
    // mode 0700; production continues to use Compose secrets with uid 1000
    // and mode 0400.
    writeFile(databasePasswordPath, databasePassword, { mode: 0o644, flag: 'wx' }),
    writeFile(adminPasswordPath, adminPassword, { mode: 0o644, flag: 'wx' }),
    writeFile(clientSecretPath, clientSecret, { mode: 0o600, flag: 'wx' }),
  ]);

  const realm = JSON.parse(
    await readFile(join(process.cwd(), 'docker/keycloak/realm-agent-teams.json'), 'utf8')
  ) as Row;
  const clients = realm.clients as Row[];
  const client = clients.find((value) => value.clientId === CLIENT_ID);
  if (!client) throw new Error('hosted_keycloak_e2e_client_template_missing');
  client.redirectUris = [`${input.publicOrigin}/api/auth/oidc/callback`];
  client.webOrigins = [input.publicOrigin];
  client.secret = clientSecret;
  client.attributes = {
    ...(client.attributes as Row),
    'backchannel.logout.url': input.backchannelUrl,
    'post.logout.redirect.uris': `${input.publicOrigin}/`,
  };
  realm.sslRequired = 'none';
  realm.users = [
    {
      username: member.username,
      enabled: true,
      firstName: 'Disposable',
      lastName: 'Member',
      email: `${member.username}@example.invalid`,
      emailVerified: true,
      realmRoles: ['agent-teams-member'],
      credentials: [{ type: 'password', value: member.password, temporary: false }],
    },
    {
      username: owner.username,
      enabled: true,
      firstName: 'Disposable',
      lastName: 'Owner',
      email: `${owner.username}@example.invalid`,
      emailVerified: true,
      realmRoles: ['agent-teams-owner'],
      credentials: [{ type: 'password', value: owner.password, temporary: false }],
    },
  ];
  await writeFile(realmPath, `${JSON.stringify(realm, null, 2)}\n`, {
    mode: 0o644,
    flag: 'wx',
  });

  await docker('network_create', ['network', 'create', networkName]);
  dockerCleanups.push(async () => {
    await docker('network_remove', ['network', 'rm', networkName]).catch(() => undefined);
  });
  await docker('postgres_start', [
    'run',
    '--detach',
    '--name',
    postgresName,
    '--network',
    networkName,
    '--publish',
    '127.0.0.1::5432',
    '--mount',
    `type=bind,source=${databasePasswordPath},target=/run/secrets/database-password,readonly`,
    '--env',
    'POSTGRES_DB=keycloak',
    '--env',
    'POSTGRES_USER=keycloak',
    '--env',
    'POSTGRES_PASSWORD_FILE=/run/secrets/database-password',
    '--health-cmd',
    'pg_isready -U keycloak -d keycloak',
    '--health-interval',
    '1s',
    '--health-timeout',
    '3s',
    '--health-retries',
    '60',
    postgresE2eImage,
  ]);
  dockerCleanups.push(async () => {
    await docker('postgres_remove', ['rm', '--force', postgresName]).catch(() => undefined);
  });
  await waitFor('postgres_ready', async () => {
    const status = await docker('postgres_health_inspect', [
      'inspect',
      '--format={{.State.Health.Status}}',
      postgresName,
    ]);
    return status === 'healthy';
  });
  const postgresPortMapping = await docker('postgres_port_inspect', [
    'port',
    postgresName,
    '5432/tcp',
  ]);
  const postgresPortMatch = /^127\.0\.0\.1:(\d+)$/u.exec(postgresPortMapping);
  const postgresPort = Number(postgresPortMatch?.[1]);
  if (!Number.isInteger(postgresPort) || postgresPort < 1 || postgresPort > 65_535) {
    throw new Error('hosted_keycloak_e2e_postgres_loopback_port_missing');
  }

  const issuer = `http://127.0.0.1:${input.keycloakPort}/realms/agent-teams`;
  // Keycloak shares the disposable test host's network namespace so its real
  // back-channel request reaches the application's loopback-only listener.
  // Both HTTP services bind 127.0.0.1, PostgreSQL is published on a random
  // loopback port, and the harness never changes host firewall rules.
  await docker('keycloak_start', [
    'run',
    '--detach',
    '--name',
    keycloakName,
    '--network',
    'host',
    '--mount',
    `type=bind,source=${realmPath},target=/opt/keycloak/data/import/realm-agent-teams.json,readonly`,
    '--mount',
    `type=bind,source=${databasePasswordPath},target=/run/secrets/database-password,readonly`,
    '--mount',
    `type=bind,source=${adminPasswordPath},target=/run/secrets/admin-password,readonly`,
    '--tmpfs',
    '/run/keycloak:rw,noexec,nosuid,nodev,mode=0700,uid=1000,gid=0',
    '--env',
    'KC_DB=postgres',
    '--env',
    `KC_DB_URL=jdbc:postgresql://127.0.0.1:${postgresPort}/keycloak`,
    '--env',
    'KC_DB_USERNAME=keycloak',
    '--env',
    'KC_BOOTSTRAP_ADMIN_USERNAME=admin',
    '--env',
    `KC_HOSTNAME=http://127.0.0.1:${input.keycloakPort}`,
    '--env',
    'KC_HTTP_ENABLED=true',
    '--entrypoint',
    '/bin/sh',
    keycloakE2eImage,
    '-ec',
    [
      // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- Variable receives a random file value.
      'admin_password="$(cat /run/secrets/admin-password)"',
      // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- Variable receives a random file value.
      'database_password="$(cat /run/secrets/database-password)"',
      '{',
      '  printf "bootstrap-admin-username=%s\\n" "$KC_BOOTSTRAP_ADMIN_USERNAME"',
      // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- Configuration key, not a credential.
      '  printf "bootstrap-admin-password=%s\\n" "$admin_password"',
      // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- Configuration key, not a credential.
      '  printf "db-password=%s\\n" "$database_password"',
      '} > /run/keycloak/keycloak.conf',
      'chmod 0400 /run/keycloak/keycloak.conf',
      'unset admin_password database_password',
      `exec env -u KC_BOOTSTRAP_ADMIN_PASSWORD -u KC_DB_PASSWORD /opt/keycloak/bin/kc.sh --config-file=/run/keycloak/keycloak.conf start-dev --import-realm --http-host=127.0.0.1 --http-port=${input.keycloakPort} --health-enabled=true --hostname-strict=false`,
    ].join('\n'),
  ]);
  dockerCleanups.push(async () => {
    await docker('keycloak_remove', ['rm', '--force', keycloakName]).catch(() => undefined);
  });
  await waitForKeycloak(issuer, 'keycloak_initial_ready');

  const adminAccessToken = async (): Promise<string> => {
    const response = await keycloakHttpRequest(
      'admin_token',
      `http://127.0.0.1:${input.keycloakPort}/realms/master/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'admin-cli',
          grant_type: 'password',
          username: 'admin',
          password: adminPassword,
        }),
      }
    );
    if (!response.ok) {
      throw new Error(`hosted_keycloak_e2e_admin_login_failed:${response.status}`);
    }
    const body = (await response.json()) as Row;
    if (typeof body.access_token !== 'string') {
      throw new Error('hosted_keycloak_e2e_admin_token_missing');
    }
    return body.access_token;
  };

  return Object.freeze({
    issuer,
    member: Object.freeze(member),
    owner: Object.freeze(owner),
    stop: async () => {
      await docker('keycloak_stop', ['stop', '--time', '10', keycloakName]);
    },
    start: async () => {
      await docker('keycloak_restart', ['start', keycloakName]);
      await waitForKeycloak(issuer, 'keycloak_restart_ready');
    },
    removeUserSessions: async (username: string) => {
      const accessToken = await adminAccessToken();
      const headers = { authorization: `Bearer ${accessToken}` };
      const usersResponse = await keycloakHttpRequest(
        'admin_user_lookup',
        `${issuer.replace('/realms/agent-teams', '')}/admin/realms/agent-teams/users?${new URLSearchParams(
          { username, exact: 'true' }
        )}`,
        { headers }
      );
      if (!usersResponse.ok) {
        throw new Error(`hosted_keycloak_e2e_user_lookup_failed:${usersResponse.status}`);
      }
      const users = (await usersResponse.json()) as Row[];
      const userId = users[0]?.id;
      if (typeof userId !== 'string') throw new Error('hosted_keycloak_e2e_user_missing');
      const sessionsResponse = await keycloakHttpRequest(
        'admin_session_lookup',
        `${issuer.replace('/realms/agent-teams', '')}/admin/realms/agent-teams/users/${encodeURIComponent(userId)}/sessions`,
        { headers }
      );
      if (!sessionsResponse.ok) {
        throw new Error(`hosted_keycloak_e2e_session_lookup_failed:${sessionsResponse.status}`);
      }
      const sessions = (await sessionsResponse.json()) as Row[];
      if (sessions.length === 0) throw new Error('hosted_keycloak_e2e_session_missing');
      for (const session of sessions) {
        if (typeof session.id !== 'string') {
          throw new Error('hosted_keycloak_e2e_session_missing');
        }
        const removed = await keycloakHttpRequest(
          'admin_session_remove_backchannel',
          `${issuer.replace('/realms/agent-teams', '')}/admin/realms/agent-teams/sessions/${encodeURIComponent(session.id)}`,
          { method: 'DELETE', headers }
        );
        if (!removed.ok) {
          throw new Error(`hosted_keycloak_e2e_session_remove_failed:${removed.status}`);
        }
      }
    },
  });
}

function nativeStorageHarness(directory: string): HostedAuthStorageGateway {
  const core = new InternalStorageWorkerCore({
    databasePath: join(directory, 'internal.sqlite'),
    createDatabase: (path, options) => new Database(path, options),
  });
  storageCores.push(core);
  return {
    hostedAuthCall: (operation: HostedAuthStorageOperation, payload: unknown) =>
      Promise.resolve(core.handle('hostedAuth.call', { operation, payload })),
  };
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&#x3D;', '=')
    .replaceAll('&#61;', '=');
}

async function fetchWithProviderCookies(
  jar: BrowserCookieJar,
  url: URL,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookie = jar.header(url);
  if (cookie) headers.set('cookie', cookie);
  const response = await keycloakHttpRequest('provider_browser_navigation', url.href, {
    ...init,
    headers,
    redirect: 'manual',
  });
  jar.absorb(response, url);
  return response;
}

type ProviderNavigationResult =
  | { readonly kind: 'callback'; readonly url: URL }
  | { readonly kind: 'page'; readonly url: URL; readonly response: Response };

async function followProviderNavigation(input: {
  readonly jar: BrowserCookieJar;
  readonly initialUrl: URL;
  readonly initialResponse: Response;
  readonly providerOrigin: string;
  readonly isCallback: (url: URL) => boolean;
}): Promise<ProviderNavigationResult> {
  let currentUrl = input.initialUrl;
  let response = input.initialResponse;
  for (let redirectCount = 0; redirectCount < 16; redirectCount += 1) {
    if (response.status < 300 || response.status >= 400) {
      return { kind: 'page', url: currentUrl, response };
    }
    const location = response.headers.get('location');
    if (!location) throw new Error('hosted_keycloak_e2e_redirect_location_missing');
    const target = new URL(location, currentUrl);
    if (input.isCallback(target)) return { kind: 'callback', url: target };
    if (target.origin !== input.providerOrigin) {
      throw new Error('hosted_keycloak_e2e_redirect_origin_invalid');
    }
    currentUrl = target;
    response = await fetchWithProviderCookies(input.jar, currentUrl);
  }
  throw new Error('hosted_keycloak_e2e_redirect_limit_exceeded');
}

async function keycloakAuthorizationCode(
  authorizationUrl: string,
  account: { readonly username: string; readonly password: string },
  publicOrigin: string
): Promise<{ readonly callbackUrl: URL; readonly providerCookies: BrowserCookieJar }> {
  const jar = new BrowserCookieJar();
  const authorization = new URL(authorizationUrl);
  const expectedState = authorization.searchParams.get('state');
  const nonce = authorization.searchParams.get('nonce');
  const challenge = authorization.searchParams.get('code_challenge');
  if (
    !expectedState ||
    !nonce ||
    authorization.searchParams.get('code_challenge_method') !== 'S256' ||
    !challenge ||
    !/^[A-Za-z0-9_-]{43}$/u.test(challenge)
  ) {
    throw new Error('hosted_keycloak_e2e_authorization_pkce_invalid');
  }
  const callbackPath = '/api/auth/oidc/callback';
  const isCallback = (url: URL): boolean =>
    url.origin === publicOrigin && url.pathname === callbackPath;
  const loginPage = await fetchWithProviderCookies(jar, authorization);
  const loginNavigation = await followProviderNavigation({
    jar,
    initialUrl: authorization,
    initialResponse: loginPage,
    providerOrigin: authorization.origin,
    isCallback,
  });
  if (loginNavigation.kind !== 'page' || !loginNavigation.response.ok) {
    throw new Error('hosted_keycloak_e2e_login_page_failed');
  }
  const html = await loginNavigation.response.text();
  const loginForm = /<form\b[^>]*\bid=["']kc-form-login["'][^>]*>/iu.exec(html)?.[0];
  const action = loginForm ? /\baction=["']([^"']+)["']/iu.exec(loginForm)?.[1] : undefined;
  if (!action) throw new Error('hosted_keycloak_e2e_login_form_missing');
  const submittedUrl = new URL(decodeHtmlAttribute(action), loginNavigation.url);
  const submitted = await fetchWithProviderCookies(jar, submittedUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      username: account.username,
      password: account.password,
      credentialId: '',
    }),
  });
  const submittedNavigation = await followProviderNavigation({
    jar,
    initialUrl: submittedUrl,
    initialResponse: submitted,
    providerOrigin: authorization.origin,
    isCallback,
  });
  if (submittedNavigation.kind !== 'callback') {
    throw new Error('hosted_keycloak_e2e_credentials_rejected');
  }
  if (
    submittedNavigation.url.searchParams.get('state') !== expectedState ||
    !submittedNavigation.url.searchParams.get('code')
  ) {
    throw new Error('hosted_keycloak_e2e_callback_state_invalid');
  }
  return { callbackUrl: submittedNavigation.url, providerCookies: jar };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const core of storageCores.splice(0)) core.close();
  for (const cleanup of dockerCleanups.splice(0).reverse()) await cleanup();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function signedJwt(claims: Row): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', kid: 'synthetic-key', typ: 'JWT' })
  ).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString(
    'base64url'
  )}`;
}

function cookies(response: { headers: OutgoingHttpHeaders }): string[] {
  const value = response.headers['set-cookie'];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [String(value)];
}

function cookieValue(setCookies: readonly string[], name: string): string {
  const prefix = `${name}=`;
  const value = setCookies
    .map((entry) => entry.split(';', 1)[0] ?? '')
    .find((entry) => entry.startsWith(prefix));
  if (!value) throw new Error(`cookie ${name} not found`);
  return value.slice(prefix.length);
}

function cookieHeader(setCookies: readonly string[], names: readonly string[]): string {
  return names.map((name) => `${name}=${cookieValue(setCookies, name)}`).join('; ');
}

async function featureHarness(
  directory: string,
  storage: SyntheticOidcStorage,
  idp: SyntheticOidcServer
) {
  return createHostedAccessFeature({
    environment: {
      NODE_ENV: 'test',
      AUTH_ALLOW_INSECURE_HTTP_FOR_TESTS: '1',
      AUTH_MODE: 'oidc',
      AUTH_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      AUTH_DEPLOYMENT_ID: 'deployment_synthetic-oidc-1',
      AUTH_IDENTITY_KEY_FILE: join(directory, 'secrets', 'identity.key'),
      HOSTED_WORKSPACE_IDS: WORKSPACE_ID,
      OIDC_PROVIDER_ID: 'synthetic-oidc',
      OIDC_PROVIDER_NAME: 'Synthetic OIDC',
      OIDC_ISSUER: ISSUER,
      OIDC_CLIENT_ID: CLIENT_ID,
      OIDC_ROLE_CLAIM: 'realm_access.roles',
      OIDC_OWNER_ROLE_VALUES: 'agent-teams-owner',
      OIDC_ADMIN_ROLE_VALUES: 'agent-teams-admin',
      OIDC_MEMBER_ROLE_VALUES: 'agent-teams-member',
      OIDC_VIEWER_ROLE_VALUES: 'agent-teams-viewer',
      OIDC_DEFAULT_ROLE: 'viewer',
    },
    storage,
    dataDirectory: directory,
    hostPlatform: hostPlatform(),
    localControlTransportFactory: unusedLocalControlTransport,
    drainProof: { confirmDrained: () => Promise.resolve({ status: 'unavailable' }) },
    runWithBrowserStreamsDrained: (operation) => operation(),
    now: () => NOW,
    fetch: idp.fetch,
  });
}

function appHarness(feature: Awaited<ReturnType<typeof featureHarness>>): FastifyInstance {
  const app = Fastify();
  apps.push(app);
  feature.http.register(app);
  app.get('/api/version', () => ({ ok: true }));
  app.post('/api/config/pin-session', () => ({ ok: true }));
  return app;
}

async function login(app: FastifyInstance, idp: SyntheticOidcServer, code: string) {
  const begun = await app.inject({
    method: 'GET',
    url: '/api/auth/oidc/login?returnTo=%2Fsynthetic',
    headers: { cookie: '__Host-agent-teams-session=attacker-fixed-session' },
  });
  expect(begun.statusCode).toBe(302);
  const authorization = idp.observeAuthorization(String(begun.headers.location));
  expect(authorization.searchParams.get('response_type')).toBe('code');
  expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
  const attemptCookies = cookies(begun);
  expect(attemptCookies).toHaveLength(2);
  expect(attemptCookies.every((value) => value.includes('HttpOnly'))).toBe(true);
  expect(attemptCookies.every((value) => value.includes('SameSite=Lax'))).toBe(true);
  const state = String(authorization.searchParams.get('state'));
  const callback = await app.inject({
    method: 'GET',
    url: `/api/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    headers: {
      cookie: cookieHeader(attemptCookies, [
        '__Host-agent-teams-oidc-attempt',
        '__Host-agent-teams-oidc-state',
      ]),
    },
  });
  expect(callback.statusCode, callback.body).toBe(302);
  expect(callback.headers.location).toBe('/synthetic');
  const callbackCookies = cookies(callback);
  expect(callbackCookies).toHaveLength(3);
  const session = cookieValue(callbackCookies, '__Host-agent-teams-session');
  expect(session).not.toBe('attacker-fixed-session');
  expect(callbackCookies[0]).toContain('HttpOnly');
  expect(callbackCookies[0]).toContain('SameSite=Strict');
  return { attemptCookies, callbackCookies, session, state };
}

async function keycloakFeatureHarness(input: {
  readonly directory: string;
  readonly storage: HostedAuthStorageGateway;
  readonly issuer: string;
  readonly publicOrigin: string;
}): Promise<HostedAccessFeature> {
  return createHostedAccessFeature({
    environment: {
      NODE_ENV: 'test',
      AUTH_ALLOW_INSECURE_HTTP_FOR_TESTS: '1',
      AUTH_MODE: 'oidc',
      AUTH_PUBLIC_ORIGIN: input.publicOrigin,
      AUTH_DEPLOYMENT_ID: 'deployment_keycloak-e2e-1',
      AUTH_IDENTITY_KEY_FILE: join(input.directory, 'secrets', 'identity.key'),
      HOSTED_WORKSPACE_IDS: `${KEYCLOAK_MEMBER_WORKSPACE_ID},${KEYCLOAK_OWNER_WORKSPACE_ID}`,
      OIDC_PROVIDER_ID: 'keycloak',
      OIDC_PROVIDER_NAME: 'Keycloak',
      OIDC_ISSUER: input.issuer,
      OIDC_CLIENT_ID: CLIENT_ID,
      OIDC_CLIENT_SECRET_FILE: join(input.directory, 'keycloak-sandbox', 'client-secret'),
      OIDC_ROLE_CLAIM: 'realm_access.roles',
      OIDC_OWNER_ROLE_VALUES: 'agent-teams-owner',
      OIDC_ADMIN_ROLE_VALUES: 'agent-teams-admin',
      OIDC_MEMBER_ROLE_VALUES: 'agent-teams-member',
      OIDC_VIEWER_ROLE_VALUES: 'agent-teams-viewer',
      OIDC_DEFAULT_ROLE: 'viewer',
    },
    storage: input.storage,
    dataDirectory: input.directory,
    hostPlatform: hostPlatform(),
    localControlTransportFactory: unusedLocalControlTransport,
    drainProof: {
      confirmDrained: () => Promise.resolve({ status: 'unavailable' }),
    },
    runWithBrowserStreamsDrained: (operation) => operation(),
    now: Date.now,
  });
}

async function listeningApp(
  feature: HostedAccessFeature,
  port: number,
  captureBackchannelToken: (token: string) => void
): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  app.addHook('preHandler', (request) => {
    if (request.url === '/api/auth/oidc/backchannel-logout') {
      const token = (request.body as Row | null)?.logout_token;
      if (typeof token === 'string') captureBackchannelToken(token);
    }
    return Promise.resolve();
  });
  feature.http.register(app);
  app.get('/api/version', () => ({ ok: true }));
  app.get('/api/projects', () => [
    { id: KEYCLOAK_MEMBER_WORKSPACE_ID, name: 'Member workspace' },
    { id: KEYCLOAK_OWNER_WORKSPACE_ID, name: 'Owner workspace' },
  ]);
  app.post('/api/config/pin-session', () => ({ ok: true }));
  await app.listen({ host: '127.0.0.1', port });
  return app;
}

async function closeTrackedApp(app: FastifyInstance): Promise<void> {
  const index = apps.indexOf(app);
  if (index >= 0) apps.splice(index, 1);
  await app.close();
}

async function keycloakLogin(
  app: FastifyInstance,
  account: { readonly username: string; readonly password: string }
): Promise<{
  readonly session: string;
  readonly providerCookies: BrowserCookieJar;
  readonly status: {
    readonly csrfToken: string;
    readonly principal: { readonly userId: string; readonly role: string };
  };
}> {
  const begun = await app.inject({
    method: 'GET',
    url: '/api/auth/oidc/login?returnTo=%2Fsynthetic',
    headers: { cookie: '__Host-agent-teams-session=attacker-fixed-session' },
  });
  expect(begun.statusCode, begun.body).toBe(302);
  const authorizationUrl = String(begun.headers.location);
  const authorization = new URL(authorizationUrl);
  expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
  const redirectUri = authorization.searchParams.get('redirect_uri');
  if (!redirectUri) throw new Error('hosted_keycloak_e2e_redirect_uri_missing');
  const attemptCookies = cookies(begun);
  const { callbackUrl, providerCookies } = await keycloakAuthorizationCode(
    authorizationUrl,
    account,
    new URL(redirectUri).origin
  );
  expect(callbackUrl.searchParams.get('state')).toBe(authorization.searchParams.get('state'));
  const callback = await app.inject({
    method: 'GET',
    url: `${callbackUrl.pathname}${callbackUrl.search}`,
    headers: {
      cookie: cookieHeader(attemptCookies, [
        '__Host-agent-teams-oidc-attempt',
        '__Host-agent-teams-oidc-state',
      ]),
    },
  });
  expect(callback.statusCode, callback.body).toBe(302);
  const session = cookieValue(cookies(callback), '__Host-agent-teams-session');
  expect(session).not.toBe('attacker-fixed-session');
  const statusResponse = await app.inject({
    method: 'GET',
    url: '/api/auth/status',
    headers: { cookie: `__Host-agent-teams-session=${session}` },
  });
  expect(statusResponse.statusCode, statusResponse.body).toBe(200);
  const status = statusResponse.json<{
    csrfToken: string;
    principal: { userId: string; role: string };
  }>();
  return { session, providerCookies, status };
}

function htmlAttribute(tag: string, name: string): string | null {
  for (const match of tag.matchAll(/\b([A-Za-z][\w:-]*)=["']([^"']*)["']/gu)) {
    if (match[1]?.toLowerCase() === name.toLowerCase()) {
      return decodeHtmlAttribute(match[2] ?? '');
    }
  }
  return null;
}

async function completeKeycloakGlobalLogout(
  redirectUrl: string,
  providerCookies: BrowserCookieJar,
  publicOrigin: string
): Promise<void> {
  const providerOrigin = new URL(redirectUrl).origin;
  const isCallback = (url: URL): boolean => url.origin === publicOrigin;
  let currentUrl = new URL(redirectUrl);
  let response = await fetchWithProviderCookies(providerCookies, currentUrl);
  let navigation = await followProviderNavigation({
    jar: providerCookies,
    initialUrl: currentUrl,
    initialResponse: response,
    providerOrigin,
    isCallback,
  });
  if (navigation.kind === 'callback') return;
  currentUrl = navigation.url;
  response = navigation.response;
  if (!response.ok) throw new Error('hosted_keycloak_e2e_global_logout_failed');
  const html = await response.text();
  const form = /<form\b[^>]*>/iu.exec(html)?.[0];
  const action = form ? htmlAttribute(form, 'action') : null;
  if (!action) throw new Error('hosted_keycloak_e2e_logout_confirmation_missing');
  const body = new URLSearchParams();
  for (const input of html.matchAll(/<input\b[^>]*>/giu)) {
    const name = htmlAttribute(input[0], 'name');
    const value = htmlAttribute(input[0], 'value');
    if (name && value !== null) body.set(name, value);
  }
  body.set('confirmLogout', 'Logout');
  currentUrl = new URL(action, currentUrl);
  response = await fetchWithProviderCookies(providerCookies, currentUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  navigation = await followProviderNavigation({
    jar: providerCookies,
    initialUrl: currentUrl,
    initialResponse: response,
    providerOrigin,
    isCallback,
  });
  expect(navigation.kind).toBe('callback');
}

describe('generic OIDC hosted authentication synthetic sandbox E2E', () => {
  it('runs code/nonce/PKCE login, durable sessions, reauthentication roles and back-channel logout', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hosted-oidc-e2e-'));
    directories.push(directory);
    const storage = new SyntheticOidcStorage();
    const idp = new SyntheticOidcServer();
    const feature = await featureHarness(directory, storage, idp);
    const app = appHarness(feature);

    const first = await login(app, idp, 'authorization-code-1');
    expect(idp.tokenExchangeCount).toBe(1);
    const firstStatus = await app.inject({
      method: 'GET',
      url: '/api/auth/status',
      headers: { cookie: `__Host-agent-teams-session=${first.session}` },
    });
    expect(firstStatus.json()).toMatchObject({
      authenticated: true,
      mode: 'oidc',
      principal: {
        displayName: 'Synthetic OIDC User',
        role: 'member',
        authenticationMethod: 'oidc',
      },
    });
    const firstBody = firstStatus.json<{
      csrfToken: string;
      principal: { userId: string };
    }>();
    expect(firstBody.csrfToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const grant = await feature.localAdministration.grantWorkspace(
      firstBody.principal.userId,
      WORKSPACE_ID
    );

    const command = await app.inject({
      method: 'POST',
      url: '/api/config/pin-session',
      headers: {
        cookie: `__Host-agent-teams-session=${first.session}`,
        origin: PUBLIC_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'x-agent-teams-csrf': firstBody.csrfToken,
      },
      payload: { projectId: grant.workspaceId, sessionId: 'session-synthetic' },
    });
    expect(command.statusCode).toBe(200);

    await feature.localAdministration.setLocalRole(firstBody.principal.userId, 'owner');
    const unchangedSnapshot = await app.inject({
      method: 'GET',
      url: '/api/auth/status',
      headers: { cookie: `__Host-agent-teams-session=${first.session}` },
    });
    expect(unchangedSnapshot.json()).toMatchObject({ principal: { role: 'member' } });

    const second = await login(app, idp, 'authorization-code-2');
    expect(idp.tokenExchangeCount).toBe(2);
    const ownerStatus = await app.inject({
      method: 'GET',
      url: '/api/auth/status',
      headers: { cookie: `__Host-agent-teams-session=${second.session}` },
    });
    expect(ownerStatus.json()).toMatchObject({
      authenticated: true,
      principal: { userId: firstBody.principal.userId, role: 'owner' },
    });

    const replay = await app.inject({
      method: 'GET',
      url: `/api/auth/oidc/callback?code=replay&state=${encodeURIComponent(first.state)}`,
      headers: {
        cookie: cookieHeader(first.attemptCookies, [
          '__Host-agent-teams-oidc-attempt',
          '__Host-agent-teams-oidc-state',
        ]),
      },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual({ error: 'oidc_state_invalid_or_replayed' });
    expect(idp.tokenExchangeCount).toBe(2);

    const localLogout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        cookie: `__Host-agent-teams-session=${first.session}`,
        origin: PUBLIC_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'x-agent-teams-csrf': firstBody.csrfToken,
      },
      payload: { global: false },
    });
    expect(localLogout.statusCode).toBe(200);
    expect(localLogout.json()).toEqual({
      ok: true,
      redirectUrl: null,
      providerLogoutError: null,
    });

    const restartedFeature = await featureHarness(directory, storage, idp);
    const restartedApp = appHarness(restartedFeature);
    const afterRestart = await restartedApp.inject({
      method: 'GET',
      url: '/api/auth/status',
      headers: { cookie: `__Host-agent-teams-session=${second.session}` },
    });
    expect(afterRestart.json()).toMatchObject({
      authenticated: true,
      principal: { role: 'owner' },
    });

    const logoutToken = signedJwt({
      iss: ISSUER,
      sub: 'subject-synthetic-1',
      sid: 'provider-session-synthetic-1',
      aud: CLIENT_ID,
      exp: NOW / 1000 + 300,
      iat: NOW / 1000,
      jti: 'logout-synthetic-1',
      events: { [BACKCHANNEL_EVENT]: {} },
    });
    const backchannel = await restartedApp.inject({
      method: 'POST',
      url: '/api/auth/oidc/backchannel-logout',
      payload: { logout_token: logoutToken },
    });
    expect(backchannel.statusCode).toBe(204);
    const revoked = await restartedApp.inject({
      method: 'GET',
      url: '/api/auth/status',
      headers: { cookie: `__Host-agent-teams-session=${second.session}` },
    });
    expect(revoked.json()).toMatchObject({ authenticated: false, mode: 'oidc' });
    const replayedLogout = await restartedApp.inject({
      method: 'POST',
      url: '/api/auth/oidc/backchannel-logout',
      payload: { logout_token: logoutToken },
    });
    expect(replayedLogout.statusCode).toBe(400);
    expect(storage.audits.some((event) => event.action === 'auth.oidc.login')).toBe(true);

    idp.offline = true;
    const outageFeature = await featureHarness(directory, storage, idp);
    const outageApp = appHarness(outageFeature);
    const unavailable = await outageApp.inject({
      method: 'GET',
      url: '/api/auth/oidc/login',
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ error: 'oidc_provider_unavailable' });
    const noPairingFallback = await outageApp.inject({
      method: 'POST',
      url: '/api/auth/personal/pair',
      headers: { origin: PUBLIC_ORIGIN, 'sec-fetch-site': 'same-origin' },
      payload: { pairingCode: 'pairing-code-is-never-a-fallback-123456789' },
    });
    expect(noPairingFallback.statusCode).toBe(404);
    expect(noPairingFallback.json()).toEqual({ error: 'auth_mode_mismatch' });
  });
});

describe('Keycloak production secret boundary', () => {
  it('keeps the Electron preload CommonJS and desktop composition boundary intact', async () => {
    const electronConfig = await readFile(join(process.cwd(), 'electron.vite.config.ts'), 'utf8');
    const mainEntry = await readFile(join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const preloadEntry = await readFile(join(process.cwd(), 'src/preload/index.ts'), 'utf8');
    const rendererEntry = await readFile(join(process.cwd(), 'src/renderer/main.tsx'), 'utf8');
    const authGate = await readFile(
      join(process.cwd(), 'src/features/hosted-access/renderer/HostedAuthGate.tsx'),
      'utf8'
    );

    expect(electronConfig).toContain("entryFileNames: '[name].cjs'");
    expect(mainEntry).toContain("preload: join(__dirname, '../preload/index.cjs')");
    expect(preloadEntry).toContain("contextBridge.exposeInMainWorld('electronAPI', electronAPI)");
    expect(rendererEntry).toMatch(
      /const app = window\.electronAPI \? \(\s*<App \/>\s*\) : \(\s*<HostedAuthGate onAuthenticated=\{initializeRendererWorkspace\}>/u
    );
    expect(rendererEntry).toContain('if (window.electronAPI) {');
    expect(rendererEntry).toContain('initializeRendererWorkspace();');
    expect(rendererEntry).toContain('dismissHostedStartupSplash();');
    expect(rendererEntry).toContain("document.getElementById('splash')?.remove();");
    expect(authGate).toContain('onAuthenticated?.();');
    expect(authGate.indexOf('onAuthenticated?.();')).toBeLessThan(
      authGate.indexOf("setState({ status: 'authenticated', auth });")
    );
  });

  it('keeps provider credentials in Docker secrets and a persistent read-only handoff', async () => {
    const compose = await readFile(join(process.cwd(), 'docker/docker-compose.yml'), 'utf8');
    const dockerfile = await readFile(join(process.cwd(), 'docker/Dockerfile'), 'utf8');
    const volumeInitializer = await readFile(
      join(process.cwd(), 'docker/hosted-volume-init.sh'),
      'utf8'
    );
    const dockerIgnore = await readFile(join(process.cwd(), '.dockerignore'), 'utf8');
    const hostedAuthDocs = await readFile(
      join(process.cwd(), 'docs/hosted-authentication.md'),
      'utf8'
    );
    const caddyfile = await readFile(join(process.cwd(), 'docker/caddy/Caddyfile'), 'utf8');
    const realmTemplate = await readFile(
      join(process.cwd(), 'docker/keycloak/realm-agent-teams.json'),
      'utf8'
    );
    expect(dockerfile).toContain('chown root:node /data/.agent-teams');
    expect(dockerfile).toContain('chown node:node /data/.agent-teams/data');
    expect(dockerfile).toContain('\nUSER node\n');
    const installInputs = [
      'COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./',
      'COPY patches ./patches',
      'COPY vendor/terminal-platform/sdk ./vendor/terminal-platform/sdk',
      'COPY vendor/terminal-platform/terminal-platform-node-stub ./vendor/terminal-platform/terminal-platform-node-stub',
    ].join('\n');
    expect(dockerfile).toContain(
      [
        installInputs,
        'COPY scripts/ci/enforce-pnpm-install.mjs ./scripts/ci/enforce-pnpm-install.mjs',
        'COPY scripts/ensure-electron-install.cjs ./scripts/ensure-electron-install.cjs',
        'RUN pnpm install --frozen-lockfile',
      ].join('\n')
    );
    expect(dockerfile).toContain(
      [
        installInputs,
        'COPY scripts/ci/verify-hosted-no-terminal-artifact.mjs /tmp/verify-hosted-no-terminal-artifact.mjs',
        'RUN pnpm install --frozen-lockfile --prod --ignore-scripts \\',
        '  && pnpm rebuild better-sqlite3 \\',
        '  && node /tmp/verify-hosted-no-terminal-artifact.mjs --root /app --prune --require-better-sqlite3',
      ].join('\n')
    );
    expect(dockerfile).toContain(
      'install -o node -g node -m 0600 /dev/null /run/agent-teams-oidc/oidc-client-secret'
    );
    expect(dockerfile).toContain('install -o node -g node -m 0600 /dev/null /caddy-trust/root.crt');
    expect(compose).toContain('OIDC_CLIENT_SECRET_FILE: /run/agent-teams-oidc/oidc-client-secret');
    expect(compose).toContain('agent-teams-keycloak-secret:/run/agent-teams-oidc:ro');
    expect(compose).toContain('agent-teams-keycloak-secret:/run/agent-teams-oidc');
    expect(compose.match(/agent-teams-keycloak-trust:\/caddy-trust:ro/gu)).toHaveLength(2);
    expect(compose).toContain(
      "command: ['/usr/local/bin/hosted-volume-init', 'oidc-client-secret']"
    );
    expect(volumeInitializer).toContain("readonly runtime_directory='/run/agent-teams-oidc'");
    expect(volumeInitializer).toContain('install -m 0400 "$source_secret" "$runtime_secret"');
    expect(volumeInitializer).toContain('chmod 0600 "$runtime_secret"');
    expect(compose).not.toContain('gosu');
    expect(dockerfile).not.toContain('gosu');
    expect(volumeInitializer).not.toContain('gosu');
    expect(compose).not.toContain('agent-teams-keycloak-runtime');
    expect(compose).toContain('/run/agent-teams:mode=0700,uid=1000,gid=1000');
    expect(compose.match(/user: '1000:1000'/gu)).toHaveLength(6);
    expect(compose).toContain("user: '1000:0'");
    expect(compose).toContain("user: '70:70'");
    expect(compose.match(/cap_add:\n\s+- NET_BIND_SERVICE/gu)).toHaveLength(2);
    expect(compose).toContain(
      'agent-teams-keycloak-secret-init:\n        condition: service_completed_successfully'
    );
    expect(compose).toContain(
      'keycloak-volume-init:\n        condition: service_completed_successfully'
    );
    expect(
      compose.match(/keycloak-volume-init:\n\s+condition: service_completed_successfully/gu)
    ).toHaveLength(2);
    expect(compose).not.toContain('source: oidc_client_secret');
    expect(compose).toContain(
      'file: ${HOSTED_SECRETS_DIR:?Set HOSTED_SECRETS_DIR to an absolute protected directory outside the repository}/oidc_client_secret'
    );
    expect(compose.match(/file: \$\{HOSTED_SECRETS_DIR:\?/gu)).toHaveLength(3);
    expect(compose).not.toContain('file: ./secrets/');
    expect(compose).not.toContain('docker/secrets');
    expect(dockerIgnore.split(/\r?\n/u)).toContain('docker/secrets/');
    await expect(lstat(join(process.cwd(), 'docker/secrets/.gitignore'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(hostedAuthDocs).toContain('outside the repository and every Docker build context');
    expect(hostedAuthDocs).toContain('HOSTED_SECRETS_DIR');
    expect(hostedAuthDocs).toContain('Keep the external directory mode `0700`');
    expect(hostedAuthDocs).toContain('uid`, `gid` and `mode` long-syntax fields are not portably');
    expect(compose).toContain("entrypoint: ['/bin/bash', '-euc']");
    expect(compose).toContain('/opt/keycloak/bin/kc.sh --config-file=/run/keycloak/keycloak.conf');
    expect(compose).toContain('--config-file=/run/keycloak/keycloak.conf');
    expect(compose).toContain('/opt/keycloak/data/import:mode=0700,uid=1000,gid=0');
    expect(compose).toContain('NODE_EXTRA_CA_CERTS: /caddy-trust/root.crt');
    expect(compose).toContain('KC_TRUSTSTORE_PATHS: /caddy-trust/root.crt');
    expect(compose.match(/- caddy-data:\/caddy-data:ro/gu)).toHaveLength(1);
    expect(compose).toContain("command: ['/usr/local/bin/hosted-volume-init', 'caddy-trust']");
    expect(compose).toContain('agent-teams-keycloak-trust:');
    expect(volumeInitializer).toContain("readonly trust_directory='/caddy-trust'");
    expect(volumeInitializer).toContain('install -m 0444 "$root_certificate" "$trust_certificate"');
    expect(volumeInitializer).toContain('1000:1000:600|1000:1000:444');
    expect(volumeInitializer).toContain("'1000:1000:444'");
    expect(volumeInitializer).not.toContain('root.key');
    expect(volumeInitializer).toContain('[ "$(id -u)" -ne 1000 ]');
    expect(hostedAuthDocs).toContain('private root key and every other PKI artifact are absent');
    expect(dockerfile).toContain(
      'FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}@${KEYCLOAK_IMAGE_DIGEST} AS keycloak-build'
    );
    expect(dockerfile).toContain(
      'RUN /opt/keycloak/bin/kc.sh build --db=postgres --health-enabled=true'
    );
    expect(compose).toContain('target: keycloak-runtime');
    expect(compose).toContain('KC_DB: postgres');
    expect(compose).toContain("KC_HEALTH_ENABLED: 'true'");
    expect(compose).toContain('start --optimized --import-realm');
    expect(compose).toContain(
      'resolved_realm="$${resolved_realm//\\$\\{HOSTED_PUBLIC_ORIGIN\\}/$$HOSTED_PUBLIC_ORIGIN}"'
    );
    expect(compose).toContain("*'$${KEYCLOAK_CLIENT_SECRET}'*|*'$${HOSTED_PUBLIC_ORIGIN}'*)");
    expect(compose).toContain('validate_domain HOSTED_DOMAIN "$$HOSTED_DOMAIN"');
    expect(compose).toContain('validate_domain KEYCLOAK_DOMAIN "$$KEYCLOAK_DOMAIN"');
    expect(compose).toContain('HOSTED_DOMAIN and KEYCLOAK_DOMAIN must be distinct');
    expect(compose).toContain(
      'HOSTED_PUBLIC_ORIGIN must match HOSTED_DOMAIN and HOSTED_HTTPS_PORT'
    );
    expect(compose).toContain(
      'KEYCLOAK_PUBLIC_ORIGIN must match KEYCLOAK_DOMAIN and HOSTED_HTTPS_PORT'
    );
    expect(compose).toContain(
      'OIDC_ISSUER: ${KEYCLOAK_PUBLIC_ORIGIN:-https://${KEYCLOAK_DOMAIN:-auth.agent-teams.localhost}}/realms/agent-teams'
    );
    expect(compose).toContain(
      'KC_HOSTNAME: ${KEYCLOAK_PUBLIC_ORIGIN:-https://${KEYCLOAK_DOMAIN:-auth.agent-teams.localhost}}'
    );
    expect(caddyfile).toContain('{$HOSTED_DOMAIN:agent-teams.localhost}:{$HOSTED_HTTPS_PORT:443}');
    expect(caddyfile).toContain(
      '{$KEYCLOAK_DOMAIN:auth.agent-teams.localhost}:{$HOSTED_HTTPS_PORT:443}'
    );
    expect(caddyfile).toContain('reverse_proxy agent-teams-keycloak:3456');
    expect(caddyfile).toContain('reverse_proxy keycloak:8080');
    expect(caddyfile).not.toContain('@keycloak path');
    expect(compose).toContain("'${HOSTED_HTTPS_PORT:-443}:${HOSTED_HTTPS_PORT:-443}'");
    const composeLines = compose.split('\n').map((line) => line.trim());
    expect(composeLines.some((line) => line.startsWith('KC_DB_PASSWORD:'))).toBe(false);
    expect(composeLines.some((line) => line.startsWith('KC_BOOTSTRAP_ADMIN_PASSWORD:'))).toBe(
      false
    );
    expect(compose).not.toContain('export KEYCLOAK_CLIENT_SECRET=');
    expect(compose).not.toContain('export KC_BOOTSTRAP_ADMIN_PASSWORD=');
    expect(compose).not.toContain('export KC_DB_PASSWORD=');
    expect(
      composeLines.filter((line) =>
        line.startsWith('TRUSTED_PROXY_CIDRS: ${HOSTED_CADDY_IPV4:-172.30.255.2}/32')
      )
    ).toHaveLength(2);
    expect(compose).not.toContain('TRUSTED_PROXY_CIDRS: 172.16.0.0/12');
    expect(compose).toContain('subnet: ${HOSTED_NETWORK_SUBNET:-172.30.255.0/28}');
    expect(compose.match(/caddy(?:-personal)?:\n\s+condition: service_healthy/gu)).toHaveLength(4);
    const caddyServiceStart = compose.indexOf('\n  caddy:\n');
    const caddyPersonalServiceStart = compose.indexOf('\n  caddy-personal:\n');
    expect(caddyServiceStart).toBeGreaterThanOrEqual(0);
    expect(caddyPersonalServiceStart).toBeGreaterThan(caddyServiceStart);
    const caddyService = compose.slice(caddyServiceStart, caddyPersonalServiceStart);
    expect(caddyService).not.toContain('\n      - keycloak');
    expect(caddyService).not.toContain('\n      keycloak:');
    expect(
      compose.match(/test -s \/data\/caddy\/pki\/authorities\/local\/root\.crt/gu)
    ).toHaveLength(2);
    expect(compose).toContain('keycloak-backend:');
    expect(compose).toContain('HOSTED_KEYCLOAK_BACKEND_SUBNET:-172.30.254.0/28');
    expect(compose).toContain('HOSTED_POSTGRES_IPV4:-172.30.254.2');

    const syntheticDomain = 'auth-profile.example.test';
    const syntheticOrigin = `https://${syntheticDomain}:8443`;
    const resolvedRealm = realmTemplate
      .replaceAll('${KEYCLOAK_CLIENT_SECRET}', 'synthetic-client-secret')
      .replaceAll('${HOSTED_PUBLIC_ORIGIN}', syntheticOrigin);
    expect(resolvedRealm).not.toContain('${');
    const realm = JSON.parse(resolvedRealm) as Row;
    expect(realm).toMatchObject({
      registrationAllowed: false,
      resetPasswordAllowed: true,
      bruteForceProtected: true,
      permanentLockout: false,
      failureFactor: 5,
      maxFailureWaitSeconds: 900,
      // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- Keycloak policy syntax, not a credential.
      passwordPolicy: 'length(12) and notUsername(undefined) and maxLength(128)',
    });
    const client = (realm.clients as Row[]).find(
      (candidate) => candidate.clientId === 'agent-teams-hosted'
    );
    expect(client?.secret).toBe('synthetic-client-secret');
    expect(client).toMatchObject({
      redirectUris: [`${syntheticOrigin}/api/auth/oidc/callback`],
      webOrigins: [syntheticOrigin],
      attributes: {
        'backchannel.logout.url': `${syntheticOrigin}/api/auth/oidc/backchannel-logout`,
        'backchannel.logout.session.required': 'true',
        'backchannel.logout.revoke.offline.tokens': 'false',
        'post.logout.redirect.uris': `${syntheticOrigin}/`,
        'pkce.code.challenge.method': 'S256',
      },
    });
    const realmRoleMapper = (client?.protocolMappers as Row[]).find(
      (mapper) => mapper.protocolMapper === 'oidc-usermodel-realm-role-mapper'
    );
    expect(realmRoleMapper).toMatchObject({
      protocol: 'openid-connect',
      config: {
        multivalued: 'true',
        'id.token.claim': 'true',
        'claim.name': 'realm_access.roles',
        'jsonType.label': 'String',
      },
    });
  });
});

describe('Keycloak hosted authentication disposable sandbox E2E', () => {
  it.skipIf(!runKeycloakE2e)(
    'delivers real Keycloak back-channel logout to the loopback handler and rejects replay',
    async () => {
      const directory = createKeycloakE2eDirectory('hosted-keycloak-backchannel-');
      directories.push(directory);
      const publicOrigin = `http://127.0.0.1:${HOSTED_APP_E2E_PORT}`;
      const storage = nativeStorageHarness(directory);
      const capturedBackchannelTokens: string[] = [];
      const sandbox = await runKeycloakE2ePhase(
        'backchannel_sandbox_start',
        () =>
          startKeycloakSandbox({
            directory,
            keycloakPort: KEYCLOAK_E2E_PORT,
            publicOrigin,
            backchannelUrl: `${publicOrigin}/api/auth/oidc/backchannel-logout`,
          }),
        KEYCLOAK_E2E_STARTUP_TIMEOUT_MS
      );
      const feature = await runKeycloakE2ePhase('backchannel_application_compose', () =>
        keycloakFeatureHarness({
          directory,
          storage,
          issuer: sandbox.issuer,
          publicOrigin,
        })
      );
      const app = await runKeycloakE2ePhase('backchannel_application_listen', () =>
        listeningApp(feature, HOSTED_APP_E2E_PORT, (token) => capturedBackchannelTokens.push(token))
      );
      const owner = await runKeycloakE2ePhase('backchannel_owner_login', () =>
        keycloakLogin(app, sandbox.owner)
      );
      expect(owner.status.principal.role).toBe('owner');

      const tokensBeforeAdminLogout = capturedBackchannelTokens.length;
      await runKeycloakE2ePhase('backchannel_admin_session_delete', () =>
        sandbox.removeUserSessions(sandbox.owner.username)
      );
      await runKeycloakE2ePhase('backchannel_application_revocation', () =>
        waitFor(
          'backchannel_application_revocation',
          async () => {
            const status = await app.inject({
              method: 'GET',
              url: '/api/auth/status',
              headers: { cookie: `__Host-agent-teams-session=${owner.session}` },
            });
            return (
              status.json<{ authenticated: boolean }>().authenticated === false &&
              capturedBackchannelTokens.length > tokensBeforeAdminLogout
            );
          },
          30_000
        )
      );
      const capturedLogoutToken = capturedBackchannelTokens.at(-1);
      expect(capturedLogoutToken).toBeTypeOf('string');
      await runKeycloakE2ePhase('backchannel_replay_rejection', async () => {
        const replayed = await app.inject({
          method: 'POST',
          url: '/api/auth/oidc/backchannel-logout',
          payload: { logout_token: capturedLogoutToken },
        });
        expect(replayed.statusCode).toBe(400);
      });
    },
    240_000
  );

  it.skipIf(!runKeycloakE2e)(
    'maps member/owner roles and proves restart, local/global/back-channel logout and outage recovery',
    async () => {
      const directory = createKeycloakE2eDirectory('hosted-keycloak-e2e-');
      directories.push(directory);
      const keycloakPort = KEYCLOAK_E2E_PORT;
      const appPort = HOSTED_APP_E2E_PORT;
      const publicOrigin = `http://127.0.0.1:${appPort}`;
      const storage = nativeStorageHarness(directory);
      const capturedBackchannelTokens: string[] = [];
      const sandbox = await runKeycloakE2ePhase(
        'full_sandbox_start',
        () =>
          startKeycloakSandbox({
            directory,
            keycloakPort,
            publicOrigin,
            backchannelUrl: `${publicOrigin}/api/auth/oidc/backchannel-logout`,
          }),
        KEYCLOAK_E2E_STARTUP_TIMEOUT_MS
      );
      let feature = await runKeycloakE2ePhase('full_application_compose', () =>
        keycloakFeatureHarness({
          directory,
          storage,
          issuer: sandbox.issuer,
          publicOrigin,
        })
      );
      let app = await runKeycloakE2ePhase('full_application_listen', () =>
        listeningApp(feature, appPort, (token) => capturedBackchannelTokens.push(token))
      );

      const member = await runKeycloakE2ePhase(
        'full_member_role_workspace_local_logout',
        async () => {
          const loggedIn = await keycloakLogin(app, sandbox.member);
          expect(loggedIn.status.principal.role).toBe('member');
          const workspace = await feature.localAdministration.grantWorkspace(
            loggedIn.status.principal.userId,
            KEYCLOAK_MEMBER_WORKSPACE_ID
          );
          const projects = await app.inject({
            method: 'GET',
            url: '/api/projects',
            headers: { cookie: `__Host-agent-teams-session=${loggedIn.session}` },
          });
          expect(projects.statusCode, projects.body).toBe(200);
          expect(projects.json()).toEqual([
            { id: workspace.workspaceId, name: 'Member workspace' },
          ]);
          const logout = await app.inject({
            method: 'POST',
            url: '/api/auth/logout',
            headers: {
              cookie: `__Host-agent-teams-session=${loggedIn.session}`,
              origin: publicOrigin,
              'sec-fetch-site': 'same-origin',
              'x-agent-teams-csrf': loggedIn.status.csrfToken,
            },
            payload: { global: false },
          });
          expect(logout.statusCode, logout.body).toBe(200);
          expect(logout.json()).toMatchObject({ redirectUrl: null });
          const afterLogout = await app.inject({
            method: 'GET',
            url: '/api/auth/status',
            headers: { cookie: `__Host-agent-teams-session=${loggedIn.session}` },
          });
          expect(afterLogout.json()).toMatchObject({ authenticated: false, mode: 'oidc' });
          return loggedIn;
        }
      );
      expect(member.session).toBeTypeOf('string');

      const owner = await runKeycloakE2ePhase('full_owner_role_workspace', async () => {
        const loggedIn = await keycloakLogin(app, sandbox.owner);
        expect(loggedIn.status.principal.role).toBe('owner');
        const workspace = await feature.localAdministration.grantWorkspace(
          loggedIn.status.principal.userId,
          KEYCLOAK_OWNER_WORKSPACE_ID
        );
        const projects = await app.inject({
          method: 'GET',
          url: '/api/projects',
          headers: { cookie: `__Host-agent-teams-session=${loggedIn.session}` },
        });
        expect(projects.statusCode, projects.body).toBe(200);
        expect(projects.json()).toEqual([{ id: workspace.workspaceId, name: 'Owner workspace' }]);
        return loggedIn;
      });

      const restarted = await runKeycloakE2ePhase('full_application_restart', async () => {
        await closeTrackedApp(app);
        const restartedFeature = await keycloakFeatureHarness({
          directory,
          storage,
          issuer: sandbox.issuer,
          publicOrigin,
        });
        const restartedApp = await listeningApp(restartedFeature, appPort, (token) =>
          capturedBackchannelTokens.push(token)
        );
        const status = await restartedApp.inject({
          method: 'GET',
          url: '/api/auth/status',
          headers: { cookie: `__Host-agent-teams-session=${owner.session}` },
        });
        expect(status.json()).toMatchObject({
          authenticated: true,
          principal: { userId: owner.status.principal.userId, role: 'owner' },
        });
        return { feature: restartedFeature, app: restartedApp };
      });
      feature = restarted.feature;
      app = restarted.app;

      await runKeycloakE2ePhase('full_provider_global_logout', async () => {
        const logout = await app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: {
            cookie: `__Host-agent-teams-session=${owner.session}`,
            origin: publicOrigin,
            'sec-fetch-site': 'same-origin',
            'x-agent-teams-csrf': owner.status.csrfToken,
          },
          payload: { global: true },
        });
        expect(logout.statusCode, logout.body).toBe(200);
        const providerLogoutUrl = logout.json<{ redirectUrl: string }>().redirectUrl;
        expect(new URL(providerLogoutUrl).origin).toBe(new URL(sandbox.issuer).origin);
        await completeKeycloakGlobalLogout(providerLogoutUrl, owner.providerCookies, publicOrigin);
        const status = await app.inject({
          method: 'GET',
          url: '/api/auth/status',
          headers: { cookie: `__Host-agent-teams-session=${owner.session}` },
        });
        expect(status.json()).toMatchObject({ authenticated: false, mode: 'oidc' });
      });

      const backchannelOwner = await runKeycloakE2ePhase('full_backchannel_owner_login', () =>
        keycloakLogin(app, sandbox.owner)
      );
      const tokensBeforeAdminLogout = capturedBackchannelTokens.length;
      await runKeycloakE2ePhase('full_backchannel_admin_session_delete', () =>
        sandbox.removeUserSessions(sandbox.owner.username)
      );
      await runKeycloakE2ePhase('full_backchannel_application_revocation', () =>
        waitFor(
          'full_backchannel_application_revocation',
          async () => {
            const status = await app.inject({
              method: 'GET',
              url: '/api/auth/status',
              headers: { cookie: `__Host-agent-teams-session=${backchannelOwner.session}` },
            });
            return (
              status.json<{ authenticated: boolean }>().authenticated === false &&
              capturedBackchannelTokens.length > tokensBeforeAdminLogout
            );
          },
          30_000
        )
      );
      const capturedLogoutToken = capturedBackchannelTokens.at(-1);
      expect(capturedLogoutToken).toBeTypeOf('string');
      await runKeycloakE2ePhase('full_backchannel_replay_rejection', async () => {
        const replayed = await app.inject({
          method: 'POST',
          url: '/api/auth/oidc/backchannel-logout',
          payload: { logout_token: capturedLogoutToken },
        });
        expect(replayed.statusCode).toBe(400);
      });

      const outage = await runKeycloakE2ePhase(
        'full_provider_outage_application_restart',
        async () => {
          await sandbox.stop();
          await closeTrackedApp(app);
          const outageFeature = await keycloakFeatureHarness({
            directory,
            storage,
            issuer: sandbox.issuer,
            publicOrigin,
          });
          const outageApp = await listeningApp(outageFeature, appPort, (token) =>
            capturedBackchannelTokens.push(token)
          );
          return { feature: outageFeature, app: outageApp };
        }
      );
      feature = outage.feature;
      app = outage.app;
      await runKeycloakE2ePhase('full_provider_outage_no_pairing_fallback', async () => {
        const unavailable = await app.inject({
          method: 'GET',
          url: '/api/auth/oidc/login',
        });
        expect(unavailable.statusCode).toBe(503);
        expect(unavailable.json()).toEqual({ error: 'oidc_provider_unavailable' });
        const noPairingFallback = await app.inject({
          method: 'POST',
          url: '/api/auth/personal/pair',
          headers: { origin: publicOrigin, 'sec-fetch-site': 'same-origin' },
          payload: { pairingCode: 'pairing-is-never-an-outage-fallback-123456789' },
        });
        expect(noPairingFallback.statusCode).toBe(404);
        expect(noPairingFallback.json()).toEqual({ error: 'auth_mode_mismatch' });
      });

      await runKeycloakE2ePhase(
        'full_provider_recovery',
        async () => {
          await sandbox.start();
          const recovered = await keycloakLogin(app, sandbox.member);
          expect(recovered.status.principal.role).toBe('member');
        },
        KEYCLOAK_E2E_STARTUP_TIMEOUT_MS
      );
    },
    300_000
  );
});
