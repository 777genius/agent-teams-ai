import assert from 'node:assert/strict';
import {
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
