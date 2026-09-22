import {
  type AuthorityBinding,
  type PairingChallengeId,
  parseAuthKeyringId,
  parseAuthorityDeploymentId,
  parseAuthorityKeyMaterial,
  parseCsrfToken,
  parseDeviceFamilyId,
  parseDeviceGrantId,
  parseKeyedSecretHash,
  parseOpaqueAuthoritySecret,
  parseOperatorId,
  parseOperatorSessionId,
  parsePairingChallengeId,
} from '../../contracts';

import { readProtectedOwnedHostedAuthFile } from './NodeHostedIdentityCrypto';

import type {
  AuthKeyringEnvelope,
  AuthKeyringPort,
  AuthKeyringReadResult,
  AuthKeyringWriteResult,
  AuthorityRandomIdKind,
  AuthorityRandomSecretKind,
  HostedAccessCryptoPort,
  HostedAccessRandomPort,
  HostedAuthHostPlatform,
  PairingChallengeDeliveryPort,
  PairingChallengeDeliveryStatus,
  PairingChallengeDeliveryWriteResult,
  PairingDrainProofPort,
  PairingDrainPurpose,
  PairingDrainResult,
} from '../../core/application';

const MAXIMUM_KEYRING_BYTES = 16 * 1024;
const MAXIMUM_PAIRING_DELIVERY_BYTES = 4 * 1024;
const MAXIMUM_DRAIN_EVIDENCE_BYTES = 4 * 1024;

function secret(platform: HostedAuthHostPlatform): ReturnType<typeof parseOpaqueAuthoritySecret> {
  return parseOpaqueAuthoritySecret(platform.base64UrlEncode(platform.randomBytes(32)));
}

function identifierSuffix(platform: HostedAuthHostPlatform): string {
  // Keep the parser's alphanumeric first-suffix invariant independently of
  // the first random base64url character ("-" and "_" are both possible).
  return `x${platform.base64UrlEncode(platform.randomBytes(18))}`;
}

const ID_PREFIX: Record<AuthorityRandomIdKind, string> = {
  'auth-keyring': 'akr',
  'device-family': 'dfm',
  'device-grant': 'dgr',
  operator: 'opr',
  'pairing-challenge': 'pch',
  session: 'ops',
};

export class NodePersonalAuthorityCrypto implements HostedAccessRandomPort, HostedAccessCryptoPort {
  constructor(private readonly platform: HostedAuthHostPlatform) {}

  async randomId(kind: AuthorityRandomIdKind): Promise<string> {
    const value = `${ID_PREFIX[kind]}_${identifierSuffix(this.platform)}`;
    switch (kind) {
      case 'auth-keyring':
        return parseAuthKeyringId(value);
      case 'device-family':
        return parseDeviceFamilyId(value);
      case 'device-grant':
        return parseDeviceGrantId(value);
      case 'operator':
        return parseOperatorId(value);
      case 'pairing-challenge':
        return parsePairingChallengeId(value);
      case 'session':
        return parseOperatorSessionId(value);
    }
  }

  async randomSecret(
    _kind: AuthorityRandomSecretKind,
    _byteLength: 32
  ): Promise<ReturnType<typeof parseOpaqueAuthoritySecret>> {
    return secret(this.platform);
  }

  async keyedHash(input: {
    readonly key: ReturnType<typeof parseAuthorityKeyMaterial>;
    readonly purpose: 'device-grant' | 'operator-session' | 'pairing-challenge';
    readonly secret: ReturnType<typeof parseOpaqueAuthoritySecret>;
  }) {
    return parseKeyedSecretHash(
      `hmac-sha256:${this.platform.hmacSha256(
        this.platform.base64UrlDecode(input.key),
        [`hosted-personal:${input.purpose}\0`, input.secret],
        'hex'
      )}`
    );
  }

  async deriveSecret(input: {
    readonly key: ReturnType<typeof parseAuthorityKeyMaterial>;
    readonly purpose:
      | 'pairing-device-grant'
      | 'pairing-session'
      | 'renewed-device-grant'
      | 'renewed-session';
    readonly sourceSecret: ReturnType<typeof parseOpaqueAuthoritySecret>;
    readonly context: string;
  }) {
    const derived = this.platform.hkdfSha256(
      new TextEncoder().encode(input.sourceSecret),
      this.platform.base64UrlDecode(input.key),
      `hosted-personal:${input.purpose}\0${input.context}`,
      32
    );
    return parseOpaqueAuthoritySecret(this.platform.base64UrlEncode(derived));
  }

  async deriveCsrf(input: {
    readonly key: ReturnType<typeof parseAuthorityKeyMaterial>;
    readonly sessionId: string;
    readonly sessionSecret: ReturnType<typeof parseOpaqueAuthoritySecret>;
  }) {
    return parseCsrfToken(
      this.platform.hmacSha256(
        this.platform.base64UrlDecode(input.key),
        ['hosted-personal:csrf\0', input.sessionId, '\0', input.sessionSecret],
        'base64url'
      )
    );
  }

  async secureEqual(left: string, right: string): Promise<boolean> {
    return this.platform.secureEqual(left, right);
  }
}

function assertPrivateSecretDirectory(
  stat: Awaited<ReturnType<HostedAuthHostPlatform['lstat']>>,
  platform: HostedAuthHostPlatform
): void {
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (platform.uid !== undefined && stat.uid !== platform.uid)
  ) {
    throw new Error('hosted_auth_secret_directory_invalid');
  }
}

async function writeSecretFile(
  path: string,
  body: string,
  exclusive: boolean,
  platform: HostedAuthHostPlatform
): Promise<void> {
  const directory = platform.dirname(path);
  await platform.mkdir(directory, 0o700);
  const directoryBefore = await platform.lstat(directory);
  assertPrivateSecretDirectory(directoryBefore, platform);
  await platform.chmod(directory, 0o700);
  const directoryAfter = await platform.lstat(directory);
  assertPrivateSecretDirectory(directoryAfter, platform);
  if (directoryBefore.dev !== directoryAfter.dev || directoryBefore.ino !== directoryAfter.ino) {
    throw new Error('hosted_auth_secret_directory_invalid');
  }
  await platform.writeTextDurable(path, body, { exclusive, mode: 0o600 });
  await platform.chmod(path, 0o600);
}

function parseKeyring(value: unknown): AuthKeyringEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('hosted_auth_keyring_corrupt');
  }
  const row = value as Record<string, unknown>;
  if (
    row.format !== 'hosted-access-keyring/v1' ||
    typeof row.createdAt !== 'number' ||
    !Number.isSafeInteger(row.createdAt) ||
    typeof row.binding !== 'object' ||
    row.binding === null
  ) {
    throw new Error('hosted_auth_keyring_corrupt');
  }
  const binding = row.binding as Record<string, unknown>;
  if (!Number.isSafeInteger(binding.restoreGeneration)) {
    throw new Error('hosted_auth_keyring_corrupt');
  }
  return Object.freeze({
    format: 'hosted-access-keyring/v1',
    keyringId: parseAuthKeyringId(row.keyringId),
    binding: Object.freeze({
      deploymentId: parseAuthorityDeploymentId(binding.deploymentId),
      restoreGeneration: Number(binding.restoreGeneration),
    }),
    createdAt: row.createdAt,
    hashKey: parseAuthorityKeyMaterial(row.hashKey),
    csrfKey: parseAuthorityKeyMaterial(row.csrfKey),
  });
}

function keyringsEqual(left: AuthKeyringEnvelope, right: AuthKeyringEnvelope): boolean {
  return (
    left.format === right.format &&
    left.keyringId === right.keyringId &&
    left.binding.deploymentId === right.binding.deploymentId &&
    left.binding.restoreGeneration === right.binding.restoreGeneration &&
    left.createdAt === right.createdAt &&
    left.hashKey === right.hashKey &&
    left.csrfKey === right.csrfKey
  );
}

export class FileAuthKeyring implements AuthKeyringPort {
  constructor(
    private readonly activePath: string,
    private readonly stageDirectory: string,
    private readonly platform: HostedAuthHostPlatform
  ) {}

  async loadActive(): Promise<AuthKeyringReadResult> {
    return this.read(this.activePath);
  }

  async createInitial(envelope: AuthKeyringEnvelope): Promise<AuthKeyringWriteResult> {
    try {
      await writeSecretFile(this.activePath, JSON.stringify(envelope), true, this.platform);
      return { status: 'created' };
    } catch (error) {
      if ((error as { readonly code?: string }).code !== 'EEXIST') {
        return { status: 'unavailable' };
      }
      const existing = await this.loadActive();
      return existing.status === 'available' && keyringsEqual(existing.envelope, envelope)
        ? { status: 'already_applied' }
        : { status: 'conflict' };
    }
  }

  loadStaged(keyringId: AuthKeyringEnvelope['keyringId']): Promise<AuthKeyringReadResult> {
    return this.read(this.stagePath(keyringId));
  }

  async stageReplacement(envelope: AuthKeyringEnvelope): Promise<AuthKeyringWriteResult> {
    const path = this.stagePath(envelope.keyringId);
    try {
      await writeSecretFile(path, JSON.stringify(envelope), true, this.platform);
      return { status: 'staged' };
    } catch (error) {
      if ((error as { readonly code?: string }).code !== 'EEXIST') {
        return { status: 'unavailable' };
      }
      const existing = await this.read(path);
      return existing.status === 'available' && keyringsEqual(existing.envelope, envelope)
        ? { status: 'already_applied' }
        : { status: 'conflict' };
    }
  }

  async activateStaged(
    keyringId: AuthKeyringEnvelope['keyringId']
  ): Promise<AuthKeyringWriteResult> {
    const stagedPath = this.stagePath(keyringId);
    try {
      const staged = await this.read(stagedPath);
      if (staged.status === 'missing') {
        const active = await this.loadActive();
        return active.status === 'available' && active.envelope.keyringId === keyringId
          ? { status: 'already_applied' }
          : { status: 'unavailable' };
      }
      if (staged.status !== 'available') return { status: 'unavailable' };
      const temporary = `${this.activePath}.activate-${this.platform.pid}`;
      try {
        await writeSecretFile(temporary, JSON.stringify(staged.envelope), true, this.platform);
      } catch (error) {
        if ((error as { readonly code?: string }).code !== 'EEXIST') {
          return { status: 'unavailable' };
        }
        const recoverable = await this.read(temporary);
        if (
          recoverable.status !== 'available' ||
          !keyringsEqual(recoverable.envelope, staged.envelope)
        ) {
          return { status: 'conflict' };
        }
      }
      await this.platform.rename(temporary, this.activePath);
      await this.platform.remove(stagedPath, { force: true });
      return { status: 'activated' };
    } catch {
      return { status: 'unavailable' };
    }
  }

  private async read(path: string): Promise<AuthKeyringReadResult> {
    try {
      return {
        status: 'available',
        envelope: parseKeyring(
          JSON.parse(
            await readProtectedOwnedHostedAuthFile(
              path,
              this.platform,
              MAXIMUM_KEYRING_BYTES,
              'hosted_auth_keyring_permissions_invalid'
            )
          )
        ),
      };
    } catch (error) {
      if ((error as { readonly code?: string }).code === 'ENOENT') {
        return { status: 'missing' };
      }
      if (
        error instanceof SyntaxError ||
        (error instanceof Error && error.message.includes('corrupt'))
      ) {
        return { status: 'corrupt' };
      }
      return { status: 'unavailable' };
    }
  }

  private stagePath(keyringId: AuthKeyringEnvelope['keyringId']): string {
    return `${this.stageDirectory}/${keyringId}.json`;
  }
}

interface PairingDeliveryDocument {
  readonly challengeId: string;
  readonly pairingCode: string;
  readonly expiresAt: number;
}

function parsePairingDelivery(value: unknown): PairingDeliveryDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('pairing_delivery_corrupt');
  }
  const row = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(row).length !== 3 ||
    Reflect.ownKeys(row).some(
      (key) => typeof key !== 'string' || !['challengeId', 'pairingCode', 'expiresAt'].includes(key)
    )
  ) {
    throw new Error('pairing_delivery_corrupt');
  }
  if (!Number.isSafeInteger(row.expiresAt) || Number(row.expiresAt) < 0) {
    throw new Error('pairing_delivery_corrupt');
  }
  return Object.freeze({
    challengeId: parsePairingChallengeId(row.challengeId),
    pairingCode: parseOpaqueAuthoritySecret(row.pairingCode),
    expiresAt: Number(row.expiresAt),
  });
}

export class FilePairingChallengeDelivery implements PairingChallengeDeliveryPort {
  constructor(
    private readonly path: string,
    private readonly platform: HostedAuthHostPlatform
  ) {}

  async status(challengeId: PairingChallengeId): Promise<PairingChallengeDeliveryStatus> {
    try {
      const document = await this.read();
      return { status: document.challengeId === challengeId ? 'present' : 'missing' };
    } catch (error) {
      if ((error as { readonly code?: string }).code === 'ENOENT') return { status: 'missing' };
      return { status: 'unavailable' };
    }
  }

  async publish(input: {
    readonly challengeId: PairingChallengeId;
    readonly secret: ReturnType<typeof parseOpaqueAuthoritySecret>;
    readonly expiresAt: number;
  }): Promise<PairingChallengeDeliveryWriteResult> {
    try {
      await writeSecretFile(
        this.path,
        JSON.stringify({
          challengeId: input.challengeId,
          pairingCode: input.secret,
          expiresAt: input.expiresAt,
        }),
        true,
        this.platform
      );
      return { status: 'published' };
    } catch (error) {
      if ((error as { readonly code?: string }).code !== 'EEXIST') {
        return { status: 'unavailable' };
      }
      try {
        const existing = await this.read();
        return existing.challengeId === input.challengeId &&
          existing.pairingCode === input.secret &&
          existing.expiresAt === input.expiresAt
          ? { status: 'already_published' }
          : { status: 'conflict' };
      } catch {
        return { status: 'unavailable' };
      }
    }
  }

  async remove(challengeId: PairingChallengeId): Promise<PairingChallengeDeliveryWriteResult> {
    try {
      const existing = await this.read();
      if (existing.challengeId !== challengeId) return { status: 'conflict' };
      await this.platform.remove(this.path);
      return { status: 'removed' };
    } catch (error) {
      return (error as { readonly code?: string }).code === 'ENOENT'
        ? { status: 'already_missing' }
        : { status: 'unavailable' };
    }
  }

  private async read(): Promise<PairingDeliveryDocument> {
    return parsePairingDelivery(
      JSON.parse(
        await readProtectedOwnedHostedAuthFile(
          this.path,
          this.platform,
          MAXIMUM_PAIRING_DELIVERY_BYTES,
          'pairing_delivery_unavailable'
        )
      )
    );
  }
}

interface RuntimeDrainEvidenceDocument {
  readonly format: 'agent-teams-runtime-drain/v1';
  readonly deploymentId: string;
  readonly restoreGeneration: number;
  readonly purpose: PairingDrainPurpose;
  readonly targetAuthMode?: 'personal' | 'oidc';
  readonly resetGeneration: number;
  readonly outcome: 'drained';
  readonly evidenceRef: string;
  readonly observedAt: number;
  readonly expiresAt: number;
}

function parseRuntimeDrainEvidence(value: unknown): RuntimeDrainEvidenceDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('hosted_auth_drain_evidence_invalid');
  }
  const row = value as Record<string, unknown>;
  const baseKeys = [
    'format',
    'deploymentId',
    'restoreGeneration',
    'purpose',
    'resetGeneration',
    'outcome',
    'evidenceRef',
    'observedAt',
    'expiresAt',
  ];
  if (
    row.format !== 'agent-teams-runtime-drain/v1' ||
    row.outcome !== 'drained' ||
    (row.purpose !== 'initial_pairing' &&
      row.purpose !== 'host_reset' &&
      row.purpose !== 'auth_mode_reset')
  ) {
    throw new Error('hosted_auth_drain_evidence_invalid');
  }
  const expectedKeys =
    row.purpose === 'auth_mode_reset' ? [...baseKeys, 'targetAuthMode'] : baseKeys;
  if (
    Reflect.ownKeys(row).length !== expectedKeys.length ||
    Reflect.ownKeys(row).some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    throw new Error('hosted_auth_drain_evidence_invalid');
  }
  if (
    (row.purpose === 'auth_mode_reset' &&
      row.targetAuthMode !== 'personal' &&
      row.targetAuthMode !== 'oidc') ||
    (row.purpose !== 'auth_mode_reset' && row.targetAuthMode !== undefined) ||
    typeof row.evidenceRef !== 'string' ||
    !/^[A-Za-z0-9:._/-]{1,256}$/.test(row.evidenceRef) ||
    !Number.isSafeInteger(row.restoreGeneration) ||
    !Number.isSafeInteger(row.resetGeneration) ||
    !Number.isSafeInteger(row.observedAt) ||
    !Number.isSafeInteger(row.expiresAt)
  ) {
    throw new Error('hosted_auth_drain_evidence_invalid');
  }
  parseAuthorityDeploymentId(row.deploymentId);
  return row as unknown as RuntimeDrainEvidenceDocument;
}

/**
 * Reads the AR-owned, operator-only drain proof for destructive personal reset.
 * Initial pairing can use startup evidence only when this composition has no
 * runtime mutation capability at all.
 */
export class FileHostedPairingDrainProof implements PairingDrainProofPort {
  constructor(
    private readonly path: string,
    private readonly options: {
      readonly noRuntimeMutationAtStartup: boolean;
      readonly now?: () => number;
    },
    private readonly platform: HostedAuthHostPlatform
  ) {}

  async confirmDrained(input: {
    readonly binding: AuthorityBinding;
    readonly purpose: PairingDrainPurpose;
    readonly resetGeneration: number;
    readonly targetAuthMode?: 'personal' | 'oidc';
  }): Promise<PairingDrainResult> {
    if (input.purpose === 'initial_pairing' && this.options.noRuntimeMutationAtStartup) {
      return {
        status: 'drained',
        evidenceRef: `hosted-auth:initial-pairing:${input.resetGeneration}:no-runtime-admission`,
      };
    }
    try {
      const document = parseRuntimeDrainEvidence(
        JSON.parse(
          await readProtectedOwnedHostedAuthFile(
            this.path,
            this.platform,
            MAXIMUM_DRAIN_EVIDENCE_BYTES,
            'hosted_auth_drain_evidence_invalid'
          )
        )
      );
      const now = (this.options.now ?? Date.now)();
      if (
        document.deploymentId !== input.binding.deploymentId ||
        document.restoreGeneration !== input.binding.restoreGeneration ||
        document.purpose !== input.purpose ||
        document.targetAuthMode !== input.targetAuthMode ||
        document.resetGeneration !== input.resetGeneration ||
        document.observedAt > now + 30_000 ||
        document.expiresAt <= now ||
        document.expiresAt > document.observedAt + 15 * 60_000
      ) {
        return { status: 'unclassified' };
      }
      return { status: 'drained', evidenceRef: document.evidenceRef };
    } catch (error) {
      return (error as { readonly code?: string }).code === 'ENOENT'
        ? { status: 'unavailable' }
        : { status: 'unclassified' };
    }
  }
}

export function createInitialKeyringMaterial(platform: HostedAuthHostPlatform) {
  return parseAuthorityKeyMaterial(platform.base64UrlEncode(platform.randomBytes(32)));
}
