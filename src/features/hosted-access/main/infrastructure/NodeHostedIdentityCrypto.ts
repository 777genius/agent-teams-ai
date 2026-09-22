import {
  type HostedSessionId,
  parseAuditEventId,
  parseHostedSessionId,
  parseHostedWorkspaceId,
  parseOidcLoginAttemptId,
  parseUserId,
} from '../../contracts';

import type {
  HostedAuthHostPlatform,
  HostedAuthPathStat,
  HostedIdentityCryptoPort,
} from '../../core/application';

const KEY_BYTES = 32;

export interface HostedAuthSecretPaths {
  readonly identityKeyPath: string;
  readonly personalKeyringPath: string;
  readonly stagedKeyringDirectory: string;
}

const DOCKER_SERVICE_SECRET_PATH = /^\/run\/secrets\/[A-Za-z0-9._-]+$/;
const MAXIMUM_OIDC_CLIENT_SECRET_BYTES = 8_192;
const MAXIMUM_IDENTITY_KEY_BYTES = 256;

function assertOwnedPath(
  stat: HostedAuthPathStat,
  platform: HostedAuthHostPlatform,
  kind: 'directory' | 'file',
  errorCode: string
): void {
  const expectedKind = kind === 'directory' ? stat.isDirectory() : stat.isFile();
  if (
    !expectedKind ||
    stat.isSymbolicLink() ||
    (platform.uid !== undefined && stat.uid !== platform.uid)
  ) {
    throw new Error(errorCode);
  }
}

function isDockerServiceSecretPath(path: string, platform: HostedAuthHostPlatform): boolean {
  const normalizedPath = platform.join(path);
  return normalizedPath === path && DOCKER_SERVICE_SECRET_PATH.test(normalizedPath);
}

function sameFileIdentity(left: HostedAuthPathStat, right: HostedAuthPathStat): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertPrivateOwnedDirectory(
  stat: HostedAuthPathStat,
  platform: HostedAuthHostPlatform,
  errorCode: string
): void {
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (platform.uid !== undefined && stat.uid !== platform.uid)
  ) {
    throw new Error(errorCode);
  }
}

function validSecretOwner(
  stat: HostedAuthPathStat,
  platform: HostedAuthHostPlatform,
  _dockerServicePath: boolean
): boolean {
  if (platform.uid === undefined) return true;
  return stat.uid === platform.uid;
}

function assertSafeSecretDirectory(
  stat: HostedAuthPathStat,
  platform: HostedAuthHostPlatform,
  _dockerServicePath: boolean,
  errorCode: string
): void {
  const writableByOthers = (stat.mode & 0o022) !== 0;
  const protectedStickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0 && stat.isDirectory();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (writableByOthers && !protectedStickyRoot) ||
    (platform.uid !== undefined && stat.uid !== platform.uid && stat.uid !== 0)
  ) {
    throw new Error(errorCode);
  }
}

function assertSafeSecretFile(
  stat: HostedAuthPathStat,
  platform: HostedAuthHostPlatform,
  dockerServicePath: boolean,
  errorCode: string
): void {
  if (
    !stat.isFile() ||
    stat.isSocket() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    !validSecretOwner(stat, platform, dockerServicePath)
  ) {
    throw new Error(errorCode);
  }
}

async function snapshotSecretParentChain(
  path: string,
  platform: HostedAuthHostPlatform,
  dockerServicePath: boolean,
  errorCode: string
): Promise<readonly { readonly path: string; readonly stat: HostedAuthPathStat }[]> {
  const parents: { path: string; stat: HostedAuthPathStat }[] = [];
  let current = platform.dirname(path);
  for (;;) {
    const stat = await platform.lstat(current);
    assertSafeSecretDirectory(stat, platform, dockerServicePath, errorCode);
    parents.push({ path: current, stat });
    const parent = platform.dirname(current);
    if (parent === current) return parents;
    current = parent;
  }
}

export async function prepareHostedAuthSecretPaths(
  input: {
    readonly dataDirectory: string;
    readonly identityKeyPath?: string;
  },
  platform: HostedAuthHostPlatform
): Promise<HostedAuthSecretPaths> {
  if (!platform.isAbsolute(input.dataDirectory)) {
    throw new Error('hosted_auth_data_directory_invalid');
  }
  const secretsDirectory = platform.join(input.dataDirectory, 'hosted-auth-secrets');
  await platform.mkdir(secretsDirectory, 0o700);
  const secretsStat = await platform.lstat(secretsDirectory);
  assertOwnedPath(secretsStat, platform, 'directory', 'hosted_auth_secret_directory_invalid');
  await platform.chmod(secretsDirectory, 0o700);
  const identityKeyPath = input.identityKeyPath ?? platform.join(secretsDirectory, 'identity.key');
  if (!platform.isAbsolute(identityKeyPath) || platform.join(identityKeyPath) !== identityKeyPath) {
    throw new Error('hosted_auth_identity_key_path_invalid');
  }
  const identityKeyDirectory = platform.dirname(identityKeyPath);
  await platform.mkdir(identityKeyDirectory, 0o700);
  const identityDirectoryStat = await platform.lstat(identityKeyDirectory);
  assertOwnedPath(
    identityDirectoryStat,
    platform,
    'directory',
    'hosted_auth_identity_key_directory_invalid'
  );
  await platform.chmod(identityKeyDirectory, 0o700);
  return Object.freeze({
    identityKeyPath,
    personalKeyringPath: platform.join(secretsDirectory, 'personal-keyring.json'),
    stagedKeyringDirectory: platform.join(secretsDirectory, 'staged'),
  });
}

export async function readProtectedHostedAuthSecret(
  path: string,
  platform: HostedAuthHostPlatform
): Promise<string> {
  const errorCode = 'hosted_auth_config_invalid:OIDC_CLIENT_SECRET_FILE';
  if (!platform.isAbsolute(path) || platform.join(path) !== path) throw new Error(errorCode);
  const dockerServicePath = isDockerServiceSecretPath(path, platform);
  const parentChain = await snapshotSecretParentChain(path, platform, dockerServicePath, errorCode);
  const before = await platform.lstat(path);
  assertSafeSecretFile(before, platform, dockerServicePath, errorCode);
  const handle = await platform.openReadOnlyNoFollow(path).catch(() => {
    throw new Error(errorCode);
  });
  try {
    const opened = await handle.stat();
    assertSafeSecretFile(opened, platform, dockerServicePath, errorCode);
    if (!sameFileIdentity(before, opened)) throw new Error(errorCode);
    const after = await platform.lstat(path);
    assertSafeSecretFile(after, platform, dockerServicePath, errorCode);
    if (!sameFileIdentity(opened, after)) throw new Error(errorCode);
    for (const parent of parentChain) {
      const observed = await platform.lstat(parent.path);
      assertSafeSecretDirectory(observed, platform, dockerServicePath, errorCode);
      if (!sameFileIdentity(parent.stat, observed)) throw new Error(errorCode);
    }
    const value = (await handle.readTextBounded(MAXIMUM_OIDC_CLIENT_SECRET_BYTES)).trim();
    if (value.length === 0 || platform.byteLength(value) > MAXIMUM_OIDC_CLIENT_SECRET_BYTES) {
      throw new Error(errorCode);
    }
    return value;
  } catch (error) {
    throw error instanceof Error && error.message === errorCode ? error : new Error(errorCode);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Reads deployment-owned auth material through a no-follow descriptor and
 * proves that neither the file nor its private parent changed around open.
 */
export async function readProtectedOwnedHostedAuthFile(
  path: string,
  platform: HostedAuthHostPlatform,
  maximumBytes: number,
  errorCode: string
): Promise<string> {
  if (
    !platform.isAbsolute(path) ||
    platform.join(path) !== path ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0
  ) {
    throw new Error(errorCode);
  }
  const parentPath = platform.dirname(path);
  const parentBefore = await platform.lstat(parentPath);
  assertPrivateOwnedDirectory(parentBefore, platform, errorCode);
  const before = await platform.lstat(path);
  assertOwnedPath(before, platform, 'file', errorCode);
  if ((before.mode & 0o077) !== 0) throw new Error(errorCode);
  const handle = await platform.openReadOnlyNoFollow(path).catch(() => {
    throw new Error(errorCode);
  });
  try {
    const opened = await handle.stat();
    assertOwnedPath(opened, platform, 'file', errorCode);
    if ((opened.mode & 0o077) !== 0 || !sameFileIdentity(before, opened)) {
      throw new Error(errorCode);
    }
    const after = await platform.lstat(path);
    assertOwnedPath(after, platform, 'file', errorCode);
    if ((after.mode & 0o077) !== 0 || !sameFileIdentity(opened, after)) {
      throw new Error(errorCode);
    }
    const parentAfter = await platform.lstat(parentPath);
    assertPrivateOwnedDirectory(parentAfter, platform, errorCode);
    if (!sameFileIdentity(parentBefore, parentAfter)) throw new Error(errorCode);
    return await handle.readTextBounded(maximumBytes);
  } catch (error) {
    throw error instanceof Error && error.message === errorCode ? error : new Error(errorCode);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function identifierSuffix(platform: HostedAuthHostPlatform): string {
  // A base64url value may begin with "-" or "_", while hosted identifiers
  // deliberately require an alphanumeric first character after the prefix.
  return `x${platform.base64UrlEncode(platform.randomBytes(18))}`;
}

function decodeKey(value: string, platform: HostedAuthHostPlatform): Uint8Array {
  const decoded = platform.base64UrlDecode(value.trim());
  if (decoded.length !== KEY_BYTES) throw new Error('hosted_auth_key_invalid');
  return decoded;
}

function loginEncryptionKey(masterKey: Uint8Array, platform: HostedAuthHostPlatform): Uint8Array {
  return platform.hkdfSha256(
    masterKey,
    new TextEncoder().encode('agent-teams-hosted-auth-v1'),
    'oidc-login-encryption',
    KEY_BYTES
  );
}

async function readKey(path: string, platform: HostedAuthHostPlatform): Promise<Uint8Array> {
  return decodeKey(
    await readProtectedOwnedHostedAuthFile(
      path,
      platform,
      MAXIMUM_IDENTITY_KEY_BYTES,
      'hosted_auth_key_permissions_invalid'
    ),
    platform
  );
}

async function loadOrCreateKey(
  path: string,
  platform: HostedAuthHostPlatform
): Promise<Uint8Array> {
  try {
    return await readKey(path, platform);
  } catch (error) {
    if ((error as { readonly code?: string }).code !== 'ENOENT') throw error;
    const key = platform.randomBytes(KEY_BYTES);
    try {
      await platform.writeTextDurable(path, platform.base64UrlEncode(key), {
        exclusive: true,
        mode: 0o600,
      });
      return await readKey(path, platform);
    } catch (writeError) {
      if ((writeError as { readonly code?: string }).code !== 'EEXIST') throw writeError;
      return readKey(path, platform);
    }
  }
}

export class NodeHostedIdentityCrypto implements HostedIdentityCryptoPort {
  private keyPromise: Promise<Uint8Array> | null = null;

  constructor(
    private readonly keyPath: string,
    private readonly platform: HostedAuthHostPlatform
  ) {}

  async initialize(): Promise<void> {
    await this.key();
  }

  async randomId(
    kind: 'user' | 'session' | 'oidc-attempt' | 'audit-event' | 'workspace'
  ): Promise<string> {
    const suffix = identifierSuffix(this.platform);
    switch (kind) {
      case 'user':
        return parseUserId(`usr_${suffix}`);
      case 'session':
        return parseHostedSessionId(`hss_${suffix}`);
      case 'oidc-attempt':
        return parseOidcLoginAttemptId(`ola_${suffix}`);
      case 'audit-event':
        return parseAuditEventId(`aud_${suffix}`);
      case 'workspace':
        return parseHostedWorkspaceId(
          `workspace_${Array.from(this.platform.randomBytes(16), (byte) =>
            byte.toString(16).padStart(2, '0')
          ).join('')}`
        );
    }
  }

  async randomSecret(_kind: 'session' | 'csrf'): Promise<string> {
    return this.platform.base64UrlEncode(this.platform.randomBytes(32));
  }

  async hashSecret(
    purpose: 'session' | 'oidc-state' | 'source-ip',
    secret: string
  ): Promise<string> {
    const key = await this.key();
    return `hmac-sha256:${this.platform.hmacSha256(
      key,
      [`hosted-auth:${purpose}\0`, secret],
      'hex'
    )}`;
  }

  async deriveCsrf(sessionId: HostedSessionId, sessionSecret: string): Promise<string> {
    const key = await this.key();
    return this.platform.hmacSha256(
      key,
      ['hosted-auth:csrf\0', sessionId, '\0', sessionSecret],
      'base64url'
    );
  }

  async encryptLoginSecret(secret: string): Promise<string> {
    const key = loginEncryptionKey(await this.key(), this.platform);
    const nonce = this.platform.randomBytes(12);
    const encrypted = this.platform.encryptAes256Gcm({
      key,
      nonce,
      aad: 'hosted-auth:oidc-login-secret:v1',
      plaintext: secret,
    });
    return `v1.${this.platform.base64UrlEncode(nonce)}.${this.platform.base64UrlEncode(
      encrypted.ciphertext
    )}.${this.platform.base64UrlEncode(encrypted.tag)}`;
  }

  async decryptLoginSecret(value: string): Promise<string> {
    const parts = value.split('.');
    if (parts.length !== 4) throw new Error('oidc_login_secret_corrupt');
    const [version, encodedNonce, encodedCiphertext, encodedTag] = parts;
    if (version !== 'v1' || !encodedNonce || !encodedCiphertext || !encodedTag) {
      throw new Error('oidc_login_secret_corrupt');
    }
    return this.platform.decryptAes256Gcm({
      key: loginEncryptionKey(await this.key(), this.platform),
      nonce: this.platform.base64UrlDecode(encodedNonce),
      aad: 'hosted-auth:oidc-login-secret:v1',
      ciphertext: this.platform.base64UrlDecode(encodedCiphertext),
      tag: this.platform.base64UrlDecode(encodedTag),
    });
  }

  async secureEqual(left: string, right: string): Promise<boolean> {
    return this.platform.secureEqual(left, right);
  }

  private key(): Promise<Uint8Array> {
    this.keyPromise ??= loadOrCreateKey(this.keyPath, this.platform);
    return this.keyPromise;
  }
}
