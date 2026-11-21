import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

const TEAM = 'test-retained-original';
const WORK_SYNC = '.member-work-sync';
const ROOT_FILES = ['config.json', 'members.meta.json', 'team.meta.json', 'launch-state.json',
  'launch-summary.json', 'launch-stopped.json', 'launch-freshness.json'];
export const RETAINED_ORIGINAL_FAILURE_LIMITS = Object.freeze({
  fileBytes: 1024 * 1024, totalReadBytes: 4 * 1024 * 1024, payloadBytes: 1024 * 1024,
  entries: 256, directories: 32, files: 32, depth: 8, projectionNodes: 8192,
});
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Row = Record<string, Json>;
type Status = 'observed' | 'absent' | 'unreadable' | 'unsafe' | 'oversize' | 'budget' | 'changed';
interface Observation {
  path: string;
  originalPath: string;
  status: Status;
  reason?: string;
  identity?: Row;
  sha256?: string;
  bytesRead?: number;
  payload?: Json;
  payloadStatus?: 'captured' | 'invalid-json' | 'invalid-utf8' | 'projection-limit' | 'budget';
  entries?: Row[];
  truncated?: boolean;
}
export interface RetainedOriginalFailureDiagnostics {
  schemaVersion: 1;
  kind: 'TEST-retained-original-failure-files';
  status: 'captured' | 'partial' | 'unavailable';
  fixtureRoot: string;
  teamName: typeof TEAM;
  teamPath: string;
  limits: typeof RETAINED_ORIGINAL_FAILURE_LIMITS;
  directories: Observation[];
  files: Observation[];
  totalReadBytes: number;
  payloadBytes: number;
  reason?: string;
}
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const fileKind = (stat: BigIntStats): string => stat.isSymbolicLink() ? 'symlink' :
  stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special';
const identity = (stat: BigIntStats): Row => ({
  kind: fileKind(stat), dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
  nlink: String(stat.nlink), size: String(stat.size), mtimeNs: String(stat.mtimeNs),
  ctimeNs: String(stat.ctimeNs), birthtimeNs: String(stat.birthtimeNs),
});
const errorCode = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP',
    'EMFILE', 'ENFILE', 'EIO'].includes(code) ? code : 'unavailable';
};
const safeName = (name: string): boolean => name !== '.' && name !== '..' &&
  !/[\\/\0]/u.test(name) && Buffer.byteLength(name) <= 255;
const shape = (value: unknown, why: string): Row => ({
  redacted: why, type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
  ...(typeof value === 'string' ? { length: value.length, sha256: digest(value) } : {}),
  ...(Array.isArray(value) ? { length: value.length } : {}),
});
// Preserve only the values consulted by the closed WorkSync census. Unknown
// fields remain visible by name/type, without exporting arbitrary private data.
const WORK_SYNC_KEYS = new Set(('schemaVersion state updatedAt incarnation snapshot statuses ' +
  'reportIntents outboxItems metricEvents filesToArchive teamName memberName agenda statusRevision ' +
  'evaluatedAt diagnostics providerId reportTokenExpiresAt shadow lineageId sequence nonce ' +
  'generatedAt fingerprint items sourceRevision taskId subject kind assignee priority reason evidence ' +
  'displayId status owner reviewer reviewState reviewCycleId reviewRequestEventId reviewRequestedAt ' +
  'reviewStartedEventId reviewStartedAt reviewStartedBy reviewObligation canBypassPhase2 ' +
  'reviewDiagnostics needsClarification blockerTaskIds blockedByTaskIds historyEventIds reconciledBy ' +
  'wouldNudge fingerprintChanged previousFingerprint triggerReasons id agendaFingerprint recordedAt ' +
  'actionableCount timestamp event source taskRefs').split(' '));
function workSyncProjection(value: unknown): Json {
  let nodes = 0;
  const visit = (item: unknown, depth: number): Json => {
    if (++nodes > RETAINED_ORIGINAL_FAILURE_LIMITS.projectionNodes || depth > 48)
      throw new Error('projection-limit');
    if (typeof item === 'number' && !Number.isFinite(item))
      return { invalidNumber: String(item) };
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number')
      return item;
    if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, child]) => [
      key, /secret|token|password|credential|authorization/i.test(key) && key !== 'reportTokenExpiresAt'
        ? shape(child, 'secret') : WORK_SYNC_KEYS.has(key) ? visit(child, depth + 1)
          : shape(child, 'unrecognized-field'),
    ]));
  };
  return visit(value, 0);
}
function payload(bytes: Buffer, workSync: boolean, journal: boolean): {
  payloadStatus: Observation['payloadStatus']; payload?: Json;
} {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return { payloadStatus: 'invalid-utf8' }; }
  if (!workSync) return { payloadStatus: 'captured', payload: { encoding: 'utf8', text } };
  try {
    const parsed: unknown = journal
      ? (text ? text.replace(/\n$/u, '').split('\n').map(line => JSON.parse(line) as unknown) : [])
      : JSON.parse(text) as unknown;
    try {
      return { payloadStatus: 'captured', payload: journal
        ? { format: 'jsonl', finalNewline: text.endsWith('\n'), rows: workSyncProjection(parsed) }
        : { format: 'json', value: workSyncProjection(parsed) } };
    } catch { return { payloadStatus: 'projection-limit' }; }
  } catch { return { payloadStatus: 'invalid-json' }; }
}

/** Passive TEST evidence after the original failure, before harness cleanup.
 * No product validator, authority call, retry, process action or write occurs.
 * P09A trusted fixture writers apply; this is not an atomic release/currentness proof.
 */
export async function captureRetainedOriginalFailureDiagnostics(
  fixtureRoot: string
): Promise<RetainedOriginalFailureDiagnostics> {
  const root = typeof fixtureRoot === 'string' ? fixtureRoot : '';
  const team = join(root, 'claude', 'teams', TEAM);
  const result: RetainedOriginalFailureDiagnostics = { schemaVersion: 1,
    kind: 'TEST-retained-original-failure-files', status: 'captured', fixtureRoot: root,
    teamName: TEAM, teamPath: team, limits: RETAINED_ORIGINAL_FAILURE_LIMITS,
    directories: [], files: [], totalReadBytes: 0, payloadBytes: 0 };
  const observe = (path: string): Observation => ({ path, originalPath: join(team, path), status: 'observed' });
  const mark = (entry: Observation, status: Status, reason: string): void => {
    entry.status = status; entry.reason = reason;
    if (status !== 'absent') result.status = 'partial';
  };
  let entries = 0;
  const directories = new Set<string>();
  const readFile = async (path: string, workSync = false, journal = false): Promise<void> => {
    if (result.files.some(entry => entry.path === path)) return;
    if (result.files.length >= result.limits.files) { result.status = 'partial'; result.reason = 'file-limit'; return; }
    const entry = observe(path); result.files.push(entry);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const stat = await lstat(entry.originalPath, { bigint: true }); entry.identity = identity(stat);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) return mark(entry, 'unsafe', 'not-single-regular-file');
      if (stat.size > BigInt(result.limits.fileBytes)) return mark(entry, 'oversize', 'file-byte-limit');
      if (result.totalReadBytes + Number(stat.size) + 1 > result.limits.totalReadBytes)
        return mark(entry, 'budget', 'total-byte-limit');
      handle = await open(entry.originalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
        return mark(entry, 'changed', 'opened-file-changed');
      const buffer = Buffer.alloc(Number(stat.size) + 1); let length = 0;
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead; result.totalReadBytes += read.bytesRead;
      }
      entry.bytesRead = length;
      const after = await handle.stat({ bigint: true });
      if (BigInt(length) !== stat.size || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs)
        return mark(entry, 'changed', 'read-file-changed');
      const bytes = buffer.subarray(0, length); entry.sha256 = digest(bytes);
      const content = payload(bytes, workSync, journal);
      const size = Buffer.byteLength(JSON.stringify(content));
      if (result.payloadBytes + size > result.limits.payloadBytes) {
        entry.payloadStatus = 'budget'; result.status = 'partial';
      } else {
        Object.assign(entry, content); result.payloadBytes += size;
        if (content.payloadStatus !== 'captured') result.status = 'partial';
      }
    } catch (error) {
      const code = errorCode(error); mark(entry, code === 'ENOENT' ? 'absent' : 'unreadable', code);
    } finally { await handle?.close().catch(() => {}); }
  };
  const directory = async (path: string, depth: number, walk: boolean): Promise<boolean> => {
    if (directories.has(path)) return true;
    if (result.directories.length >= result.limits.directories || depth > result.limits.depth) {
      result.status = 'partial'; result.reason = 'directory-limit'; return false;
    }
    const entry = observe(path); result.directories.push(entry);
    try {
      const stat = await lstat(entry.originalPath, { bigint: true }); entry.identity = identity(stat);
      if (!stat.isDirectory() || stat.isSymbolicLink()) { mark(entry, 'unsafe', 'not-directory'); return false; }
      directories.add(path); entry.entries = [];
      const stream = await opendir(entry.originalPath);
      try {
        for (;;) {
          const child = await stream.read(); if (!child) break;
          if (entries >= result.limits.entries) {
            entry.truncated = true; result.status = 'partial'; result.reason = 'entry-limit'; break;
          }
          entries++;
          if (!safeName(child.name)) { entry.entries.push({ nameHash: digest(child.name), status: 'unsafe' }); continue; }
          const relative = path ? path + '/' + child.name : child.name;
          const childEntry: Row = { name: child.name, path: relative };
          entry.entries.push(childEntry);
          try {
            const childStat = await lstat(join(team, relative), { bigint: true });
            childEntry.identity = identity(childStat);
            childEntry.status = childStat.isSymbolicLink() || (!childStat.isDirectory() && !childStat.isFile()) ||
              childStat.isFile() && childStat.nlink !== 1n ? 'unsafe' : 'observed';
            if (walk && childStat.isDirectory() && !childStat.isSymbolicLink()) {
              const nested = await directory(relative, depth + 1, child.name !== WORK_SYNC);
              if (nested && child.name === WORK_SYNC) await readFile(relative + '/journal.jsonl', true, true);
            }
          } catch (error) { childEntry.status = 'unreadable'; childEntry.reason = errorCode(error); result.status = 'partial'; }
        }
      } finally { await stream.close().catch(() => {}); }
      return true;
    } catch (error) {
      const code = errorCode(error); mark(entry, code === 'ENOENT' ? 'absent' : 'unreadable', code); return false;
    }
  };
  try {
    if (!isAbsolute(root) || resolve(root) !== root || !/^TEST-desktop-backend-[A-Za-z0-9_-]+$/u.test(basename(root))) {
      result.status = 'unavailable'; result.reason = 'not-original-test-root'; return result;
    }
    // Fixed ancestors only. No symlink is followed into a different fixture or home.
    for (const path of [root, join(root, 'claude'), join(root, 'claude', 'teams')]) {
      const stat = await lstat(path, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) {
        result.status = 'unavailable'; result.reason = 'unsafe-ancestor'; return result;
      }
    }
    if (!await directory('', 0, false)) { result.status = 'unavailable'; return result; }
    for (const name of ROOT_FILES) await readFile(name);
    if (await directory(WORK_SYNC, 1, false)) {
      await readFile(WORK_SYNC + '/sqlite-fallback-replica.json', true);
      await readFile(WORK_SYNC + '/report-token-secret.json', true);
    }
    await directory('members', 1, true);
    return result;
  } catch (error) {
    result.status = result.files.length ? 'partial' : 'unavailable'; result.reason = errorCode(error); return result;
  }
}
