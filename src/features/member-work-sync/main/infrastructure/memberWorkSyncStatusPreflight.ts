import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { listPreSqliteArchiveGenerations } from '@features/internal-storage/main';

import { decodeMemberWorkSyncStoredStatus } from './decodeMemberWorkSyncStoredStatus';
import { validateMemberWorkSyncAuthoritySnapshot } from './memberWorkSyncAuthorityPreparation';
import { MemberWorkSyncSafetyJsonReadError } from './memberWorkSyncSafetyJson';

import type { MemberWorkSyncStoreSnapshot } from './JsonMemberWorkSyncStore';
import type { MemberWorkSyncStorePaths } from './MemberWorkSyncStorePaths';
import type { MemberWorkSyncStatusRecord } from '@features/internal-storage/contracts/internalStorageContracts';

type Identity = { teamName: string; incarnation: string };
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
async function names(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new MemberWorkSyncSafetyJsonReadError('unavailable');
  }
}
async function readJson(path: string, allowAbsent: boolean): Promise<{ value: unknown } | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (allowAbsent && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new MemberWorkSyncSafetyJsonReadError('unavailable');
  }
  try {
    return { value: JSON.parse(raw) };
  } catch {
    throw new MemberWorkSyncSafetyJsonReadError('corrupt');
  }
}

/** Runs under the existing lifecycle/backend ownership BEFORE import/hydration can repair evidence. */
export async function preflightMemberWorkSyncStatusSources(input: {
  paths: MemberWorkSyncStorePaths;
  identity: Identity;
  primaryStatuses?: MemberWorkSyncStatusRecord[];
}): Promise<{ historicalMemberKeys: string[] }> {
  const { paths, identity } = input;
  const historical = new Set<string>();
  const validate = (memberName: string, value: unknown): void => {
    decodeMemberWorkSyncStoredStatus(value, { ...identity, memberName });
    historical.add(paths.getMemberKey(memberName));
  };
  // Do not normalize raw primary payload before validating its stored ownership.
  for (const row of input.primaryStatuses ?? []) {
    if (row.teamName.trim().toLowerCase() !== identity.teamName.trim().toLowerCase())
      throw new MemberWorkSyncSafetyJsonReadError('corrupt');
    let value: unknown;
    try {
      value = JSON.parse(row.statusJson);
    } catch {
      throw new MemberWorkSyncSafetyJsonReadError('corrupt');
    }
    validate(row.memberKey, value);
  }

  const inspect = async (path: string, memberName?: string): Promise<void> => {
    const files = await names(dirname(path));
    // An older tolerant reader may already have removed the canonical file.
    // Preserved corruption is not evidence for a fresh empty authority.
    if (files.some((name) => name.startsWith(`${basename(path)}.invalid.`))) {
      throw new MemberWorkSyncSafetyJsonReadError('corrupt');
    }
    const decodeEnvelope = (value: unknown): void => {
      if (!record(value)) throw new MemberWorkSyncSafetyJsonReadError('corrupt');
      if (memberName !== undefined) {
        if (value.schemaVersion !== 2) throw new MemberWorkSyncSafetyJsonReadError('corrupt');
        validate(memberName, value.status);
      } else {
        if (value.schemaVersion !== 1 || !record(value.members))
          throw new MemberWorkSyncSafetyJsonReadError('corrupt');
        for (const [memberKey, status] of Object.entries(value.members))
          validate(memberKey, status);
      }
    };
    const canonical = await readJson(path, true);
    if (canonical) decodeEnvelope(canonical.value);
    for (const archive of await listPreSqliteArchiveGenerations(path)) {
      const snapshot = await readJson(archive.filePath, false);
      if (snapshot) decodeEnvelope(snapshot.value);
    }
  };

  const inspectDelivery = async (
    path: string,
    collection: 'intents' | 'items',
    memberName?: string
  ): Promise<void> => {
    const check = (value: unknown): void => {
      if (
        !record(value) ||
        value.schemaVersion !== (memberName === undefined ? 1 : 2) ||
        !record(value[collection])
      )
        throw new MemberWorkSyncSafetyJsonReadError('corrupt');
      const rows = Object.entries(value[collection]);
      for (const [id, row] of rows) {
        if (
          !record(row) ||
          row.id !== id ||
          typeof row.memberName !== 'string' ||
          (memberName !== undefined &&
            paths.getMemberKey(row.memberName) !== paths.getMemberKey(memberName))
        )
          throw new MemberWorkSyncSafetyJsonReadError('corrupt');
      }
      validateMemberWorkSyncAuthoritySnapshot(identity, {
        statuses: [],
        reportIntents: collection === 'intents' ? rows.map(([, row]) => row) : [],
        outboxItems: collection === 'items' ? rows.map(([, row]) => row) : [],
        metricEvents: [],
        filesToArchive: [],
      } as MemberWorkSyncStoreSnapshot);
    };
    const raw = await readJson(path, true);
    if (raw) check(raw.value);
    for (const archive of await listPreSqliteArchiveGenerations(path)) {
      const rawArchive = await readJson(archive.filePath, false);
      if (rawArchive) check(rawArchive.value);
    }
  };
  await inspectDelivery(paths.getLegacyPendingReportsPath(identity.teamName), 'intents');
  await inspectDelivery(paths.getLegacyOutboxPath(identity.teamName), 'items');
  await inspect(paths.getLegacyStatusPath(identity.teamName));
  const membersRoot = join(paths.getTeamRootDir(identity.teamName), 'members');
  for (const directory of await names(membersRoot)) {
    let memberName: string;
    try {
      memberName = decodeURIComponent(directory);
    } catch {
      continue;
    }
    if (!memberName.trim() || paths.getMemberKey(memberName) !== directory) continue;
    await inspect(paths.getMemberStatusPath(identity.teamName, memberName), memberName);
    await inspectDelivery(
      paths.getMemberReportsPath(identity.teamName, memberName),
      'intents',
      memberName
    );
    await inspectDelivery(
      paths.getMemberOutboxPath(identity.teamName, memberName),
      'items',
      memberName
    );
  }
  return { historicalMemberKeys: [...historical].sort() };
}
