export interface TokenSecretIdentity {
  teamName: string;
  incarnation: string;
}

export type MemberWorkSyncTokenSecret =
  | { schemaVersion: 1; secret: string }
  | { schemaVersion: 2; secret: string; teamName: string; incarnation: string };

export function normalizeTokenSecretTeam(teamName: string): string {
  return teamName.trim().toLowerCase();
}

/** Schema validation is shared by the live writer and read-only backup preflight. */
export function parseMemberWorkSyncTokenSecret(raw: string): MemberWorkSyncTokenSecret {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid report token secret');
  const record = value as Record<string, unknown>;
  if (typeof record.secret !== 'string' || record.secret.length < 32)
    throw new Error('Invalid report token secret');
  if (record.schemaVersion === 1) return { schemaVersion: 1, secret: record.secret };
  if (
    record.schemaVersion !== 2 ||
    typeof record.teamName !== 'string' ||
    !record.teamName ||
    normalizeTokenSecretTeam(record.teamName) !== record.teamName ||
    /[\\/\0]/.test(record.teamName) ||
    record.teamName === '.' ||
    record.teamName === '..' ||
    typeof record.incarnation !== 'string' ||
    !record.incarnation ||
    record.incarnation.trim() !== record.incarnation
  )
    throw new Error('Invalid report token secret');
  return {
    schemaVersion: 2,
    secret: record.secret,
    teamName: record.teamName,
    incarnation: record.incarnation,
  };
}

export function tokenSecretMatchesIdentity(
  secret: MemberWorkSyncTokenSecret,
  identity: TokenSecretIdentity
): boolean {
  return (
    secret.schemaVersion === 2 &&
    secret.teamName === normalizeTokenSecretTeam(identity.teamName) &&
    secret.incarnation === identity.incarnation
  );
}

export function validateBackupTokenSecret(raw: string, identity: TokenSecretIdentity): void {
  const secret = parseMemberWorkSyncTokenSecret(raw);
  if (secret.schemaVersion === 2 && !tokenSecretMatchesIdentity(secret, identity))
    throw new Error('Backup report token secret identity mismatch');
}
