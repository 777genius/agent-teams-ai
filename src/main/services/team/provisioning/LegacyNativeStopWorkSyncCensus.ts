import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { readImportBytes } from '@agent-teams/legacy-agent-host/stopped-team-import';
import { decodeMemberWorkSyncStoredStatus } from '@agent-teams/legacy-agent-host/work-sync/storage/decodeMemberWorkSyncStoredStatus';
import {
  parseMemberWorkSyncTokenSecret,
  tokenSecretMatchesIdentity,
} from '@agent-teams/legacy-agent-host/work-sync/storage/memberWorkSyncTokenSecret';

import type { LegacyBackupIdentityMarker, LegacyNativeTarget } from './LegacyNativeStopCensus';
import type { Stats } from 'node:fs';

const MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 1024;
const ROOT = '.member-work-sync';
const snapshotFields = [
  'statuses',
  'reportIntents',
  'outboxItems',
  'metricEvents',
  'filesToArchive',
];
type Row = Record<string, unknown>;
const refuse = (): never => {
  throw new Error('Unqualified native WorkSync inventory');
};
const parse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return refuse();
  }
};
const record = (value: unknown): Row => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse();
  return value as Row;
};
function closed(value: unknown, required: string[], optional: string[] = []): Row {
  const row = record(value),
    keys = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some((key) => !keys.has(key))
  )
    refuse();
  return row;
}
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) return refuse();
  return value;
};
const text = (value: unknown): value is string =>
  typeof value === 'string' && !value.includes('\0');
const id = (value: unknown): value is string =>
  text(value) && value.length > 0 && value.trim() === value;
const timestamp = (value: unknown): boolean =>
  text(value) &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
  Number.isFinite(Date.parse(value));
const count = (value: unknown): boolean =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_ENTRIES;
const strings = (value: unknown): void => {
  if (!array(value).every(text)) refuse();
};
const optional = (row: Row, key: string, check: (value: unknown) => boolean): void => {
  if (Object.hasOwn(row, key) && !check(row[key])) refuse();
};
const identity = (row: Row, target: LegacyNativeTarget): void => {
  if (row.teamName !== target.teamName || row.memberName !== target.leadName) refuse();
};

function status(value: unknown, target: LegacyNativeTarget, incarnation: string): void {
  const row = closed(
    value,
    ['teamName', 'memberName', 'state', 'agenda', 'statusRevision', 'evaluatedAt', 'diagnostics'],
    ['providerId', 'reportToken', 'reportTokenExpiresAt', 'shadow']
  );
  identity(row, target);
  // This initial supported subset is inactive product history. Reports, runtime
  // admissions and recovery/receipt fields require separate terminal proofs.
  if (row.state !== 'inactive' || (row.providerId !== undefined && row.providerId !== 'anthropic'))
    refuse();
  const revision = closed(row.statusRevision, ['incarnation', 'lineageId', 'sequence', 'nonce']);
  if (revision.incarnation !== incarnation) refuse();
  const agenda = closed(
    row.agenda,
    ['teamName', 'memberName', 'generatedAt', 'fingerprint', 'items', 'diagnostics'],
    ['sourceRevision']
  );
  identity(agenda, target);
  strings(row.diagnostics);
  strings(agenda.diagnostics);
  for (const raw of array(agenda.items)) {
    const item = closed(
      raw,
      ['taskId', 'subject', 'kind', 'assignee', 'priority', 'reason', 'evidence'],
      ['displayId']
    );
    if (item.assignee !== target.leadName) refuse();
    const evidence = closed(
      item.evidence,
      ['status'],
      [
        'owner',
        'reviewer',
        'reviewState',
        'reviewCycleId',
        'reviewRequestEventId',
        'reviewRequestedAt',
        'reviewStartedEventId',
        'reviewStartedAt',
        'reviewStartedBy',
        'reviewObligation',
        'canBypassPhase2',
        'reviewDiagnostics',
        'needsClarification',
        'blockerTaskIds',
        'blockedByTaskIds',
        'historyEventIds',
      ]
    );
    for (const key of [
      'reviewDiagnostics',
      'blockerTaskIds',
      'blockedByTaskIds',
      'historyEventIds',
    ])
      if (evidence[key] !== undefined) strings(evidence[key]);
  }
  if (row.shadow !== undefined) {
    const shadow = closed(
      row.shadow,
      ['reconciledBy', 'wouldNudge', 'fingerprintChanged'],
      ['previousFingerprint', 'triggerReasons']
    );
    if (shadow.wouldNudge !== false) refuse();
    if (shadow.triggerReasons !== undefined) strings(shadow.triggerReasons);
  }
  // Reuse the original domain validators after closing every admitted object.
  decodeMemberWorkSyncStoredStatus(row, {
    teamName: target.teamName,
    memberName: target.leadName,
    incarnation,
  });
}

function metric(value: unknown, target: LegacyNativeTarget): void {
  const row = closed(
    value,
    [
      'id',
      'teamName',
      'memberName',
      'kind',
      'state',
      'agendaFingerprint',
      'recordedAt',
      'actionableCount',
    ],
    ['providerId', 'previousFingerprint', 'triggerReasons']
  );
  identity(row, target);
  if (
    !id(row.id) ||
    !text(row.kind) ||
    !['status_evaluated', 'fingerprint_changed'].includes(row.kind) ||
    row.state !== 'inactive' ||
    !id(row.agendaFingerprint) ||
    !timestamp(row.recordedAt) ||
    !count(row.actionableCount)
  )
    refuse();
  optional(row, 'providerId', (value) => value === 'anthropic');
  optional(row, 'previousFingerprint', text);
  if (row.triggerReasons !== undefined) strings(row.triggerReasons);
}

function replica(value: unknown, target: LegacyNativeTarget, incarnation: string): void {
  const envelope = closed(value, [
    'schemaVersion',
    'state',
    'updatedAt',
    'incarnation',
    'snapshot',
  ]);
  if (
    envelope.schemaVersion !== 1 ||
    envelope.state !== 'clean' ||
    envelope.incarnation !== incarnation ||
    !timestamp(envelope.updatedAt)
  )
    refuse();
  const snapshot = closed(envelope.snapshot, snapshotFields);
  if (
    array(snapshot.reportIntents).length ||
    array(snapshot.outboxItems).length ||
    array(snapshot.filesToArchive).length
  )
    refuse();
  const statuses = array(snapshot.statuses);
  if (statuses.length !== 1) refuse();
  status(statuses[0], target, incarnation);
  const seen = new Set<string>();
  for (const raw of array(snapshot.metricEvents)) {
    metric(raw, target);
    const key = record(raw).id as string;
    if (seen.has(key)) refuse();
    seen.add(key);
  }
}

/** The unprepared SQLite read path may publish this product-only empty snapshot. */
function emptyReplica(value: unknown): void {
  const envelope = closed(value, ['schemaVersion', 'state', 'updatedAt', 'snapshot']);
  if (envelope.schemaVersion !== 1 || envelope.state !== 'clean' || !timestamp(envelope.updatedAt))
    refuse();
  const snapshot = closed(envelope.snapshot, snapshotFields);
  if (snapshotFields.some((key) => array(snapshot[key]).length !== 0)) refuse();
}

const auditSources = new Map([
  ['queue_enqueued', 'event_queue'],
  ['queue_coalesced', 'event_queue'],
  ['queue_reconciled', 'event_queue'],
  ['reconcile_started', 'reconciler'],
  ['agenda_loaded', 'reconciler'],
  ['team_inactive', 'reconciler'],
]);
function audit(raw: string, target: LegacyNativeTarget): void {
  if (raw && !raw.endsWith('\n')) refuse();
  const lines = raw ? raw.slice(0, -1).split('\n') : [];
  if (lines.length > MAX_ENTRIES) refuse();
  for (const line of lines) {
    const row = closed(
      parse(line),
      ['schemaVersion', 'timestamp', 'teamName', 'memberName', 'event', 'source'],
      [
        'agendaFingerprint',
        'state',
        'actionableCount',
        'reason',
        'triggerReasons',
        'providerId',
        'taskRefs',
        'diagnostics',
      ]
    );
    identity(row, target);
    if (
      row.schemaVersion !== 1 ||
      !timestamp(row.timestamp) ||
      !text(row.event) ||
      auditSources.get(row.event) !== row.source
    )
      refuse();
    optional(row, 'state', (value) => value === 'inactive');
    optional(row, 'providerId', (value) => value === 'anthropic');
    optional(row, 'actionableCount', count);
    for (const key of ['agendaFingerprint', 'reason'])
      optional(row, key, (value) => id(value) && value.length <= 243);
    for (const key of ['triggerReasons', 'diagnostics'])
      if (row[key] !== undefined) {
        const values = array(row[key]);
        if (values.length > 20 || !values.every((value) => text(value) && value.length <= 243))
          refuse();
      }
    if (row.taskRefs !== undefined) {
      const refs = array(row.taskRefs);
      if (refs.length > 20) refuse();
      for (const rawRef of refs) {
        const ref = closed(rawRef, ['taskId'], ['displayId', 'teamName']);
        if (!id(ref.taskId) || ref.taskId.length > 243) refuse();
        optional(ref, 'displayId', (value) => text(value) && value.length <= 243);
        optional(ref, 'teamName', (value) => value === target.teamName);
      }
    }
  }
}

function same(left: Stats, right: Stats): boolean {
  return [
    'dev',
    'ino',
    'mode',
    'nlink',
    'uid',
    'gid',
    'size',
    'mtimeMs',
    'ctimeMs',
    'birthtimeMs',
  ].every((key) => left[key as keyof Stats] === right[key as keyof Stats]);
}
function directoryIdentity(value: Stats) {
  if (
    !Number.isSafeInteger(value.dev) ||
    !Number.isSafeInteger(value.ino) ||
    !Number.isFinite(value.birthtimeMs)
  )
    refuse();
  return { dev: value.dev, ino: value.ino, birthtimeMs: value.birthtimeMs };
}

/** Content classification only. The caller separately owns quiescence and the original native release. */
export function readLegacyNativeWorkSyncCensus(
  teamDir: string,
  target: LegacyNativeTarget,
  marker: LegacyBackupIdentityMarker
): unknown | null {
  if (realpathSync(teamDir) !== teamDir || !id(target.leadName)) return refuse();
  const key = encodeURIComponent(target.leadName.trim().toLowerCase());
  if (!key || key === '.' || key === '..') return refuse();
  const leadPath = `members/${key}`,
    journalDir = `${leadPath}/${ROOT}`;
  const directoryCuts = new Map<string, { stat: Stats; names: string[] }>();
  const fileCuts = new Map<string, Stats>();
  let entries = 0,
    journalFound = false;
  const directory = (relative: string): string[] => {
    const path = join(teamDir, relative),
      stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return refuse();
    const names = readdirSync(path).sort();
    entries += names.length;
    if (entries > MAX_ENTRIES) return refuse();
    directoryCuts.set(relative, { stat, names });
    return names;
  };
  const exactFiles = (relative: string, expected: string[]): void => {
    const names = directory(relative);
    if (JSON.stringify(names) !== JSON.stringify([...expected].sort())) refuse();
    for (const name of names) {
      const stat = lstatSync(join(teamDir, relative, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) refuse();
    }
  };
  const walkMembers = (relative: string, depth = 0): void => {
    if (depth > 48) refuse();
    for (const name of directory(relative)) {
      const child = `${relative}/${name}`,
        stat = lstatSync(join(teamDir, child));
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink !== 1)
      )
        refuse();
      if (name.toLowerCase().startsWith(ROOT)) {
        if (child !== journalDir || name !== ROOT) return refuse();
        exactFiles(child, ['journal.jsonl']);
        journalFound = true;
      } else if (stat.isDirectory()) walkMembers(child, depth + 1);
    }
  };
  const roots = directory('');
  if (roots.some((name) => name.toLowerCase().startsWith(ROOT) && name !== ROOT)) refuse();
  const rootFound = roots.includes(ROOT);
  if (rootFound)
    exactFiles(
      ROOT,
      marker.present
        ? ['report-token-secret.json', 'sqlite-fallback-replica.json']
        : ['sqlite-fallback-replica.json']
    );
  if (roots.includes('members')) walkMembers('members');
  const close = (): void => {
    for (const [relative, cut] of directoryCuts) {
      const path = join(teamDir, relative);
      if (
        !same(cut.stat, lstatSync(path)) ||
        JSON.stringify(readdirSync(path).sort()) !== JSON.stringify(cut.names)
      )
        refuse();
    }
    for (const [relative, stat] of fileCuts)
      if (!same(stat, lstatSync(join(teamDir, relative)))) refuse();
  };
  if (!rootFound && !journalFound) {
    close();
    return null;
  }
  const read = (relative: string): string => {
    const path = join(teamDir, relative),
      before = lstatSync(path);
    const bytes = readImportBytes(path, MAX_BYTES),
      after = lstatSync(path);
    if (!same(before, after)) return refuse();
    fileCuts.set(relative, after);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  };
  if (rootFound && !journalFound && !marker.present) {
    emptyReplica(parse(read(`${ROOT}/sqlite-fallback-replica.json`)));
    close();
    // Presence and directory ownership remain in the cut; an empty snapshot
    // grants neither a report-token owner nor native/recovery authority.
    return {
      version: 1,
      kind: 'empty-replica',
      teamName: target.teamName,
      leadName: target.leadName,
      directories: ['', ROOT].map((path) => ({
        path,
        ...directoryIdentity(directoryCuts.get(path)?.stat ?? refuse()),
      })),
      files: [`${ROOT}/sqlite-fallback-replica.json`],
    };
  }
  if (!rootFound || !journalFound || !marker.present) return refuse();
  const secretRaw = read(`${ROOT}/report-token-secret.json`);
  closed(parse(secretRaw), ['schemaVersion', 'secret', 'teamName', 'incarnation']);
  const secret = parseMemberWorkSyncTokenSecret(secretRaw);
  if (!tokenSecretMatchesIdentity(secret, { teamName: target.teamName, incarnation: marker.value }))
    refuse();
  replica(parse(read(`${ROOT}/sqlite-fallback-replica.json`)), target, marker.value);
  audit(read(`${journalDir}/journal.jsonl`), target);
  close();
  // Mutable product data are revalidated above, never mistaken for native identity.
  // Presence and original directories/secret remain part of the native census cut.
  return {
    version: 1,
    teamName: target.teamName,
    leadName: target.leadName,
    incarnation: marker.value,
    secretHash: createHash('sha256').update(secret.secret).digest('hex'),
    directories: ['', ROOT, 'members', leadPath, journalDir].map((path) => ({
      path,
      ...directoryIdentity(directoryCuts.get(path)?.stat ?? refuse()),
    })),
    files: [
      `${ROOT}/report-token-secret.json`,
      `${ROOT}/sqlite-fallback-replica.json`,
      `${journalDir}/journal.jsonl`,
    ],
  };
}
