import { constants, type Stats } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';

import { isLegacySavedTeamProductRecords } from '../../LegacySavedTeamNativeIdentity';

import type { LegacyMaintenanceCensus } from './OpenCodeLegacyMaintenanceCensus';

const MAX_RECORD_BYTES = 256 * 1024;
const RECORD_NAMES = new Set(['team.meta.json', 'members.meta.json', 'config.json']);

function unchanged(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

/** Only the exact finite saved-product files prove absence. Any other artifact retains maintenance. */
export async function inspectSavedTeamMaintenance(
  path: string,
  teamName: string
): Promise<LegacyMaintenanceCensus> {
  try {
    const before = await lstat(path);
    if (!before.isDirectory() || before.isSymbolicLink()) return 'unknown';
    const names = new Set<string>();
    const entries = await opendir(path);
    try {
      for (let entry = await entries.read(); entry !== null; entry = await entries.read()) {
        if (!RECORD_NAMES.has(entry.name)) return 'present';
        if (!entry.isFile() || entry.isSymbolicLink()) return 'unknown';
        names.add(entry.name);
      }
    } finally {
      await entries.close();
    }
    if (!names.has('team.meta.json') || !names.has('members.meta.json')) return 'present';
    const records = new Map<string, unknown>();
    const snapshots = new Map<string, Stats>();
    for (const name of names) {
      const filePath = join(path, name);
      const file = await open(
        filePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > MAX_RECORD_BYTES) return 'unknown';
        const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
          const result = await file.read(bytes, length, bytes.length - length, length);
          if (result.bytesRead === 0) break;
          length += result.bytesRead;
        }
        if (
          length > MAX_RECORD_BYTES ||
          length !== info.size ||
          !unchanged(info, await file.stat()) ||
          !unchanged(info, await lstat(filePath))
        )
          return 'unknown';
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
        const value: unknown = JSON.parse(raw);
        // Desktop stores write this exact encoding. Reject duplicate keys and
        // opaque alternate encodings rather than normalizing away their evidence.
        if (raw !== JSON.stringify(value, null, 2)) return 'unknown';
        records.set(name, value);
        snapshots.set(name, info);
      } finally {
        await file.close();
      }
    }
    if (names.has('config.json') && records.get('config.json') === null) return 'present';
    if (
      !isLegacySavedTeamProductRecords(teamName, {
        config: records.get('config.json') ?? null,
        meta: records.get('team.meta.json'),
        roster: records.get('members.meta.json'),
      })
    )
      return 'present';
    for (const [name, snapshot] of snapshots) {
      if (!unchanged(snapshot, await lstat(join(path, name)))) return 'unknown';
    }
    return unchanged(before, await lstat(path)) ? 'absent' : 'unknown';
  } catch {
    // Missing, corrupt, replaced and unreadable records never establish absence.
    return 'unknown';
  }
}
