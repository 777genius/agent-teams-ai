import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileStoppedTeamImport } from '../dist/stopped-team-import/FileStoppedTeamImport.js';
import { exportStoppedTeam } from '../dist/stopped-team-import/snapshot.js';
import { importCategories } from '../dist/stopped-team-import/contracts.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import type { SnapshotHeader } from '../dist/stopped-team-import/contracts.js';
async function fixture(t: import('node:test').TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-import-publication-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), destination = join(root, 'destination');
  mkdirSync(source); mkdirSync(destination);
  const roots = importCategories.map(category => { const path = join(source, category); mkdirSync(path); return { category, path }; });
  writeFileSync(join(source, 'team/config.json'), JSON.stringify({ name: 'TEST-old', members: [{ name: 'captain' }] }));
  writeFileSync(join(source, 'history/history.json'), JSON.stringify({ text: 'immutable historical body' }));
  const header: SnapshotHeader = { sourceOwnerId: 'TEST-legacy', sourceId: 'TEST-source', sourceTeamName: 'TEST-old', sourceRevision: 'a'.repeat(64),
    savedSettings: { cwd: '/TEST/project', model: 'TEST-model', skipPermissions: false, syncModelsWithLead: false, fastMode: 'off' },
    members: [{ memberId: 'TEST-lead', name: 'captain', role: 'lead', settings: { model: 'TEST-model' } }], gaps: [],
    obligations: { launch: 'released', bootstrap: 'released', lane: 'released', session: 'released', stop: 'released', command: 'released', delivery: 'released', custody: 'released', background: 'released' } };
  const snapshot = await exportStoppedTeam({ roots, fenced: operation => operation(), describe: async () => header });
  let writer = true, ingress = true;
  const importer = new FileStoppedTeamImport({ root: destination, ownerId: 'TEST-owner', profileId: 'TEST-profile', principalId: 'TEST-human', contextIds: ['TEST-context'],
    assertWriter() { if (!writer || !ingress) throw new Error('TEST revoked'); }, assertLifecycleWriter() { if (!writer) throw new Error('TEST revoked'); }, existingRecords: () => [], validateConfiguration() {}, bindOrigin() {}, attach() {} });
  const receipt = importer.import('TEST-import', { contextId: 'TEST-context', teamName: 'TEST-new', sourceId: snapshot.header.sourceId, snapshotDigest: snapshot.digest }, snapshot);
  assert.equal(receipt.phase, 'published');
  const store = new TeamOwnerStore(destination, receipt.record.teamName);
  const publication = importer.publication(receipt.record.teamId, operation => store.fenced(operation))!;
  return { destination, importer, publication, store, seal: () => { ingress = false; }, revoke: () => { writer = false; } };
}
test('actual published import archives only original immutable census and restores missing bytes without restoring owner grants', async t => {
  const f = await fixture(t), archive = f.publication.capture(), state = f.store.read('state.json');
  assert.ok(archive.files.every(file => file.path.startsWith('teams/TEST-new/.host-owner/import/')));
  const file = archive.files.find(file => file.path.includes('/archive/history/'))!;
  unlinkSync(join(f.destination, file.path));
  assert.deepEqual(f.publication.restoreMissing(archive), { restored: 1 });
  assert.equal(readFileSync(join(f.destination, file.path), 'base64'), file.base64);
  assert.deepEqual(f.store.read('state.json'), state);
  const forged = structuredClone(archive); forged.commandId = 'TEST-other-import';
  assert.throws(() => f.publication.restoreMissing(forged));
  f.revoke();
  assert.throws(() => f.publication.restoreMissing(archive), /revoked/);
});
test('replacement/corruption never grants overwrite or removal scope', async t => {
  const f = await fixture(t), archive = f.publication.capture(), file = archive.files[0]!;
  writeFileSync(join(f.destination, file.path), 'TEST-replacement-bytes');
  assert.throws(() => f.publication.capture());
  assert.throws(() => f.publication.restoreMissing(archive));
  assert.equal(readFileSync(join(f.destination, file.path), 'utf8'), 'TEST-replacement-bytes');
});

test('sealed importer exposes only retained original publication maintenance under its still-current lease', async t => {
  const f = await fixture(t), archive = f.publication.capture();
  f.seal();
  assert.throws(() => f.importer.records(), /revoked/);
  assert.throws(() => f.importer.readOrigin(archive.binding.teamId, 'TEST-context'), /revoked/);
  const retained = f.importer.publication(archive.binding.teamId, operation => f.store.fenced(operation))!;
  const file = archive.files[0]!;
  unlinkSync(join(f.destination, file.path));
  assert.deepEqual(retained.restoreMissing(archive), { restored: 1 });
  assert.deepEqual(retained.capture(), archive);
  f.revoke();
  assert.throws(() => retained.capture(), /revoked/);
});
