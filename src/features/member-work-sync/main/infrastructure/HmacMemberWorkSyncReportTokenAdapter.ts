import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';

import { atomicCreateAsync, atomicWriteAsync } from '@main/utils/atomicWrite';

import {
  normalizeTokenSecretTeam,
  parseMemberWorkSyncTokenSecret,
  tokenSecretMatchesIdentity,
  validateBackupTokenSecret,
} from './memberWorkSyncTokenSecret';

import type {
  MemberWorkSyncReportTokenCreateInput,
  MemberWorkSyncReportTokenPort,
  MemberWorkSyncReportTokenVerification,
  MemberWorkSyncReportTokenVerifyInput,
} from '../../core/application';
import type { MemberWorkSyncStorePaths } from './MemberWorkSyncStorePaths';
import type { TokenSecretIdentity } from './memberWorkSyncTokenSecret';
import type { TeamWorkSyncIdentityAccess } from '@main/services/team/permanent-deletion/TeamWorkSyncIdentityAccess';

const TOKEN_PREFIX = 'wrs:v1';
const TOKEN_TTL_MS = 15 * 60 * 1000;

interface TokenPayload {
  version: 1;
  teamName: string;
  memberName: string;
  agendaFingerprint: string;
  expiresAt: string;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function isTokenPayload(value: unknown): value is TokenPayload {
  return (
    value != null &&
    typeof value === 'object' &&
    (value as TokenPayload).version === 1 &&
    typeof (value as TokenPayload).teamName === 'string' &&
    typeof (value as TokenPayload).memberName === 'string' &&
    typeof (value as TokenPayload).agendaFingerprint === 'string' &&
    typeof (value as TokenPayload).expiresAt === 'string'
  );
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export class HmacMemberWorkSyncReportTokenAdapter implements MemberWorkSyncReportTokenPort {
  private readonly secretCache = new Map<string, Promise<string>>();

  constructor(
    private readonly paths: MemberWorkSyncStorePaths,
    private readonly identityAccess: Pick<
      TeamWorkSyncIdentityAccess,
      'readCurrent' | 'adoptLegacy' | 'withCurrent'
    >
  ) {}

  async create(input: MemberWorkSyncReportTokenCreateInput): Promise<{
    token: string;
    expiresAt: string;
  }> {
    const expiresAt = new Date(Date.parse(input.issuedAt) + TOKEN_TTL_MS).toISOString();
    const payload: TokenPayload = {
      version: 1,
      teamName: input.teamName,
      memberName: input.memberName,
      agendaFingerprint: input.agendaFingerprint,
      expiresAt,
    };
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const signature = await this.sign(input.teamName, encodedPayload);
    return {
      token: `${TOKEN_PREFIX}.${encodedPayload}.${signature}`,
      expiresAt,
    };
  }

  async verify(
    input: MemberWorkSyncReportTokenVerifyInput
  ): Promise<MemberWorkSyncReportTokenVerification> {
    if (!input.token) {
      return { ok: false, reason: 'missing' };
    }

    const [prefix, encodedPayload, signature, extra] = input.token.split('.');
    if (prefix !== TOKEN_PREFIX || !encodedPayload || !signature || extra) {
      return { ok: false, reason: 'invalid' };
    }

    const expectedSignature = await this.sign(input.teamName, encodedPayload);
    if (!safeEqual(signature, expectedSignature)) {
      return { ok: false, reason: 'invalid' };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(base64UrlDecode(encodedPayload));
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    if (!isTokenPayload(payload)) {
      return { ok: false, reason: 'invalid' };
    }
    if (
      payload.teamName !== input.teamName ||
      payload.memberName !== input.memberName ||
      payload.agendaFingerprint !== input.agendaFingerprint
    ) {
      return { ok: false, reason: 'invalid' };
    }
    const expiry = Date.parse(payload.expiresAt);
    const now = Date.parse(input.nowIso);
    if (!Number.isFinite(expiry) || !Number.isFinite(now)) return { ok: false, reason: 'invalid' };
    const claims = { expiresAt: payload.expiresAt, expiresAtMs: expiry };
    if (expiry <= now) return { ok: false, reason: 'expired', claims };
    return { ok: true, claims };
  }

  /** Privileged restore only: caller owns the lifecycle fence and drained token users. */
  async restoreBackupSecret(
    teamName: string,
    backupJson: string | null,
    identity: TokenSecretIdentity
  ): Promise<{ rotated: boolean }> {
    if (
      !identity.incarnation ||
      identity.incarnation.trim() !== identity.incarnation ||
      !identity.teamName ||
      identity.teamName.trim() !== identity.teamName ||
      normalizeTokenSecretTeam(teamName) !== normalizeTokenSecretTeam(identity.teamName)
    )
      throw new Error('Restore token secret identity mismatch');
    if (backupJson !== null) validateBackupTokenSecret(backupJson, identity);
    // Backup keys are validation evidence only. Never revive an older signing key.
    for (const key of this.secretCache.keys()) {
      if ((JSON.parse(key) as [string, string])[0] === normalizeTokenSecretTeam(teamName))
        this.secretCache.delete(key);
    }
    const target = this.paths.getReportTokenSecretPath(teamName);
    let before: string | undefined;
    try {
      before = await readFile(target, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await this.loadOrCreateSecret(teamName, identity);
    return { rotated: before !== (await readFile(target, 'utf8')) };
  }

  private async sign(teamName: string, encodedPayload: string): Promise<string> {
    let observed = await this.identityAccess.readCurrent(teamName);
    if (observed.status === 'unidentified' && observed.reason === 'missing_marker')
      observed = await this.identityAccess.adoptLegacy(teamName);
    if (observed.status !== 'identified') throw new Error('Report token identity unavailable');
    const identity = { teamName, incarnation: observed.identityId };
    const result = await this.identityAccess.withCurrent(
      teamName,
      identity.incarnation,
      async () => {
        const secret = await this.getSecret(teamName, identity);
        return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
      }
    );
    if (!result.current) throw new Error('Report token identity changed');
    return result.value;
  }

  private async getSecret(teamName: string, identity: TokenSecretIdentity): Promise<string> {
    const key = JSON.stringify([normalizeTokenSecretTeam(teamName), identity.incarnation]);
    const existing = this.secretCache.get(key);
    if (existing) return existing;
    const next = this.loadOrCreateSecret(teamName, identity).catch((error: unknown) => {
      this.secretCache.delete(key);
      throw error;
    });
    this.secretCache.set(key, next);
    return next;
  }

  private async loadOrCreateSecret(
    teamName: string,
    identity: TokenSecretIdentity
  ): Promise<string> {
    const target = this.paths.getReportTokenSecretPath(teamName);
    let current: ReturnType<typeof parseMemberWorkSyncTokenSecret> | null = null;
    try {
      current = parseMemberWorkSyncTokenSecret(await readFile(target, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (current?.schemaVersion === 2 && current.teamName !== normalizeTokenSecretTeam(teamName))
      throw new Error('Report token secret team mismatch');
    if (current && tokenSecretMatchesIdentity(current, identity)) return current.secret;
    const secretFile = {
      schemaVersion: 2,
      teamName: normalizeTokenSecretTeam(teamName),
      incarnation: identity.incarnation,
      secret: randomBytes(32).toString('base64url'),
    };
    await mkdir(this.paths.getTeamDir(teamName), { recursive: true });
    const raw = JSON.stringify(secretFile, null, 2);
    // The lifecycle guard remains held across durable rotation and publication.
    if (current)
      await atomicWriteAsync(target, raw, {
        mode: 0o600,
        durability: 'strict',
        syncDirectory: true,
      });
    else {
      try {
        await atomicCreateAsync(target, raw, { mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const winner = parseMemberWorkSyncTokenSecret(await readFile(target, 'utf8'));
    if (!tokenSecretMatchesIdentity(winner, identity))
      throw new Error('Report token secret identity mismatch');
    return winner.secret;
  }
}
