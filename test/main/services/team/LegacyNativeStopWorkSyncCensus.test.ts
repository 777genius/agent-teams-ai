// @vitest-environment node
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { InternalStorageJsonReplica } from '../../../../src/features/internal-storage/main/infrastructure/InternalStorageJsonReplica';
import { isMemberWorkSyncStoreSnapshot } from '../../../../src/features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';
import { recordsToSnapshot } from '../../../../src/features/member-work-sync/main/infrastructure/memberWorkSyncSqliteMappers';
import { readLegacyNativeWorkSyncCensus } from '../../../../src/main/services/team/provisioning/LegacyNativeStopWorkSyncCensus';

import type { LegacyNativeTarget } from '../../../../src/main/services/team/provisioning/LegacyNativeStopCensus';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
type Row = Record<string, unknown>;
const timestamp = '2026-11-19T03:00:00.000Z';
const rootPath = '.member-work-sync';
const journalPath = 'members/team-lead/.member-work-sync/journal.jsonl';

function fixture(present = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-native-work-sync-census-')));
  roots.push(root);
  const teamDir = join(root, 'TEST-team');
  mkdirSync(teamDir);
  const target: LegacyNativeTarget = {
    teamName: 'TEST-team',
    leadName: 'team-lead',
    runId: 'TEST-run',
    sessionId: 'TEST-session',
    rootPid: 42101,
  };
  const marker = { present: true, value: 'TEST-incarnation' } as const;
  const secret: Row = {
    schemaVersion: 2,
    secret: 'TEST-private-secret-'.padEnd(43, 'x'),
    teamName: 'test-team',
    incarnation: marker.value,
  };
  const agenda: Row = {
    teamName: target.teamName,
    memberName: target.leadName,
    generatedAt: timestamp,
    fingerprint: 'TEST-fingerprint',
    items: [],
    diagnostics: ['team_runtime_inactive'],
  };
  const revision: Row = {
    incarnation: marker.value,
    lineageId: 'TEST-lineage',
    sequence: 1,
    nonce: 'TEST-nonce',
  };
  const shadow: Row = {
    reconciledBy: 'queue',
    wouldNudge: false,
    fingerprintChanged: false,
    triggerReasons: ['runtime_activity'],
  };
  const status: Row = {
    teamName: target.teamName,
    memberName: target.leadName,
    state: 'inactive',
    agenda,
    statusRevision: revision,
    evaluatedAt: timestamp,
    diagnostics: ['member_or_team_inactive', 'report_token_issued'],
    providerId: 'anthropic',
    reportToken: 'TEST-private-report-token',
    reportTokenExpiresAt: timestamp,
    shadow,
  };
  const metric: Row = {
    id: 'TEST-metric',
    teamName: target.teamName,
    memberName: target.leadName,
    kind: 'status_evaluated',
    state: 'inactive',
    agendaFingerprint: 'TEST-fingerprint',
    recordedAt: timestamp,
    actionableCount: 0,
    providerId: 'anthropic',
    triggerReasons: ['runtime_activity'],
  };
  const snapshot: Row = {
    statuses: [status],
    reportIntents: [],
    outboxItems: [],
    metricEvents: [metric],
    filesToArchive: [],
  };
  const replica: Row = {
    schemaVersion: 1,
    state: 'clean',
    incarnation: marker.value,
    updatedAt: timestamp,
    snapshot,
  };
  const audit = [
    { event: 'queue_enqueued', source: 'event_queue', reason: 'runtime_activity' },
    { event: 'reconcile_started', source: 'reconciler', triggerReasons: ['runtime_activity'] },
    {
      event: 'agenda_loaded',
      source: 'reconciler',
      agendaFingerprint: 'TEST-fingerprint',
      actionableCount: 0,
      providerId: 'anthropic',
      diagnostics: [],
    },
    {
      event: 'team_inactive',
      source: 'reconciler',
      state: 'inactive',
      agendaFingerprint: 'TEST-fingerprint',
      actionableCount: 0,
      providerId: 'anthropic',
      diagnostics: [],
    },
    { event: 'queue_reconciled', source: 'event_queue', triggerReasons: ['runtime_activity'] },
  ].map(
    (row) =>
      ({
        schemaVersion: 1,
        timestamp,
        teamName: target.teamName,
        memberName: target.leadName,
        ...row,
      }) as Row
  );
  const write = (path: string, value: unknown) => {
    mkdirSync(dirname(join(teamDir, path)), { recursive: true });
    writeFileSync(join(teamDir, path), JSON.stringify(value));
  };
  const publish = () => {
    write(`${rootPath}/report-token-secret.json`, secret);
    write(`${rootPath}/sqlite-fallback-replica.json`, replica);
    mkdirSync(dirname(join(teamDir, journalPath)), { recursive: true });
    writeFileSync(
      join(teamDir, journalPath),
      audit.map((row) => JSON.stringify(row)).join('\n') + '\n'
    );
  };
  if (present) publish();
  return {
    root,
    teamDir,
    target,
    marker,
    secret,
    agenda,
    revision,
    shadow,
    status,
    metric,
    snapshot,
    replica,
    audit,
    write,
    publish,
    read: () => readLegacyNativeWorkSyncCensus(teamDir, target, marker),
  };
}

async function emptyReplicaFixture() {
  const f = fixture(false);
  const replicaPath = join(f.teamDir, rootPath, 'sqlite-fallback-replica.json');
  const writer = new InternalStorageJsonReplica(() => replicaPath, isMemberWorkSyncStoreSnapshot);
  // These are the actual mapper and writer used by the unprepared SQLite read path.
  await writer.writeClean(
    f.target.teamName,
    recordsToSnapshot(f.target.teamName, {
      statuses: [],
      reportIntents: [],
      outboxItems: [],
      metricEvents: [],
    })
  );
  const envelope = JSON.parse(readFileSync(replicaPath, 'utf8')) as Row;
  return {
    ...f,
    replicaPath,
    writer,
    envelope,
    read: (markerPresent = false) =>
      readLegacyNativeWorkSyncCensus(
        f.teamDir,
        f.target,
        markerPresent ? f.marker : { present: false }
      ),
  };
}

describe('strict native Stop WorkSync product census', () => {
  it('classifies the real clean-empty SQLite replica without inventing native history or a token owner', async () => {
    const f = await emptyReplicaFixture();
    expect(f.envelope).toEqual({
      schemaVersion: 1,
      state: 'clean',
      updatedAt: expect.any(String),
      snapshot: {
        statuses: [],
        reportIntents: [],
        outboxItems: [],
        metricEvents: [],
        filesToArchive: [],
      },
    });
    const proof = f.read() as Row;
    expect(proof).toMatchObject({
      version: 1,
      kind: 'empty-replica',
      teamName: f.target.teamName,
      leadName: f.target.leadName,
      files: [`${rootPath}/sqlite-fallback-replica.json`],
    });
    expect((proof.directories as Row[]).map((value) => value.path)).toEqual(['', rootPath]);
    expect(proof).not.toHaveProperty('incarnation');
    expect(proof).not.toHaveProperty('secretHash');
    expect(JSON.stringify(proof)).not.toContain('updatedAt');
    expect(f.read(true)).toEqual(proof);
  });

  it.each([
    ['statuses', [{}]],
    ['reportIntents', [{}]],
    ['outboxItems', [{}]],
    ['metricEvents', [{}]],
    ['filesToArchive', ['TEST-file']],
    ['unknown', []],
    ['statuses', null],
    ['metricEvents', {}],
  ])('refuses a clean-empty candidate with snapshot %s=%j', async (key, value) => {
    const f = await emptyReplicaFixture();
    (f.envelope.snapshot as Row)[key as string] = value;
    f.write(`${rootPath}/sqlite-fallback-replica.json`, f.envelope);
    expect(f.read).toThrow();
    expect(() => f.read(true)).toThrow();
  });

  it.each([
    ['state', 'dirty'],
    ['schemaVersion', 2],
    ['incarnation', 'TEST-incarnation'],
    ['runtimePid', 123],
    ['updatedAt', 'invalid'],
    ['snapshot', null],
  ])('refuses a clean-empty candidate with envelope %s=%j', async (key, value) => {
    const f = await emptyReplicaFixture();
    f.envelope[key as string] = value;
    f.write(`${rootPath}/sqlite-fallback-replica.json`, f.envelope);
    expect(f.read).toThrow();
    expect(() => f.read(true)).toThrow();
  });

  it('refuses a missing empty-array field and an incomplete native journal or secret', async () => {
    const f = await emptyReplicaFixture();
    delete (f.envelope.snapshot as Row).filesToArchive;
    f.write(`${rootPath}/sqlite-fallback-replica.json`, f.envelope);
    expect(f.read).toThrow();
    expect(() => f.read(true)).toThrow();
    for (const path of [
      `${rootPath}/report-token-secret.json`,
      journalPath,
      'members/foreign/.member-work-sync/journal.jsonl',
      `${rootPath}/unknown.json`,
    ]) {
      const incomplete = await emptyReplicaFixture();
      incomplete.write(path, {});
      expect(incomplete.read).toThrow();
      expect(() => incomplete.read(true)).toThrow();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'keeps fresh file, link and directory fences for the empty replica',
    async () => {
      const f = await emptyReplicaFixture(),
        before = f.read();
      renameSync(join(f.teamDir, rootPath), join(f.root, 'previous-empty'));
      f.write(`${rootPath}/sqlite-fallback-replica.json`, f.envelope);
      expect(f.read()).not.toEqual(before);
      const external = join(f.root, 'external-empty.json');
      renameSync(f.replicaPath, external);
      symlinkSync(external, f.replicaPath);
      expect(f.read).toThrow();
      expect(() => f.read(true)).toThrow();
      rmSync(f.replicaPath);
      linkSync(external, f.replicaPath);
      expect(f.read).toThrow();
      expect(() => f.read(true)).toThrow();
    }
  );

  it('accepts the original inactive solo history but does not return tokens or product content', () => {
    const f = fixture();
    const proof = f.read() as Row;
    expect(proof).toMatchObject({
      version: 1,
      teamName: f.target.teamName,
      leadName: f.target.leadName,
      incarnation: f.marker.value,
    });
    expect(proof.files).toEqual([
      `${rootPath}/report-token-secret.json`,
      `${rootPath}/sqlite-fallback-replica.json`,
      journalPath,
    ]);
    expect(proof.secretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(proof)).not.toMatch(
      /TEST-private|TEST-fingerprint|TEST-metric|runtime_activity/
    );
  });

  it('keeps the native projection stable across permitted product task, agenda, metric and audit changes', () => {
    const f = fixture(),
      before = f.read();
    f.write('tasks/TEST-task.json', { id: 'TEST-task', subject: 'New product task after Stop' });
    f.agenda.fingerprint = 'TEST-next-product-fingerprint';
    f.agenda.items = [
      {
        taskId: 'TEST-task',
        subject: 'Product change',
        kind: 'work',
        assignee: f.target.leadName,
        priority: 'normal',
        reason: 'assigned',
        evidence: {
          status: 'pending',
          owner: f.target.leadName,
          historyEventIds: ['TEST-product-event'],
        },
      },
    ];
    f.shadow.fingerprintChanged = true;
    f.shadow.previousFingerprint = 'TEST-fingerprint';
    f.revision.sequence = 2;
    f.revision.nonce = 'TEST-next-nonce';
    f.metric.actionableCount = 1;
    f.metric.kind = 'fingerprint_changed';
    f.audit.push({
      schemaVersion: 1,
      timestamp,
      teamName: f.target.teamName,
      memberName: f.target.leadName,
      event: 'queue_coalesced',
      source: 'event_queue',
      reason: 'task_changed',
      taskRefs: [{ taskId: 'TEST-task', teamName: f.target.teamName }],
    });
    f.publish();
    expect(f.read()).toEqual(before);
    f.status.runtimeAdmission = { state: 'pending', controlRevision: 1 };
    f.publish();
    expect(f.read).toThrow();
  });

  it.each([
    [
      'missing backup incarnation',
      (f: ReturnType<typeof fixture>) => {
        delete f.replica.incarnation;
      },
    ],
    [
      'foreign envelope incarnation',
      (f: ReturnType<typeof fixture>) => {
        f.replica.incarnation = 'foreign';
      },
    ],
    [
      'foreign secret incarnation',
      (f: ReturnType<typeof fixture>) => {
        f.secret.incarnation = 'foreign';
      },
    ],
    [
      'unbound old secret',
      (f: ReturnType<typeof fixture>) => {
        f.secret.schemaVersion = 1;
      },
    ],
    [
      'missing status revision',
      (f: ReturnType<typeof fixture>) => {
        delete f.status.statusRevision;
      },
    ],
    [
      'foreign status incarnation',
      (f: ReturnType<typeof fixture>) => {
        f.revision.incarnation = 'foreign';
      },
    ],
    [
      'foreign lead',
      (f: ReturnType<typeof fixture>) => {
        f.status.memberName = 'foreign';
      },
    ],
    [
      'dirty replica',
      (f: ReturnType<typeof fixture>) => {
        f.replica.state = 'dirty';
      },
    ],
    [
      'unknown live status',
      (f: ReturnType<typeof fixture>) => {
        f.status.state = 'unknown';
      },
    ],
    [
      'pending delivery',
      (f: ReturnType<typeof fixture>) => {
        f.snapshot.outboxItems = [{ status: 'pending' }];
      },
    ],
    [
      'pending report',
      (f: ReturnType<typeof fixture>) => {
        f.snapshot.reportIntents = [{ status: 'pending' }];
      },
    ],
    [
      'pending report receipt',
      (f: ReturnType<typeof fixture>) => {
        f.status.pendingReportReceipt = {};
      },
    ],
    [
      'recovery obligations',
      (f: ReturnType<typeof fixture>) => {
        f.status.recoveryHealth = { schemaVersion: 1, episodes: [] };
      },
    ],
    [
      'planned nudge',
      (f: ReturnType<typeof fixture>) => {
        f.shadow.wouldNudge = true;
      },
    ],
    [
      'unknown revision key',
      (f: ReturnType<typeof fixture>) => {
        f.revision.runtimePid = 12;
      },
    ],
    [
      'unknown agenda key',
      (f: ReturnType<typeof fixture>) => {
        f.agenda.nativeSessionId = 'foreign';
      },
    ],
    [
      'unknown replica key',
      (f: ReturnType<typeof fixture>) => {
        f.replica.runtime = {};
      },
    ],
    [
      'unknown secret key',
      (f: ReturnType<typeof fixture>) => {
        f.secret.runtimePid = 12;
      },
    ],
    [
      'new audit recovery',
      (f: ReturnType<typeof fixture>) => {
        f.audit[0]!.event = 'proof_missing_recovery_scheduled';
      },
    ],
    [
      'foreign audit lead',
      (f: ReturnType<typeof fixture>) => {
        f.audit[0]!.memberName = 'foreign';
      },
    ],
    [
      'unknown audit fields',
      (f: ReturnType<typeof fixture>) => {
        f.audit[0]!.runtimePid = 12;
      },
    ],
  ])('refuses %s without normalizing it into product history', (_name, change) => {
    const f = fixture();
    change(f);
    f.publish();
    expect(f.read).toThrow();
  });

  it('requires explicit original marker and keeps secret/directory replacement in the projection', () => {
    const f = fixture(),
      before = f.read();
    expect(() => readLegacyNativeWorkSyncCensus(f.teamDir, f.target, { present: false })).toThrow();
    expect(() =>
      readLegacyNativeWorkSyncCensus(f.teamDir, f.target, { present: true, value: 'foreign' })
    ).toThrow();
    f.secret.secret = 'TEST-private-replacement-secret'.padEnd(43, 'x');
    f.publish();
    const rotated = f.read();
    expect(rotated).not.toEqual(before);
    renameSync(join(f.teamDir, rootPath), join(f.root, 'old-work-sync'));
    f.publish();
    expect(f.read()).not.toEqual(rotated);
  });

  it('distinguishes absence, complete presence and orphan/partial inventory', () => {
    const f = fixture(false);
    f.write('members/team-lead/member.meta.json', { schemaVersion: 1 });
    expect(f.read()).toBeNull();
    f.publish();
    expect(f.read()).not.toBeNull();
    rmSync(join(f.teamDir, rootPath), { recursive: true });
    expect(f.read).toThrow();
    rmSync(join(f.teamDir, 'members'), { recursive: true });
    f.write(`${rootPath}/report-token-secret.json`, f.secret);
    expect(f.read).toThrow();
  });

  it.each([
    `${rootPath}/unknown.json`,
    `${rootPath}/sqlite-fallback-replica.json.invalid.1`,
    `${journalPath}.1`,
    'members/foreign/.member-work-sync/journal.jsonl',
    'members/TEAM-LEAD/.member-work-sync/journal.jsonl',
    'members/team-lead/nested/.member-work-sync/journal.jsonl',
    '.member-work-sync-alias/journal.jsonl',
    '.Member-Work-Sync/journal.jsonl',
  ])('refuses unqualified or aliased path %s', (path) => {
    const f = fixture();
    f.write(path, {});
    expect(f.read).toThrow();
  });

  it('does not report absence when only a foreign nested journal exists', () => {
    const f = fixture(false);
    f.write('members/foreign/nested/.member-work-sync/journal.jsonl', {});
    expect(f.read).toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'rejects symlinked and multiply linked canonical artifacts and member directories',
    () => {
      for (const path of [`${rootPath}/report-token-secret.json`, journalPath]) {
        const f = fixture(),
          target = join(f.root, 'external-file');
        renameSync(join(f.teamDir, path), target);
        symlinkSync(target, join(f.teamDir, path));
        expect(f.read).toThrow();
        rmSync(join(f.teamDir, path));
        linkSync(target, join(f.teamDir, path));
        expect(f.read).toThrow();
      }
      const f = fixture(false),
        external = join(f.root, 'external-members');
      mkdirSync(external);
      symlinkSync(external, join(f.teamDir, 'members'));
      expect(f.read).toThrow();
    }
  );

  it('preserves the existing one MiB reader and 1024-entry census bounds', () => {
    const f = fixture();
    writeFileSync(join(f.teamDir, journalPath), ' '.repeat(1024 * 1024 + 1));
    expect(f.read).toThrow();
    f.publish();
    for (let i = 0; i < 1024; i++) f.write(`members/team-lead/product-${i}.json`, {});
    expect(f.read).toThrow();
  });

  it('rejects malformed/partial UTF-8 and incomplete journal rows', () => {
    const f = fixture();
    const path = join(f.teamDir, journalPath),
      original = readFileSync(path);
    writeFileSync(path, Buffer.from([0xff]));
    expect(f.read).toThrow();
    writeFileSync(path, original.subarray(0, original.length - 1));
    expect(f.read).toThrow();
  });
});
