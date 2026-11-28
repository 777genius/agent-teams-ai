import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { digest } from '../dist/team/identity.js';
import { collectImportReferences } from '../dist/stopped-team-import/references.js';
import {
  exportStoppedTeam,
  STOPPED_IMPORT_LIMITS,
  validateStoppedSnapshot,
} from '../dist/stopped-team-import/snapshot.js';
import type { StoppedImportOptions } from '../dist/stopped-team-import/FileStoppedTeamImport.js';
import { TeamRegistry } from '../dist/team-registry/TeamRegistry.js';
import { FileStoppedTeamImport } from '../dist/stopped-team-import/FileStoppedTeamImport.js';
import { FileStoppedSnapshotResolver } from '../dist/stopped-team-import/FileStoppedSnapshotResolver.js';
import { stoppedTeamImportRoutes } from '../dist/stopped-team-import/stoppedTeamImportRoutes.js';
import { importCategories } from '../dist/stopped-team-import/contracts.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import type {
  SnapshotHeader,
  StoppedTeamSource,
  StoppedImportContext,
} from '../dist/stopped-team-import/contracts.js';
import type { HostedTeamDefinition } from '../dist/team-registry/definition.js';
import type { TestContext } from 'node:test';

function encoded(ref: { taskId: string; displayId: string; teamName: string }) {
  const alphabet = ['\u200b', '\u200c', '\u200d', '\u2060'];
  return (
    '\u2063' +
    [...Buffer.from(JSON.stringify(ref))]
      .map((byte) => [6, 4, 2, 0].map((shift) => alphabet[(byte >> shift) & 3]).join(''))
      .join('') +
    '\u2064'
  );
}
test('reference scanning preserves qualified targets and holds malformed marker streams', () => {
  const source = 'TEST-source';
  const internal = { taskId: 'TEST-a', displayId: 'a', teamName: source };
  const missing = { taskId: 'TEST-missing', displayId: 'missing', teamName: source };
  const external = { taskId: 'TEST-external', displayId: 'external', teamName: 'TEST-other' };
  const tasks = new Set([internal.taskId]);
  const found = collectImportReferences(
    `\u2064${encoded(internal)} ${encoded(missing)} task://TEST-external?team=TEST-other&display=external`,
    source,
    tasks
  );
  assert.deepEqual(
    new Set(found.map((ref) => JSON.stringify(ref))),
    new Set([
      JSON.stringify({ ...internal, target: 'internal' }),
      JSON.stringify({ ...missing, target: 'unresolved' }),
      JSON.stringify({ ...external, target: 'source-archive' }),
    ])
  );
  for (const text of [
    '\u2063'.repeat(1_000_000),
    `${encoded(internal)}\u2063`,
    `\u2063${encoded(internal)}`,
    '\u2063x\u2064',
    `\u2063${'\u200b'.repeat(16_388)}\u2064`,
    '\u2063\u2064',
  ]) {
    assert.throws(() => collectImportReferences(text, source, tasks), { code: 'hold' });
  }
});
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-stopped-team-import-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source'),
    destination = join(root, 'destination');
  mkdirSync(sourceRoot);
  mkdirSync(destination);
  const roots = importCategories.map((category) => {
    const path = join(sourceRoot, category);
    mkdirSync(path);
    return { category, path };
  });
  const path = (category: (typeof importCategories)[number], name: string) =>
    join(roots.find((root) => root.category === category)!.path, name);
  mkdirSync(path('attachments', 'TEST-message'));
  writeFileSync(path('attachments', 'TEST-message/TEST-blob--diagram.png'), 'TEST-image');
  const ref = { taskId: 'TEST-b', displayId: 'b', teamName: 'TEST-old-team' };
  const external = {
    taskId: 'TEST-external',
    displayId: 'ext',
    teamName: 'TEST-colliding-host-name',
  };
  writeFileSync(
    path('tasks', 'TEST-a.json'),
    JSON.stringify({
      id: 'TEST-a',
      subject: 'A',
      status: 'in_progress',
      blockedBy: ['TEST-b'],
      description: `Known #b${encoded(ref)} and [outside](task://TEST-external?team=TEST-colliding-host-name&display=ext)`,
      descriptionTaskRefs: [ref, external],
      comments: [
        {
          id: 'TEST-comment',
          text: 'Retain comment',
          author: 'user',
          createdAt: '2026-10-23',
          taskRefs: [external],
        },
      ],
      historyEvents: [
        {
          id: 'TEST-history',
          kind: 'status_changed',
          from: 'pending',
          to: 'in_progress',
        },
      ],
      attachments: [
        {
          id: 'TEST-blob',
          filename: 'diagram.png',
          mimeType: 'image/png',
          size: 10,
          filePath: path('attachments', 'TEST-message/TEST-blob--diagram.png'),
        },
      ],
    })
  );
  writeFileSync(
    path('tasks', 'TEST-b.json'),
    JSON.stringify({
      id: 'TEST-b',
      subject: 'B',
      status: 'completed',
      blocks: ['TEST-a'],
    })
  );
  writeFileSync(
    path('team', 'config.json'),
    JSON.stringify({ name: 'TEST-old-team', members: [{ name: 'captain' }] })
  );
  writeFileSync(
    path('team', 'auth.json'),
    JSON.stringify({ accessToken: 'TEST-secret-never-copy' })
  );
  mkdirSync(path('team', 'inboxes'));
  writeFileSync(
    path('team', 'inboxes/user.json'),
    JSON.stringify([{ messageId: 'TEST-old-message', text: 'Keep reply', taskRefs: [ref] }])
  );
  writeFileSync(
    path('history', 'TEST-source.jsonl'),
    JSON.stringify({
      type: 'user',
      message: { content: 'Retain archive history' },
    }) + '\n'
  );
  writeFileSync(
    path('evidence', 'TEST-diff.patch'),
    '--- a/TEST.txt\n+++ b/TEST.txt\n+TEST-retained\n'
  );
  const header: SnapshotHeader = {
    sourceOwnerId: 'TEST-legacy-owner',
    sourceId: 'TEST-source',
    sourceTeamName: 'TEST-old-team',
    sourceRevision: 'a'.repeat(64),
    savedSettings: {
      cwd: '/TEST/workspace',
      model: 'TEST-model',
      skipPermissions: false,
      syncModelsWithLead: false,
      fastMode: 'off',
    },
    members: [
      {
        memberId: 'TEST-lead',
        name: 'captain',
        role: 'lead',
        settings: { model: 'TEST-model' },
      },
    ],
    obligations: {
      launch: 'released',
      bootstrap: 'released',
      lane: 'released',
      session: 'released',
      stop: 'released',
      command: 'released',
      delivery: 'released',
      custody: 'released',
      background: 'released',
    },
    gaps: [],
  };
  let captures = 0;
  const source: StoppedTeamSource = {
    roots,
    fenced: (fn) => fn(),
    describe: async () => {
      captures++;
      return structuredClone(header);
    },
  };
  const origins: StoppedImportContext[] = [],
    attached: HostedTeamDefinition[] = [];
  const faults = { attach: false };
  const options: StoppedImportOptions = {
    root: destination,
    ownerId: 'TEST-host-owner',
    profileId: 'TEST-profile',
    principalId: 'TEST-human',
    contextIds: ['TEST-context'],
    validateConfiguration() {},
    assertWriter() {},
    existingRecords: () => [],
    bindOrigin(_record, context) {
      origins.push(context);
    },
    attach(definition) {
      if (faults.attach) throw new Error('TEST-interrupted-before-publication');
      attached.push(definition);
    },
  };
  const importer = new FileStoppedTeamImport(options);
  return {
    root,
    sourceRoot,
    destination,
    path,
    source,
    header,
    importer,
    options,
    faults,
    origins,
    attached,
    captures: () => captures,
  };
}

test('actual saved-draft layout exports and detached-validates without manufacturing config', async (t) => {
  const f = fixture(t);
  rmSync(f.path('team', 'config.json'));
  f.header.sourceKind = 'saved-draft';
  writeFileSync(
    f.path('team', 'team.meta.json'),
    JSON.stringify({
      version: 1,
      cwd: '/TEST/workspace',
      createdAt: 1,
    })
  );
  writeFileSync(f.path('team', 'members.meta.json'), JSON.stringify({ version: 1, members: [] }));
  const snapshot = await exportStoppedTeam(f.source);
  assert.equal(
    snapshot.files.some((file) => file.path === 'config.json'),
    false
  );
  assert.deepEqual(validateStoppedSnapshot(snapshot), snapshot);
  const missingKind = structuredClone(snapshot);
  delete missingKind.header.sourceKind;
  const { digest: _digest, ...body } = missingKind;
  missingKind.digest = digest(body);
  assert.throws(() => validateStoppedSnapshot(missingKind), /hold/);
  delete f.header.sourceKind;
  await assert.rejects(exportStoppedTeam(f.source), /hold/);
});

test('saved project context mode survives publication and a cold import catalog read', async (t) => {
  for (const projectContextMode of [undefined, 'shared', 'per_project'] as const) {
    const f = fixture(t);
    if (projectContextMode) f.header.savedSettings.projectContextMode = projectContextMode;
    const snapshot = await exportStoppedTeam(f.source);
    const request = {
      contextId: 'TEST-context',
      sourceId: f.header.sourceId,
      snapshotDigest: snapshot.digest,
      teamName: 'TEST-imported-mode',
    };
    const published = f.importer.import('TEST-import-project-mode', request, snapshot);
    assert.equal(published.phase, 'published');
    const cold = new FileStoppedTeamImport(f.options);
    const records = cold.records('TEST-context');
    assert.equal(records.length, 1);
    assert.equal(records[0]?.projectContextMode, projectContextMode);
    assert.equal(f.attached[0]?.savedSettings?.projectContextMode, projectContextMode);
    assert.deepEqual(cold.records('TEST-context'), records);
    assert.deepEqual(f.importer.records('TEST-context'), records);
  }
});

test('removed import rows reject active identity conflicts and source native authority', async (t) => {
  const f = fixture(t);
  const removed = {
    memberId: 'TEST-retired',
    name: 'retired-worker',
    role: 'member' as const,
    settings: { model: 'TEST-retired-model' },
    removedAt: '2026-10-25T00:00:00.000Z',
  };
  for (const invalid of [
    { ...removed, memberId: f.header.members[0]!.memberId },
    { ...removed, name: f.header.members[0]!.name.toUpperCase() },
    { ...removed, role: 'lead' },
    { ...removed, delivery: { generation: 'TEST-old' } },
    { ...removed, principalId: 'TEST-old-principal' },
    { ...removed, removedAt: 'TEST-not-a-date' },
  ]) {
    f.header.removedMembers = [invalid as typeof removed];
    await assert.rejects(exportStoppedTeam(f.source), /hold/);
    assert.deepEqual(readdirSync(f.destination), []);
  }
});

test('saved-draft layout rejects config presence, symlink config, or missing required metadata', async (t) => {
  const f = fixture(t);
  f.header.sourceKind = 'saved-draft';
  writeFileSync(f.path('team', 'team.meta.json'), JSON.stringify({ version: 1, cwd: '/TEST' }));
  writeFileSync(f.path('team', 'members.meta.json'), JSON.stringify({ version: 1, members: [] }));
  await assert.rejects(exportStoppedTeam(f.source), /hold/);
  rmSync(f.path('team', 'config.json'));
  symlinkSync(f.path('team', 'team.meta.json'), f.path('team', 'config.json'));
  await assert.rejects(exportStoppedTeam(f.source), /hold/);
  rmSync(f.path('team', 'config.json'));
  rmSync(f.path('team', 'members.meta.json'));
  await assert.rejects(exportStoppedTeam(f.source), /hold/);
});

test('complete detached snapshot preserves policy/content/blob/archive census without native credential bytes', async (t) => {
  const f = fixture(t),
    before = readFileSync(f.path('tasks', 'TEST-a.json'));
  const snapshot = await exportStoppedTeam(f.source);
  assert.equal(f.captures(), 2);
  assert.deepEqual(readFileSync(f.path('tasks', 'TEST-a.json')), before);
  assert.equal(snapshot.files.length, 8);
  assert.equal(JSON.stringify(snapshot).includes('TEST-secret-never-copy'), false);
  assert.equal(snapshot.files.find((file) => file.path === 'auth.json')!.disposition, 'excluded');
  assert.equal(snapshot.references.find((ref) => ref.taskId === 'TEST-b')!.target, 'internal');
  assert.equal(
    snapshot.references.find((ref) => ref.taskId === 'TEST-external')!.target,
    'source-archive'
  );
  assert.deepEqual(validateStoppedSnapshot(snapshot), snapshot);
  const request = {
    contextId: 'TEST-context',
    sourceId: f.header.sourceId,
    snapshotDigest: snapshot.digest,
    teamName: 'TEST-imported',
  };
  const result = f.importer.import('TEST-original-import', request, snapshot);
  assert.equal(result.phase, 'published');
  const initialized = JSON.parse(
    readFileSync(join(f.destination, 'teams/TEST-imported/.host-owner/state.json'), 'utf8')
  ) as Record<string, unknown>;
  assert.equal(
    initialized.runtimeNeverLaunched,
    true,
    'proof belongs to the new product-only destination'
  );
  assert.equal(
    initialized.runtimeCaptures,
    undefined,
    'no source Runtime allocation or grants are adopted'
  );
  assert.equal(f.attached.length, 1);
  const task = JSON.parse(
    readFileSync(join(f.destination, 'tasks/TEST-imported/TEST-a.json'), 'utf8')
  ) as Record<string, unknown>;
  assert.equal(task.id, 'TEST-a');
  assert.deepEqual(task.blockedBy, ['TEST-b']);
  assert.equal((task.comments as { text: string }[])[0]!.text, 'Retain comment');
  assert.match(
    (task.comments as { taskRefs: { teamName: string }[] }[])[0]!.taskRefs[0]!.teamName,
    /^legacy-archive:[a-f0-9]{64}$/
  );
  assert.match(task.description as string, /legacy-archive%3A/);
  assert.equal((task.descriptionTaskRefs as { teamName: string }[])[0]!.teamName, 'TEST-imported');
  assert.equal(
    snapshot.files.find((file) => file.path === 'inboxes/user.json')!.disposition,
    'archive'
  );
  assert.equal(
    readFileSync((task.attachments as { filePath: string }[])[0]!.filePath, 'utf8'),
    'TEST-image'
  );
  assert.equal(
    f.origins[0]!.references.find((ref) => ref.taskId === 'TEST-external')!.target,
    'source-archive'
  );
  assert.deepEqual(f.importer.import('TEST-original-import', request, snapshot), result);
  assert.equal(f.importer.records('TEST-context').length, 1);
  const definition = f.attached[0]!,
    owner = createFilesystemTeamOwner({
      root: f.destination,
      binding: definition.binding,
      members: definition.members.map(({ memberId, name, role, settings }) => ({
        memberId,
        name,
        role,
        ...(settings === undefined ? {} : { settings }),
      })),
      savedSettings: definition.savedSettings!,
      grants: definition.grants.map(({ principalId, memberName, permissions }) => ({
        principalId,
        memberName,
        permissions,
      })),
    });
  assert.equal(owner.connect('TEST-human').readRoster().savedSettings!.skipPermissions, false);
  assert.deepEqual(readFileSync(f.path('tasks', 'TEST-a.json')), before);
});

test('canonical Main source artifacts stay censused without transferring ownership or replay state', async (t) => {
  const f = fixture(t);
  const excluded = [
    '.agent-teams-owner.json',
    '.team-runtime-recovery/state.json',
    'cache/transcript-affinity/TEST%2Fworkspace.json',
  ];
  const marker = 'TEST-original-private-owner-runtime-cache';
  for (const path of excluded) {
    mkdirSync(join(f.path('team', path), '..'), { recursive: true });
    writeFileSync(f.path('team', path), JSON.stringify({ original: marker }));
  }
  const journal = 'comment-notification-journal.json.sqlite-fallback-replica';
  const journalBytes = JSON.stringify({
    schemaVersion: 1,
    state: 'clean',
    updatedAt: '2026-11-19T11:37:00.000Z',
    snapshot: { initialized: true, entries: [] },
  });
  writeFileSync(f.path('team', journal), journalBytes);
  const snapshot = await exportStoppedTeam(f.source);
  for (const path of excluded) {
    const file = snapshot.files.find((entry) => entry.category === 'team' && entry.path === path)!;
    assert.equal(file.disposition, 'excluded');
    assert.equal(file.base64, undefined);
    assert.ok(file.size > 0);
    assert.deepEqual(Object.keys(file).sort(), ['category', 'disposition', 'path', 'size']);
  }
  assert.equal(JSON.stringify(snapshot).includes(marker), false);
  const history = snapshot.files.find(
    (entry) => entry.category === 'team' && entry.path === journal
  )!;
  assert.equal(history.disposition, 'archive');
  assert.equal(Buffer.from(history.base64!, 'base64').toString(), journalBytes);
  assert.deepEqual(validateStoppedSnapshot(snapshot), snapshot);
  const result = f.importer.import('TEST-canonical-source-import', requestFor(snapshot), snapshot);
  assert.equal(result.phase, 'published');
  for (const path of [...excluded, journal])
    assert.equal(existsSync(join(f.destination, 'teams/TEST-imported', path)), false);
  assert.equal(
    readFileSync(
      join(f.destination, 'teams/TEST-imported/.host-owner/import/archive/team', journal),
      'utf8'
    ),
    journalBytes
  );
  const state = JSON.parse(
    readFileSync(join(f.destination, 'teams/TEST-imported/.host-owner/state.json'), 'utf8')
  );
  assert.equal(state.runtimeNeverLaunched, true);
  assert.equal(state.runtimeCaptures, undefined);
});

test('canonical Main artifact exceptions keep neighbouring unknown paths refused', async (t) => {
  for (const path of [
    '.agent-teams-owner.json.extra',
    '.team-runtime-recovery/other.json',
    'cache/other.json',
    'cache/transcript-affinity/nested/TEST.json',
    'cache/transcript-affinity/raw space.json',
    'cache/transcript-affinity/%ZZ.json',
    'cache/transcript-affinity/TEST%2fworkspace.json',
    'comment-notification-journal.json.sqlite-fallback-replica.extra',
  ]) {
    const f = fixture(t);
    mkdirSync(join(f.path('team', path), '..'), { recursive: true });
    writeFileSync(f.path('team', path), '{}');
    await assert.rejects(exportStoppedTeam(f.source), { code: 'hold' }, path);
    assert.deepEqual(readdirSync(f.destination), []);
  }
});

test('active/UNKNOWN closure, source changes/corrupt bytes, missing required blob and caps refuse before destination publication', async (t) => {
  for (const condition of [
    'active',
    'corrupt',
    'blob',
    'cap',
    'changed',
    'unknown-file',
    'symlink',
  ] as const) {
    const f = fixture(t);
    if (condition === 'active')
      (f.header.obligations as unknown as Record<string, string>).custody = 'unknown';
    if (condition === 'corrupt') writeFileSync(f.path('tasks', 'TEST-b.json'), '{');
    if (condition === 'blob') rmSync(f.path('attachments', 'TEST-message/TEST-blob--diagram.png'));
    if (condition === 'cap')
      truncateSync(f.path('history', 'TEST-source.jsonl'), STOPPED_IMPORT_LIMITS.fileBytes + 1);
    if (condition === 'unknown-file')
      writeFileSync(f.path('team', 'unsupported-product.dat'), 'TEST');
    if (condition === 'symlink')
      symlinkSync(f.path('tasks', 'TEST-a.json'), f.path('tasks', 'TEST-symlink.json'));
    if (condition === 'changed') {
      let reads = 0;
      f.source.describe = async () => {
        if (++reads === 2) writeFileSync(f.path('tasks', 'TEST-b.json'), '{}');
        return structuredClone(f.header);
      };
    }
    await assert.rejects(exportStoppedTeam(f.source), () => true, condition);
    assert.deepEqual(readdirSync(f.destination), []);
  }
});

test('changed original import conflicts; damaged detached snapshot never publishes a handle', async (t) => {
  const f = fixture(t),
    snapshot = await exportStoppedTeam(f.source);
  const corrupt = structuredClone(snapshot);
  corrupt.files.find((file) => file.category === 'tasks')!.base64 =
    Buffer.from('{}').toString('base64');
  assert.throws(() =>
    f.importer.import(
      'TEST-bad',
      {
        contextId: 'TEST-context',
        sourceId: f.header.sourceId,
        snapshotDigest: snapshot.digest,
        teamName: 'TEST-imported',
      },
      corrupt
    )
  );
  assert.deepEqual(readdirSync(f.destination), []);
  const request = {
    contextId: 'TEST-context',
    sourceId: f.header.sourceId,
    snapshotDigest: snapshot.digest,
    teamName: 'TEST-imported',
  };
  f.importer.import('TEST-id', request, snapshot);
  assert.throws(() =>
    f.importer.import('TEST-id', { ...request, teamName: 'TEST-other' }, snapshot)
  );
  const changed = structuredClone(snapshot);
  changed.header.savedSettings.model = 'TEST-changed';
  const { digest: _digest, ...body } = changed;
  changed.digest = digest(body);
  assert.throws(() =>
    f.importer.import('TEST-id', { ...request, snapshotDigest: changed.digest }, changed)
  );
});

function requestFor(snapshot: Awaited<ReturnType<typeof exportStoppedTeam>>) {
  return {
    contextId: 'TEST-context',
    sourceId: snapshot.header.sourceId,
    snapshotDigest: snapshot.digest,
    teamName: 'TEST-imported',
  };
}

test('cold retry uses only original detached bytes; no source reread or unfinished auto-publication', async (t) => {
  const f = fixture(t),
    snapshot = await exportStoppedTeam(f.source);
  f.faults.attach = true;
  const held = f.importer.import('TEST-retry', requestFor(snapshot), snapshot);
  assert.equal(held.phase, 'held');
  assert.deepEqual(f.importer.records(), []);
  rmSync(f.sourceRoot, { recursive: true });
  const cold = new FileStoppedTeamImport(f.options);
  assert.deepEqual(cold.lookup('TEST-retry', 'TEST-context'), held);
  cold.attachPublished();
  assert.equal(f.attached.length, 0);
  f.faults.attach = false;
  const published = cold.retry('TEST-retry', 'TEST-context')!;
  assert.equal(published.phase, 'published');
  assert.deepEqual(published.record, held.record);
  assert.equal(f.captures(), 2);
  assert.deepEqual(cold.retry('TEST-retry', 'TEST-context'), published);
});

test('changed partial product and missing published owner remain held without overwrite/recreation', async (t) => {
  for (const phase of ['partial', 'published'] as const) {
    const f = fixture(t),
      snapshot = await exportStoppedTeam(f.source);
    f.faults.attach = phase === 'partial';
    f.importer.import('TEST-held', requestFor(snapshot), snapshot);
    const path = join(
      f.destination,
      phase === 'partial'
        ? 'tasks/TEST-imported/TEST-a.json'
        : 'teams/TEST-imported/.host-owner/state.json'
    );
    if (phase === 'partial') writeFileSync(path, 'TEST-foreign-bytes');
    else rmSync(path);
    f.faults.attach = false;
    const cold = new FileStoppedTeamImport(f.options);
    assert.equal(cold.retry('TEST-held', 'TEST-context')!.phase, 'held');
    assert.equal(cold.lookup('TEST-held', 'TEST-context')!.phase, 'held');
    assert.deepEqual(cold.records(), []);
    assert.equal(cold.catalog().held.length, 1);
    if (phase === 'partial') assert.equal(readFileSync(path, 'utf8'), 'TEST-foreign-bytes');
    else assert.throws(() => readFileSync(path), { code: 'ENOENT' });
  }
});

test('detached reference-map tampering, admission collision and capability refusal happen before intent/product writes', async (t) => {
  for (const condition of ['reference', 'collision', 'capability'] as const) {
    const f = fixture(t),
      snapshot = await exportStoppedTeam(f.source);
    if (condition === 'reference') {
      snapshot.references.find((ref) => ref.target === 'source-archive')!.target = 'internal';
      const { digest: _digest, ...body } = snapshot;
      snapshot.digest = digest(body);
    }
    if (condition === 'collision')
      f.options.existingRecords = () => [{ teamName: 'TEST-imported' } as never];
    if (condition === 'capability')
      f.options.validateConfiguration = () => {
        throw new Error('TEST-unsupported');
      };
    assert.throws(() => f.importer.import('TEST-no-intent', requestFor(snapshot), snapshot));
    assert.equal(f.importer.lookup('TEST-no-intent', 'TEST-context'), null);
    assert.deepEqual(f.importer.catalog(), { teams: [], held: [] });
    assert.throws(() => readFileSync(join(f.destination, 'teams/TEST-imported/config.json')), {
      code: 'ENOENT',
    });
  }
});

test('registry reserves published and held imports across contexts without weakening fresh create', async (t) => {
  const f = fixture(t),
    snapshot = await exportStoppedTeam(f.source);
  f.faults.attach = true;
  const imported = f.importer.import('TEST-claim', requestFor(snapshot), snapshot);
  const registry = new TeamRegistry({
    ownerId: 'TEST-host-owner',
    profileId: 'TEST-profile',
    principalId: 'TEST-human',
    contextIds: ['TEST-context', 'TEST-other-context'],
    staticTeams: [],
    store: {
      readAll: () => [],
      write: () => assert.fail('must refuse before creation intent'),
      fenced: (action) => action(),
    },
    assertWriter() {},
    admit() {
      assert.fail('fresh import collision must refuse');
    },
    attach() {
      assert.fail('no attachment');
    },
    additionalCatalog: () => f.importer.catalog(),
  });
  assert.deepEqual(registry.list('TEST-context').held, [
    { commandId: imported.commandId, phase: imported.phase, record: imported.record },
  ]);
  assert.deepEqual(registry.list('TEST-other-context'), { teams: [], held: [] });
  assert.throws(() =>
    registry.create('TEST-collision', {
      contextId: 'TEST-other-context',
      teamName: 'TEST-imported',
      savedSettings: snapshot.header.savedSettings,
      members: [],
    })
  );
});

test('private immutable snapshot transfer and finite original lookup survive loss of staging/source after publication', async (t) => {
  const f = fixture(t),
    snapshot = await exportStoppedTeam(f.source),
    request = requestFor(snapshot);
  const snapshots = new FileStoppedSnapshotResolver({
    ...f.options,
    assertCurrent: f.options.assertWriter,
  });
  assert.deepEqual(snapshots.stage(request, snapshot), {
    sourceId: request.sourceId,
    snapshotDigest: request.snapshotDigest,
  });
  assert.deepEqual(snapshots.read(request), snapshot);
  assert.deepEqual(snapshots.stage(request, snapshot), {
    sourceId: request.sourceId,
    snapshotDigest: request.snapshotDigest,
  });
  assert.throws(() => snapshots.stage({ ...request, path: '/TEST/renderer-path' }, snapshot));
  const routes = stoppedTeamImportRoutes(f.importer, snapshots);
  const result = routes.publish('TEST-finite-import', request);
  assert.equal(result.phase, 'published');
  assert.deepEqual(result.source, {
    sourceId: request.sourceId,
    snapshotDigest: request.snapshotDigest,
  });
  assert.deepEqual(routes.lookup('TEST-finite-import', { contextId: 'TEST-context' }), result);
  rmSync(join(f.destination, '.host-team-registry/snapshots'), { recursive: true });
  rmSync(f.sourceRoot, { recursive: true });
  assert.deepEqual(routes.publish('TEST-finite-import', request), result);
  assert.throws(() =>
    routes.retry('TEST-finite-import', { ...request, sourceId: 'TEST-other-source' })
  );
  assert.equal(routes.lookup('TEST-missing', { contextId: 'TEST-context' }), null);
  const origin = f.importer.readOrigin(result.record.teamId, 'TEST-context')!;
  assert.equal(origin.sourceOwnerId, 'TEST-legacy-owner');
  assert.equal(
    origin.references.find((ref) => ref.taskId === 'TEST-b')!.canonicalTeamName,
    'TEST-imported'
  );
  assert.match(
    origin.references.find((ref) => ref.taskId === 'TEST-external')!.canonicalTeamName,
    /^legacy-archive:[a-f0-9]{64}$/
  );
});

test('staging refuses symlink custody and altered detached map before a product namespace exists', async (t) => {
  const f = fixture(t),
    snapshot = await exportStoppedTeam(f.source),
    request = requestFor(snapshot);
  symlinkSync(f.sourceRoot, join(f.destination, '.host-team-registry'));
  const snapshots = new FileStoppedSnapshotResolver({
    ...f.options,
    assertCurrent: f.options.assertWriter,
  });
  assert.throws(() => snapshots.stage(request, snapshot));
  assert.throws(() => readFileSync(join(f.destination, 'teams/TEST-imported/config.json')), {
    code: 'ENOENT',
  });
  assert.equal(readdirSync(f.sourceRoot).includes('snapshots'), false);
});

test('import publication requires the exact new-owner bootstrap proof and never repairs missing proof on retry', async (t) => {
  const f = fixture(t),
    snapshot = await exportStoppedTeam(f.source);
  const teamName = 'TEST-bootstrap-proof';
  const marker = join(f.destination, 'teams', teamName, '.host-owner/state.json');
  let corrupted = false,
    attached = false;
  const importer = new FileStoppedTeamImport({
    ...f.options,
    assertWriter() {
      if (corrupted || !existsSync(marker)) return;
      const state = JSON.parse(readFileSync(marker, 'utf8')) as Record<string, unknown>;
      if (state.ready !== true) return;
      assert.equal(
        state.runtimeNeverLaunched,
        true,
        'the newly initialized owner carries its own creation proof'
      );
      delete state.runtimeNeverLaunched;
      writeFileSync(marker, JSON.stringify(state));
      corrupted = true;
    },
    attach() {
      attached = true;
    },
  });
  const receipt = importer.import(
    'TEST-bootstrap-proof-command',
    {
      contextId: 'TEST-context',
      sourceId: snapshot.header.sourceId,
      snapshotDigest: snapshot.digest,
      teamName,
    },
    snapshot
  );
  assert.equal(corrupted, true, 'fault lands after owner initialization and before publication');
  assert.equal(receipt.phase, 'held');
  assert.equal(attached, false, 'missing creation proof never publishes or attaches');
  const originalState = readFileSync(marker, 'utf8');
  assert.deepEqual(importer.retry('TEST-bootstrap-proof-command', 'TEST-context'), receipt);
  assert.equal(
    readFileSync(marker, 'utf8'),
    originalState,
    'retry never manufactures the missing proof or resets grants'
  );
});

test('fresh excluded metadata stays private through actual staging, intent and published census', async (t) => {
  const f = fixture(t);
  const secret = readFileSync(f.path('team', 'auth.json'));
  const secretHash = createHash('sha256').update(secret).digest('hex');
  const snapshot = await exportStoppedTeam(f.source);
  const request = requestFor(snapshot);
  const snapshots = new FileStoppedSnapshotResolver({
    ...f.options,
    assertCurrent: f.options.assertWriter,
  });
  snapshots.stage(request, snapshot);
  const staging = join(f.destination, '.host-team-registry/snapshots');
  const names = readdirSync(staging);
  assert.equal(names.length, 1);
  const stagedText = readFileSync(join(staging, names[0]!), 'utf8');
  const staged = JSON.parse(stagedText) as { snapshot: { files: Record<string, unknown>[] } };
  const commandId = 'TEST-excluded-metadata';
  const receipt = f.importer.import(commandId, request, snapshots.read(request));
  assert.equal(receipt.phase, 'published');
  const intentText = readFileSync(
    join(f.destination, '.host-team-registry/imports', digest(commandId) + '.json'),
    'utf8'
  );
  const intent = JSON.parse(intentText) as { snapshot: { files: Record<string, unknown>[] } };
  const censusText = readFileSync(
    join(f.destination, 'teams/TEST-imported/.host-owner/import/source.json'),
    'utf8'
  );
  const census = JSON.parse(censusText) as { census: Record<string, unknown>[] };
  const expected = {
    category: 'team',
    path: 'auth.json',
    size: secret.length,
    disposition: 'excluded',
  };
  for (const [name, text, rows] of [
    ['staging', stagedText, staged.snapshot.files],
    ['intent', intentText, intent.snapshot.files],
    ['published census', censusText, census.census],
  ] as const) {
    // This is the meaningful original-exporter RED: real persisted metadata carried this hash.
    assert.equal(text.includes(secretHash), false, name + ' retained an excluded-content verifier');
    assert.equal(text.includes(secret.toString('utf8')), false, name + ' retained excluded bytes');
    assert.deepEqual(
      rows.find((row) => row.category === 'team' && row.path === 'auth.json'),
      expected
    );
  }
  assert.equal(snapshot.schemaVersion, 2);
  assert.deepEqual(
    snapshot.files.find((row) => row.category === 'team' && row.path === 'auth.json'),
    expected
  );
  assert.equal(existsSync(join(f.destination, 'teams/TEST-imported/auth.json')), false);
  assert.deepEqual(
    new FileStoppedSnapshotResolver({
      ...f.options,
      assertCurrent: f.options.assertWriter,
    }).read(request),
    snapshot
  );
  assert.deepEqual(new FileStoppedTeamImport(f.options).lookup(commandId, 'TEST-context'), receipt);
  assert.deepEqual(readFileSync(f.path('team', 'auth.json')), secret);
});

test('independent equal-size excluded changes do not change fresh transported snapshot identity', async (t) => {
  const f = fixture(t);
  const first = await exportStoppedTeam(f.source);
  const before = readFileSync(f.path('team', 'auth.json'));
  const after = Buffer.from(
    before.toString('utf8').replace('TEST-secret-never-copy', 'TEST-secret-never-copz')
  );
  assert.equal(after.length, before.length);
  assert.notDeepEqual(after, before);
  writeFileSync(f.path('team', 'auth.json'), after);
  const second = await exportStoppedTeam(f.source);
  assert.equal(first.schemaVersion, 2);
  assert.deepEqual(second, first);
  assert.equal(f.captures(), 4);
  assert.deepEqual(readdirSync(f.destination), []);
});

test('equal-size excluded mutation inside the original fenced export remains a refusal', async (t) => {
  const f = fixture(t);
  const before = readFileSync(f.path('team', 'auth.json'));
  const after = Buffer.from(
    before.toString('utf8').replace('TEST-secret-never-copy', 'TEST-secret-never-copz')
  );
  assert.equal(after.length, before.length);
  assert.notDeepEqual(after, before);
  let descriptions = 0;
  f.source.describe = async () => {
    if (++descriptions === 2) writeFileSync(f.path('team', 'auth.json'), after);
    return structuredClone(f.header);
  };
  await assert.rejects(exportStoppedTeam(f.source), { code: 'hold' });
  assert.equal(descriptions, 2);
  assert.deepEqual(readdirSync(f.destination), []);
});

test('strict fresh snapshot metadata rejects alternate verifiers and malformed copied authority', async (t) => {
  const f = fixture(t);
  const snapshot = await exportStoppedTeam(f.source);
  assert.equal(snapshot.schemaVersion, 2);
  const secret = readFileSync(f.path('team', 'auth.json'));
  const secretHash = createHash('sha256').update(secret).digest('hex');
  const snapshots = new FileStoppedSnapshotResolver({
    ...f.options,
    assertCurrent: f.options.assertWriter,
  });
  type Row = Record<string, unknown>;
  type Mutation = { name: string; change(raw: Row, excluded: Row, copied: Row): void };
  const cases: Mutation[] = [
    {
      name: 'real excluded verifier',
      change(_raw, file) {
        file.sha256 = secretHash;
      },
    },
    {
      name: 'synthetic excluded verifier',
      change(_raw, file) {
        file.sha256 = '0'.repeat(64);
      },
    },
    {
      name: 'own undefined verifier',
      change(_raw, file) {
        file.sha256 = undefined;
      },
    },
    {
      name: 'excluded bytes',
      change(_raw, file) {
        file.base64 = secret.toString('base64');
      },
    },
    {
      name: 'alternate excluded verifier',
      change(_raw, file) {
        file.checksum = secretHash;
      },
    },
    {
      name: 'root verifier',
      change(raw) {
        raw.checksum = secretHash;
      },
    },
    {
      name: 'root-row verifier',
      change(raw) {
        (raw.roots as Row[])[0]!.checksum = secretHash;
      },
    },
    {
      name: 'blob-row verifier',
      change(raw) {
        (raw.blobs as Row[])[0]!.checksum = secretHash;
      },
    },
    {
      name: 'reference-row verifier',
      change(raw) {
        (raw.references as Row[])[0]!.checksum = secretHash;
      },
    },
    {
      name: 'copied-row verifier',
      change(_raw, _file, copied) {
        copied.checksum = secretHash;
      },
    },
    {
      name: 'missing copied checksum',
      change(_raw, _file, copied) {
        delete copied.sha256;
      },
    },
    {
      name: 'missing copied bytes',
      change(_raw, _file, copied) {
        delete copied.base64;
      },
    },
    {
      name: 'changed copied bytes',
      change(_raw, _file, copied) {
        copied.base64 = Buffer.from('TEST-corrupt').toString('base64');
      },
    },
    {
      name: 'unknown version',
      change(raw) {
        raw.schemaVersion = 99;
      },
    },
    {
      name: 'V2 rows relabelled V1',
      change(raw) {
        raw.schemaVersion = 1;
      },
    },
    {
      name: 'excluded file relabelled archive',
      change(_raw, file) {
        file.disposition = 'archive';
        file.sha256 = secretHash;
        file.base64 = secret.toString('base64');
      },
    },
  ];
  for (const [index, mutation] of cases.entries()) {
    const raw = structuredClone(snapshot) as unknown as Row;
    const files = raw.files as Row[];
    const excluded = files.find((file) => file.category === 'team' && file.path === 'auth.json')!;
    const copied = files.find((file) => file.disposition !== 'excluded')!;
    mutation.change(raw, excluded, copied);
    const { digest: _previous, ...body } = raw;
    raw.digest = digest(body);
    const changed = raw as unknown as Awaited<ReturnType<typeof exportStoppedTeam>>;
    const request = requestFor(changed);
    assert.throws(() => validateStoppedSnapshot(changed), { code: 'hold' }, mutation.name);
    assert.throws(() => snapshots.stage(request, changed), { code: 'hold' }, mutation.name);
    assert.throws(
      () => f.importer.import('TEST-strict-v2-' + index, request, changed),
      { code: 'hold' },
      mutation.name
    );
    assert.deepEqual(readdirSync(f.destination), [], mutation.name);
  }
});

test('V2 root identity rejects a digest-valid array before staging or import', async (t) => {
  const f = fixture(t);
  const snapshot = await exportStoppedTeam(f.source);
  assert.equal(snapshot.schemaVersion, 2);
  const raw = structuredClone(snapshot) as unknown as Record<string, unknown>;
  const roots = raw.roots as Record<string, unknown>[];
  assert.equal(typeof roots[0]!.identity, 'string');
  roots[0]!.identity = [roots[0]!.identity];
  const { digest: _previous, ...body } = raw;
  raw.digest = digest(body);
  const malformed = raw as unknown as typeof snapshot;
  const request = requestFor(malformed);
  const snapshots = new FileStoppedSnapshotResolver({
    ...f.options,
    assertCurrent: f.options.assertWriter,
  });
  assert.throws(() => validateStoppedSnapshot(malformed), { code: 'hold' });
  assert.throws(() => snapshots.stage(request, malformed), { code: 'hold' });
  assert.throws(() => f.importer.import('TEST-v2-array-root-identity', request, malformed), {
    code: 'hold',
  });
  assert.deepEqual(readdirSync(f.destination), []);
});

// Genuine V1 capture: pristine 617b15d65e3d1e40d94ee3470eb5fc8399836b68, Node 24.21.0.
// Original source removed before capture output; exact exported JSON SHA256 3a85867873246991dd7de7c4f63edb3e81730c4682643626c3d77dac2d4ed106.
const stoppedSnapshotV1Original = {
  json: '{"schemaVersion":1,"header":{"sourceOwnerId":"TEST-legacy-owner","sourceId":"TEST-source","sourceTeamName":"TEST-old-team","sourceRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","savedSettings":{"cwd":"/TEST/workspace","model":"TEST-model","fastMode":"off","syncModelsWithLead":false,"skipPermissions":false},"members":[{"memberId":"TEST-lead","name":"captain","role":"lead","settings":{"model":"TEST-model"}}],"obligations":{"launch":"released","bootstrap":"released","lane":"released","session":"released","stop":"released","command":"released","delivery":"released","custody":"released","background":"released"},"gaps":[]},"roots":[{"category":"team","exists":true,"identity":"94cab3a835dc52b2aa37a1df07e4fc70ff7eac7442925ce3578d1b48c27a2590"},{"category":"tasks","exists":true,"identity":"1f2b5999658c30fe3e13632b8fd303c4f39e4fbe2e843248a2d822a580e53a66"},{"category":"attachments","exists":true,"identity":"5239151f5a5dc6175d3eab2b2654415bb9652a9e5a18252d11b9da5bbbe0da1b"},{"category":"task-attachments","exists":true,"identity":"cc0753e7269f37d02ffd275612d5c78d8397a0deb07fba7169b08cb4a31cf51f"},{"category":"history","exists":true,"identity":"02576b3dae3cf2763f0dbf83ec0bc99e8b8f8a26a1a24fb3d7ecca65b9bd35dc"},{"category":"evidence","exists":true,"identity":"cabcfa005fa7fb80984881a70007520e3852596fba011effd40da705e70c2adb"}],"files":[{"category":"team","path":"auth.json","sha256":"be05e9cbeac1442d74f4b5636b4853a9de1894de365faa6ea2aeca0f2989b1c7","size":43,"disposition":"excluded"},{"category":"team","path":"config.json","sha256":"9d4634d511bbe33666e23ee91a29ff68b04518d49b359497ba5cd67f6589f301","size":55,"disposition":"archive","base64":"eyJuYW1lIjoiVEVTVC1vbGQtdGVhbSIsIm1lbWJlcnMiOlt7Im5hbWUiOiJjYXB0YWluIn1dfQ=="}],"references":[],"blobs":[],"digest":"b79259ede0bf4b3283498e02b959119fb1b6015e4597f6b7f439a4688f9e679f"}',
  digest: 'b79259ede0bf4b3283498e02b959119fb1b6015e4597f6b7f439a4688f9e679f',
} as const;

function assertRetainedStoppedV1Compatibility(
  t: TestContext,
  original: Readonly<{ json: string; digest: string }>
): void {
  const parsed = JSON.parse(original.json) as Parameters<typeof validateStoppedSnapshot>[0];
  assert.equal(parsed.schemaVersion, 1);
  const snapshot = validateStoppedSnapshot(parsed);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.digest, original.digest);
  assert.equal(JSON.stringify(snapshot), original.json);
  assert.deepEqual(
    snapshot.roots.map((root) => root.category),
    importCategories
  );
  assert.ok(snapshot.roots.every((root) => root.exists));
  assert.deepEqual(
    snapshot.files.map((file) => file.category + '/' + file.path),
    ['team/auth.json', 'team/config.json']
  );
  assert.deepEqual(snapshot.blobs, []);
  assert.deepEqual(snapshot.references, []);
  const excluded = snapshot.files[0]!;
  assert.equal(excluded.disposition, 'excluded');
  assert.match(excluded.sha256!, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(excluded, 'base64'), false);
  const originalConfig = Buffer.from(snapshot.files[1]!.base64!, 'base64');
  assert.equal(
    originalConfig.toString('utf8'),
    '{"name":"TEST-old-team","members":[{"name":"captain"}]}'
  );

  // Existing fixture supplies destination authority and an actual attach fault.
  // Its source is a decoy: no export/describe is allowed in this compatibility test.
  // The real baseline source was already removed by the capture script.
  const f = fixture(t);
  const request = requestFor(snapshot);
  const commandId = 'TEST-retained-v1-original-import';
  const authority = { ...f.options, assertCurrent: f.options.assertWriter };
  const staged = new FileStoppedSnapshotResolver(authority);
  const sourceIdentity = {
    sourceId: request.sourceId,
    snapshotDigest: original.digest,
  };
  assert.deepEqual(staged.stage(request, snapshot), sourceIdentity);
  const stagingDirectory = join(f.destination, '.host-team-registry', 'snapshots');
  const key = {
    ownerId: f.options.ownerId,
    profileId: f.options.profileId,
    principalId: f.options.principalId,
    contextId: request.contextId,
    sourceId: request.sourceId,
    snapshotDigest: request.snapshotDigest,
  };
  const stagePath = join(stagingDirectory, digest(key) + '.json');
  const stageBytes = readFileSync(stagePath);
  assert.deepEqual(stageBytes, Buffer.from(JSON.stringify({ key, snapshot })));
  const coldStaged = new FileStoppedSnapshotResolver(authority);
  assert.equal(JSON.stringify(coldStaged.read(request)), original.json);
  assert.deepEqual(coldStaged.stage(request, snapshot), sourceIdentity);
  assert.deepEqual(readFileSync(stagePath), stageBytes);

  f.faults.attach = true;
  const initialRoutes = stoppedTeamImportRoutes(f.importer, coldStaged);
  const held = initialRoutes.publish(commandId, request);
  assert.equal(held.phase, 'held');
  assert.equal(held.commandId, commandId);
  assert.deepEqual(held.source, sourceIdentity);
  assert.deepEqual(f.importer.records(), []);
  assert.equal(f.attached.length, 0);
  const intentPath = join(
    f.destination,
    '.host-team-registry',
    'imports',
    digest(commandId) + '.json'
  );
  const readIntent = (): Record<string, unknown> => {
    const value: unknown = JSON.parse(readFileSync(intentPath, 'utf8'));
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    return value as Record<string, unknown>;
  };
  const heldIntentBytes = readFileSync(intentPath);
  const heldIntent = readIntent();
  assert.equal(heldIntent.schemaVersion, 1);
  // Proves this is the deliberate real attach failure after installation,
  // rather than an unrelated earlier failure that happened to return held.
  assert.equal(heldIntent.phase, 'installed');
  assert.equal(heldIntent.commandId, commandId);
  assert.equal(JSON.stringify(heldIntent.snapshot), original.json);
  assert.deepEqual(heldIntent.request, request);
  assert.deepEqual(heldIntent.record, held.record);
  assert.match(String(heldIntent.fingerprint), /^[a-f0-9]{64}$/);

  const censusPath = join(
    f.destination,
    'teams',
    request.teamName,
    '.host-owner',
    'import',
    'source.json'
  );
  const censusBytes = readFileSync(censusPath);
  const census = JSON.parse(censusBytes.toString('utf8')) as {
    schemaVersion: unknown;
    snapshotDigest: unknown;
    census: unknown;
  };
  assert.equal(census.schemaVersion, 1);
  assert.equal(census.snapshotDigest, original.digest);
  assert.deepEqual(
    census.census,
    snapshot.files.map(({ base64: _base64, ...file }) => file)
  );
  const archiveConfigPath = join(
    f.destination,
    'teams',
    request.teamName,
    '.host-owner',
    'import',
    'archive',
    'team',
    'config.json'
  );
  assert.deepEqual(readFileSync(archiveConfigPath), originalConfig);
  assert.equal(existsSync(join(f.destination, 'teams', request.teamName, 'auth.json')), false);
  assert.equal(
    existsSync(
      join(
        f.destination,
        'teams',
        request.teamName,
        '.host-owner',
        'import',
        'archive',
        'team',
        'auth.json'
      )
    ),
    false
  );

  rmSync(stagingDirectory, { recursive: true });
  rmSync(f.sourceRoot, { recursive: true });
  const cold = new FileStoppedTeamImport(f.options);
  const missingStage = new FileStoppedSnapshotResolver(authority);
  assert.throws(() => missingStage.read(request), { code: 'hold' });
  const coldRoutes = stoppedTeamImportRoutes(cold, missingStage);
  assert.deepEqual(cold.lookup(commandId, request.contextId), held);
  assert.deepEqual(coldRoutes.lookup(commandId, { contextId: request.contextId }), held);
  assert.deepEqual(coldRoutes.lookup(commandId, request), held);
  cold.attachPublished();
  assert.equal(f.attached.length, 0);
  assert.deepEqual(readFileSync(intentPath), heldIntentBytes);
  assert.deepEqual(readFileSync(censusPath), censusBytes);

  f.faults.attach = false;
  const published = coldRoutes.retry(commandId, request);
  assert.deepEqual(published, { ...held, phase: 'published' });
  assert.equal(f.attached.length, 1);
  const publishedIntent = readIntent();
  assert.equal(JSON.stringify(publishedIntent.snapshot), original.json);
  assert.deepEqual(publishedIntent, { ...heldIntent, phase: 'published' });
  assert.deepEqual(readFileSync(censusPath), censusBytes);
  assert.deepEqual(readFileSync(archiveConfigPath), originalConfig);
  assert.equal(
    cold.readOrigin(held.record.teamId, request.contextId)!.snapshotDigest,
    original.digest
  );

  const publishedIntentBytes = readFileSync(intentPath);
  const reopened = new FileStoppedTeamImport(f.options);
  const originalRoutes = stoppedTeamImportRoutes(
    reopened,
    new FileStoppedSnapshotResolver(authority)
  );
  assert.deepEqual(originalRoutes.lookup(commandId, request), published);
  assert.deepEqual(originalRoutes.publish(commandId, request), published);
  assert.deepEqual(originalRoutes.retry(commandId, request), published);
  assert.throws(
    () =>
      originalRoutes.publish(commandId, {
        ...request,
        teamName: 'TEST-changed-v1-import',
      }),
    { code: 'conflict' }
  );
  assert.deepEqual(readFileSync(intentPath), publishedIntentBytes);
  assert.deepEqual(readFileSync(censusPath), censusBytes);
  assert.equal(JSON.stringify(readIntent().snapshot), original.json);
  assert.equal(existsSync(stagingDirectory), false);
  assert.equal(existsSync(f.sourceRoot), false);
  assert.equal(existsSync(join(f.destination, 'teams', 'TEST-changed-v1-import')), false);
  assert.equal(f.captures(), 0);
}

test('retained V1 bytes survive stage/cold held retry without source or staging', (t) => {
  assertRetainedStoppedV1Compatibility(t, stoppedSnapshotV1Original);
});
