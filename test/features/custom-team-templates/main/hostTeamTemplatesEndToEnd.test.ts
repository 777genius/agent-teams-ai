// @vitest-environment node
import { join } from 'node:path';

import { CustomTeamTemplateStorageInterruptedError } from '@features/custom-team-templates/core/application/CustomTeamTemplateStorageInterruptedError';
import { createCustomTeamTemplatesFeature } from '@features/custom-team-templates/main';
import { OwnerRoutedTeamConfigurationSnapshotAdapter } from '@features/custom-team-templates/main/adapters/output/OwnerRoutedTeamConfigurationSnapshotAdapter';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import Database from 'better-sqlite3-node';
import { afterEach, expect, it, vi } from 'vitest';

import { capturedHostTeamReadsFixture } from '../../agent-backend/fixtures/capturedHostTeamReadsFixture';

import type { CustomTeamTemplateStorageGateway } from '@features/custom-team-templates/contracts';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(close => close()));
function fixture() {
  const f = capturedHostTeamReadsFixture();
  cleanup.push(f.dispose);
  const core = new InternalStorageWorkerCore({ databasePath: join(f.root, 'TEST-templates.sqlite'),
    createDatabase: file => new Database(file) });
  cleanup.push(() => core.close());
  const gateway: CustomTeamTemplateStorageGateway = {
    customTeamTemplateCreate: async request => core.handle('customTemplate.create', request) as
      Awaited<ReturnType<CustomTeamTemplateStorageGateway['customTeamTemplateCreate']>>,
    customTeamTemplateList: async () => core.handle('customTemplate.list', {}) as
      Awaited<ReturnType<CustomTeamTemplateStorageGateway['customTeamTemplateList']>>,
    customTeamTemplateGetById: async request => core.handle('customTemplate.getById', request) as
      Awaited<ReturnType<CustomTeamTemplateStorageGateway['customTeamTemplateGetById']>>,
    customTeamTemplateUpdate: async request => core.handle('customTemplate.update', request) as
      Awaited<ReturnType<CustomTeamTemplateStorageGateway['customTeamTemplateUpdate']>>,
    customTeamTemplateDelete: async request => core.handle('customTemplate.delete', request) as
      Awaited<ReturnType<CustomTeamTemplateStorageGateway['customTeamTemplateDelete']>>,
  };
  const legacy = { readSnapshot: vi.fn(async (sourceTeamName: string) => ({
    status: 'sourceUnavailable' as const, sourceTeamName })) };
  const reader = new OwnerRoutedTeamConfigurationSnapshotAdapter(f.capture, legacy);
  const feature = createCustomTeamTemplatesFeature({ backend: { gateway }, snapshotReader: reader });
  cleanup.push(() => feature.dispose());
  return { f, reader, legacy, feature, gateway };
}

it('previews a logical Host definition from a child, saves to SQLite and round-trips the portable template', async () => {
  const { f, feature, legacy } = fixture();
  const logical = f.addTeam({ name: 'logical', projectContextMode: 'per_project' });
  const child = f.addTeam({ name: 'child', savedSettings: { cwd: join(f.root, 'TEST-child'),
    prompt: 'TEST child-only prompt', skipPermissions: true }, projectContext: {
    logicalHandleId: logical.connection.handle.handleId,
    projectPath: join(f.root, 'TEST-child'), workContextId: 'TEST-child-context' } });
  const prepared = await feature.preparePreview.execute({ sourceTeamName: child.key, name: 'TEST portable' });
  expect(prepared.status).toBe('previewReady');
  if (prepared.status !== 'previewReady') throw new Error('Expected original preview');
  expect(prepared.preview.teamPrompt).toBe('TEST saved prompt');
  expect(prepared.preview.members).toEqual([{ name: 'alice', role: 'Reviewer', workflow: 'Review the TEST change.' }]);
  const saved = await feature.saveTemplate.execute({ previewToken: prepared.preview.previewToken });
  expect(saved.status).toBe('created');
  if (saved.status !== 'created') throw new Error('Expected durable save');
  await expect(feature.saveTemplate.execute({ previewToken: prepared.preview.previewToken }))
    .resolves.toEqual({ status: 'alreadySaved', template: saved.template });
  const exported = await feature.exportTemplate.execute({ templateId: saved.template.templateId });
  expect(exported.status).toBe('exported');
  if (exported.status !== 'exported') throw new Error('Expected portable export');
  expect(Object.keys(exported.portable).sort()).toEqual(['format', 'members', 'name', 'schemaVersion', 'teamPrompt']);
  expect(JSON.stringify(exported.portable)).not.toMatch(/TEST-child|skipPermissions|ownerResourceRef|handleId|session/);
  const imported = await feature.importTemplate.execute({ portable: exported.portable, name: 'TEST imported' });
  expect(imported.status).toBe('imported');
  expect((await feature.listTemplates.execute()).status).toBe('ready');
  expect(legacy.readSnapshot).not.toHaveBeenCalled();
  expect(f.router.request.mock.calls.every(([, r]) =>
    r.method === 'team.roster.read' || r.method === 'team.lifecycle.read')).toBe(true);
});

it('blocks a save after the reviewed definition changes and leaves the SQLite library empty', async () => {
  const { f, feature, gateway } = fixture(), team = f.addTeam();
  const prepared = await feature.preparePreview.execute({ sourceTeamName: team.key, name: 'TEST reviewed' });
  expect(prepared.status).toBe('previewReady');
  if (prepared.status !== 'previewReady') throw new Error('Expected preview');
  const roster = team.human.readRoster();
  team.human.replaceRoster({ commandId: 'TEST-template-edit', expectedRevision: roster.revision,
    members: [{ name: 'alice', role: 'Changed after preview' }], savedSettings: roster.savedSettings });
  await expect(feature.saveTemplate.execute({ previewToken: prepared.preview.previewToken }))
    .resolves.toEqual({ status: 'stalePreview', sourceTeamName: team.key });
  expect((await gateway.customTeamTemplateList()).templates).toHaveLength(0);
});

it('fails closed for a revoked Host context and preserves the ordinary legacy route', async () => {
  const { f, reader, legacy } = fixture(), team = f.addTeam();
  f.afterRead(() => f.revokeContext());
  await expect(reader.readSnapshot(team.key)).resolves.toEqual({
    status: 'sourceUnavailable', sourceTeamName: team.key });
  expect(legacy.readSnapshot).not.toHaveBeenCalled();
  await reader.readSnapshot('test-legacy');
  expect(legacy.readSnapshot).toHaveBeenCalledExactlyOnceWith('test-legacy');
});

it('refuses to issue a preview when its captured Host context changes during the SQLite name lookup', async () => {
  const { f, feature, gateway } = fixture(), team = f.addTeam();
  const list = gateway.customTeamTemplateList.bind(gateway);
  vi.spyOn(gateway, 'customTeamTemplateList').mockImplementationOnce(async () => {
    const value = await list();
    f.revokeContext();
    return value;
  });
  await expect(feature.preparePreview.execute({ sourceTeamName: team.key, name: 'TEST revoked preview' }))
    .resolves.toEqual({ status: 'sourceUnavailable', sourceTeamName: team.key });
  expect((await list()).templates).toHaveLength(0);
});

it('refuses the original save before SQLite create if the context is revoked during its id lookup', async () => {
  const { f, feature, gateway } = fixture(), team = f.addTeam();
  const prepared = await feature.preparePreview.execute({ sourceTeamName: team.key, name: 'TEST save fence' });
  if (prepared.status !== 'previewReady') throw new Error('Expected original preview');
  const get = gateway.customTeamTemplateGetById.bind(gateway);
  vi.spyOn(gateway, 'customTeamTemplateGetById').mockImplementationOnce(async request => {
    const value = await get(request);
    f.revokeContext();
    return value;
  });
  const create = vi.spyOn(gateway, 'customTeamTemplateCreate');
  await expect(feature.saveTemplate.execute({ previewToken: prepared.preview.previewToken }))
    .resolves.toEqual({ status: 'sourceUnavailable', sourceTeamName: team.key });
  expect(create).not.toHaveBeenCalled();
  expect((await gateway.customTeamTemplateList()).templates).toHaveLength(0);
});

it('refuses a save when its original Host source is trashed during the SQLite id lookup', async () => {
  const { f, feature, gateway } = fixture(), team = f.addTeam();
  const prepared = await feature.preparePreview.execute({ sourceTeamName: team.key, name: 'TEST lifecycle fence' });
  if (prepared.status !== 'previewReady') throw new Error('Expected original preview');
  const get = gateway.customTeamTemplateGetById.bind(gateway);
  vi.spyOn(gateway, 'customTeamTemplateGetById').mockImplementationOnce(async request => {
    const value = await get(request);
    const lifecycle = team.owner.lifecycleCommands('human');
    lifecycle.execute({ commandId: 'TEST-trash-during-save', operation: 'trash',
      expectedRevision: lifecycle.view().revision });
    return value;
  });
  const create = vi.spyOn(gateway, 'customTeamTemplateCreate');
  await expect(feature.saveTemplate.execute({ previewToken: prepared.preview.previewToken }))
    .resolves.toEqual({ status: 'sourceUnavailable', sourceTeamName: team.key });
  expect(create).not.toHaveBeenCalled();
  expect((await gateway.customTeamTemplateList()).templates).toHaveLength(0);
});

it('does not retry a settled not-started write after its original Host definition changes', async () => {
  const { f, feature, gateway } = fixture(), team = f.addTeam();
  const prepared = await feature.preparePreview.execute({ sourceTeamName: team.key, name: 'TEST configuration fence' });
  if (prepared.status !== 'previewReady') throw new Error('Expected original preview');
  const create = vi.spyOn(gateway, 'customTeamTemplateCreate').mockImplementationOnce(async () => {
    const settled = Promise.resolve().then(() => {
      const roster = team.human.readRoster();
      team.human.replaceRoster({ commandId: 'TEST-edited-during-save', expectedRevision: roster.revision,
        members: [{ name: 'alice', role: 'TEST changed after original admission' }], savedSettings: roster.savedSettings });
    });
    throw new CustomTeamTemplateStorageInterruptedError('TEST stopped writer', 'not_started', settled);
  });
  await expect(feature.saveTemplate.execute({ previewToken: prepared.preview.previewToken }))
    .resolves.toEqual({ status: 'sourceUnavailable', sourceTeamName: team.key });
  expect(create).toHaveBeenCalledOnce();
  expect((await gateway.customTeamTemplateList()).templates).toHaveLength(0);
});

it('never rebinds a reviewed token to a replacement owner with the same portable content', async () => {
  const { f, reader, feature, gateway } = fixture(), team = f.addTeam();
  const prepared = await feature.preparePreview.execute({ sourceTeamName: team.key, name: 'TEST original owner' });
  if (prepared.status !== 'previewReady') throw new Error('Expected original preview');
  const replacement = f.addTeam({ name: 'replacement', handleId: team.connection.handle.handleId,
    ownerResourceRef: 'TEST-replacement-owner' });
  f.setSnapshot({ state: 'ready', bindings: [replacement.connection] });
  const fresh = await reader.readSnapshot(team.key);
  expect(fresh.status).toBe('available');
  if (fresh.status !== 'available') throw new Error('Expected readable replacement');
  expect(fresh.snapshot.teamPrompt).toBe(prepared.preview.teamPrompt);
  const create = vi.spyOn(gateway, 'customTeamTemplateCreate');
  await expect(feature.saveTemplate.execute({ previewToken: prepared.preview.previewToken }))
    .resolves.toEqual({ status: 'sourceUnavailable', sourceTeamName: team.key });
  expect(create).not.toHaveBeenCalled();
  expect((await gateway.customTeamTemplateList()).templates).toHaveLength(0);
});

it('does not redispatch a settled not-started save after its original Host source is revoked', async () => {
  const { f, feature, gateway } = fixture(), team = f.addTeam();
  const prepared = await feature.preparePreview.execute({ sourceTeamName: team.key, name: 'TEST retry fence' });
  if (prepared.status !== 'previewReady') throw new Error('Expected original preview');
  const create = vi.spyOn(gateway, 'customTeamTemplateCreate').mockImplementationOnce(async () => {
    const settled = Promise.resolve().then(() => { f.revokeContext(); });
    throw new CustomTeamTemplateStorageInterruptedError('TEST stopped writer', 'not_started', settled);
  });
  await expect(feature.saveTemplate.execute({ previewToken: prepared.preview.previewToken }))
    .resolves.toEqual({ status: 'sourceUnavailable', sourceTeamName: team.key });
  expect(create).toHaveBeenCalledOnce();
  expect((await gateway.customTeamTemplateList()).templates).toHaveLength(0);
});
