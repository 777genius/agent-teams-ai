import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { validateMemberWorkSyncReportJournalRow } from '../../core/domain/MemberWorkSyncReportJournalRow';

import { normalizeMemberKey } from './memberWorkSyncStoreIdentity';

import type { MemberWorkSyncReportIntent } from '../../contracts';
import type {
  MemberWorkSyncReportJournalIdentity,
  MemberWorkSyncReportJournalResult,
} from '../../core/application/MemberWorkSyncReportJournalPort';
import type { MemberWorkSyncStorePaths } from './MemberWorkSyncStorePaths';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.trim() === value;

type Reports = { schemaVersion: 2; intents: Record<string, MemberWorkSyncReportIntent> };

export type MemberWorkSyncReportJournalSnapshot =
  | { state: 'present'; file: Reports }
  | { state: 'absent' | 'corrupt' | 'unavailable' };

/** Strict canonical reports.json read. Missing is absent; I/O is unavailable; any invalid row is corrupt. */
export async function readMemberWorkSyncReportJournalFile(
  path: string,
  scope: { teamName: string; memberName?: string; incarnation?: string }
): Promise<MemberWorkSyncReportJournalSnapshot> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unavailable' };
  }
  try {
    const file: unknown = JSON.parse(raw);
    if (!record(file) || file.schemaVersion !== 2 || !record(file.intents))
      return { state: 'corrupt' };
    for (const [id, row] of Object.entries(file.intents)) {
      if (
        !record(row) ||
        row.id !== id ||
        !identifier(row.teamName) ||
        !identifier(row.memberName) ||
        !record(row.request)
      )
        return { state: 'corrupt' };
      validateMemberWorkSyncReportJournalRow(row, scope);
    }
    return { state: 'present', file: file as Reports };
  } catch {
    return { state: 'corrupt' };
  }
}

export function reportJournalBindingMatches(
  intent: MemberWorkSyncReportIntent,
  input: MemberWorkSyncReportJournalIdentity
): boolean {
  return (
    intent.id === input.intentId &&
    intent.teamName === input.teamName &&
    intent.memberName === input.memberName &&
    intent.journal?.incarnation === input.incarnation &&
    intent.journal.requestDigest === input.requestDigest
  );
}

export async function listTeamCanonicalReportJournalPaths(
  paths: MemberWorkSyncStorePaths,
  teamName: string
): Promise<{ state: 'ok'; files: string[] } | { state: 'unavailable' }> {
  const membersDir = join(paths.getTeamRootDir(teamName), 'members');
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(membersDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'ok', files: [] };
    return { state: 'unavailable' };
  }
  return {
    state: 'ok',
    files: entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(membersDir, entry.name, '.member-work-sync', 'reports.json')),
  };
}

/**
 * Index is only a projection. Ownership is the unique canonical reports.json row for this team ID.
 * Incomplete scans and malformed neighbors fail closed.
 */
export async function findCanonicalReportJournalOwner(
  paths: MemberWorkSyncStorePaths,
  input: MemberWorkSyncReportJournalIdentity
): Promise<
  | { state: 'absent' }
  | { state: 'present'; path: string; intent: MemberWorkSyncReportIntent }
  | Extract<MemberWorkSyncReportJournalResult, { state: 'conflict' | 'corrupt' | 'unavailable' }>
> {
  const listed = await listTeamCanonicalReportJournalPaths(paths, input.teamName);
  if (listed.state !== 'ok') return listed;
  const targetPath = paths.getMemberReportsPath(input.teamName, input.memberName);
  if (!listed.files.includes(targetPath)) listed.files.push(targetPath);
  const owners: { path: string; intent: MemberWorkSyncReportIntent }[] = [];
  for (const path of listed.files) {
    const snapshot = await readMemberWorkSyncReportJournalFile(path, { teamName: input.teamName });
    if (snapshot.state === 'unavailable' || snapshot.state === 'corrupt') return snapshot;
    const intent = snapshot.state === 'present' ? snapshot.file.intents[input.intentId] : undefined;
    if (intent) owners.push({ path, intent });
  }
  if (owners.length > 1) return { state: 'corrupt' };
  if (owners.length === 0) return { state: 'absent' };
  const owner = owners[0];
  const ownerKey = normalizeMemberKey(owner.intent.memberName);
  const requestedKey = normalizeMemberKey(input.memberName);
  if (
    owner.path !== targetPath ||
    ownerKey !== requestedKey ||
    paths.getMemberReportsPath(input.teamName, owner.intent.memberName) !== owner.path
  ) {
    return { state: 'conflict' };
  }
  return { state: 'present', ...owner };
}
