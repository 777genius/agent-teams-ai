import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import { prepareDesktopProofFixture } from './desktop-proof-fixture.ts';
import { assertStoppedImportModelChecks } from './desktop-stopped-import-ui-smoke.ts';
import {
  readDesktopStoppedImportSeed,
  stoppedImportSourceBytes,
} from './desktop-stopped-import-fixture.ts';

const pnpmEntry = '/opt/homebrew/Cellar/node@24/24.18.0/lib/node_modules/corepack/dist/pnpm.js';
const repo = resolve(import.meta.dirname, '../..');
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
test('stopped import UI fixture stages only never-launched legacy product data with exact opt-in principal', async (t) => {
  const fixture = await prepareDesktopBackendFixture(repo, {
    seedUiTask: true,
    creation: true,
    stoppedImportUi: true,
    pnpmEntry,
  });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const seed = await readDesktopStoppedImportSeed(fixture.root);
  const descriptor = await json(fixture.descriptorPath);
  const profile = await json(fixture.profilePath);
  assert.equal(descriptor.creation.importAuthority.principalId, profile.principalId);
  assert.equal(descriptor.creation.importAuthority.principalId, 'TEST-human');
  assert.deepEqual(descriptor.creation.contextIds, ['local']);
  assert.equal(profile.runtime, undefined);
  assert.equal(profile.management, undefined);
  assert.deepEqual(await stoppedImportSourceBytes(fixture.root, seed.roots), seed.before);
  await assert.rejects(readFile(join(seed.roots[0]!, 'config.json')), { code: 'ENOENT' });
  const metadata = await json(join(seed.roots[0]!, 'team.meta.json'));
  const roster = await json(join(seed.roots[0]!, 'members.meta.json'));
  assert.equal(
    seed.sourceCardLabel,
    metadata.displayName,
    'actual metadata-only draft list uses the saved display name'
  );
  assert.equal(metadata.displayName, seed.displayName);
  assert.deepEqual(
    roster.members.map((member: { name: string }) => member.name),
    ['alice'],
    'createTeamConfig stores only non-lead members; import derives its product lead from saved metadata'
  );
  for (const field of [
    'leadSessionId',
    'sessionId',
    'agentId',
    'runtimeSessionId',
    'pid',
    'runtimePid',
  ]) {
    assert.equal(metadata[field], undefined);
    assert.ok(
      roster.members.every((member: Record<string, unknown>) => member[field] === undefined)
    );
  }
  assert.ok(
    !seed.before.some((file) => /\/(?:launch-|bootstrap-|stop-|runtime-|opencode-)/.test(file.path))
  );
  for (const [key, value] of Object.entries(seed.savedSettings)) assert.equal(metadata[key], value);
  const task = await json(join(seed.roots[1]!, seed.taskId + '.json'));
  assert.equal(task.comments[0].type, 'regular');
  assert.equal(task.comments[0].id, 'TEST-legacy-comment');
  assert.equal(task.descriptionTaskRefs[0].taskId, seed.linkedTaskId);
  assert.equal(task.descriptionTaskRefs[0].teamName, seed.teamName);
  assert.equal(task.descriptionTaskRefs[1].teamName, 'test-desktop-backend');
  assert.equal(task.descriptionTaskRefs[2].taskId, seed.missingTaskId);
  assert.equal(task.attachments[0].filePath, seed.blobPath);
  assert.equal(await readFile(seed.blobPath, 'utf8'), 'TEST original task attachment bytes\n');
});

test('normal creation fixtures keep stopped legacy import authority disabled', async (t) => {
  const fixture = await prepareDesktopBackendFixture(repo, { creation: true, pnpmEntry });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const descriptor = await json(fixture.descriptorPath);
  assert.equal(descriptor.creation.importAuthority, undefined);
  await assert.rejects(readFile(join(fixture.root, 'stopped-import-ui-seed.json')));
});

test('extracted ordinary Team UI composition retains its offline no-creation fixture', async (t) => {
  const fixture = await prepareDesktopProofFixture(repo, 'team-ui', pnpmEntry, {
    readbackMode: false,
    reviewReadbackMode: false,
    reviewUiMode: false,
    legacyImportMode: false,
    uiMode: true,
    launchDialogMode: false,
    createConfigMode: false,
    nativeStopMode: false,
  });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  assert.ok(fixture.uiSeed);
  const descriptor = await json(fixture.descriptorPath);
  const profile = await json(fixture.profilePath);
  assert.equal(descriptor.creation, undefined);
  assert.equal(profile.runtime, undefined);
  assert.equal(profile.management, undefined);
  await assert.rejects(readFile(join(fixture.root, 'stopped-import-ui-seed.json')));
});

test('import UI model proof permits finite exact preflight receipts while refusing Team inputs', () => {
  const selected = { model: 'claude-sonnet-4-6', effort: 'low' };
  const receipt = {
    commandId: 'TEST-probe-1',
    kind: 'model.probe',
    modelId: selected.model,
    effort: selected.effort,
    phase: 'completed',
    ok: true,
    resourceHeld: false,
  };
  const model = {
    probes: [{ requestedModel: selected.model, requestedEffort: selected.effort }],
    observations: [],
    failures: [],
    unexpectedNoToolsRequests: [],
  };
  assert.doesNotThrow(() => assertStoppedImportModelChecks([receipt], model, selected));
  assert.doesNotThrow(() =>
    assertStoppedImportModelChecks(
      [receipt, { ...receipt, commandId: 'TEST-probe-2' }],
      { ...model, probes: [...model.probes, ...model.probes] },
      selected
    )
  );
  for (const invalid of [
    [],
    [{ ...receipt, modelId: 'claude-opus-4-6' }],
    [{ ...receipt, effort: 'medium' }],
    [{ ...receipt, phase: 'cancelled', ok: false }],
    [{ ...receipt, resourceHeld: true }],
    [receipt, receipt],
    Array.from({ length: 9 }, (_, i) => ({ ...receipt, commandId: String(i) })),
  ])
    assert.throws(() => assertStoppedImportModelChecks(invalid, model, selected));
  assert.throws(() =>
    assertStoppedImportModelChecks([receipt], { ...model, probes: [] }, selected)
  );
  assert.throws(() =>
    assertStoppedImportModelChecks(
      [receipt],
      {
        ...model,
        probes: [{ requestedModel: selected.model, requestedEffort: 'medium' }],
      },
      selected
    )
  );
  assert.throws(() =>
    assertStoppedImportModelChecks(
      [receipt],
      {
        ...model,
        failures: ['TEST unexpected Team request'],
      },
      selected
    )
  );
  assert.throws(() =>
    assertStoppedImportModelChecks(
      [receipt],
      {
        ...model,
        observations: [
          {
            turn: 'TEST agent input',
            step: 0,
            contextEffective: false,
            priorTurn: false,
            tools: [],
            toolResultError: false,
            visibleReplyContract: false,
          },
        ],
      },
      selected
    )
  );
  assert.throws(() =>
    assertStoppedImportModelChecks(
      [receipt],
      {
        ...model,
        unexpectedNoToolsRequests: [{ roles: ['user'], userContent: [] }],
      },
      selected
    )
  );
});
