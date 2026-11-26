// @vitest-environment node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { capturedHostTeamReadsFixture } from './fixtures/capturedHostTeamReadsFixture';

const fixtures: ReturnType<typeof capturedHostTeamReadsFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.dispose()));
function fixture() {
  const f = capturedHostTeamReadsFixture();
  fixtures.push(f);
  return f;
}

it('captures a cold catalog and assembles real Task and Unicode message pages in Main', async () => {
  const f = fixture(), team = f.addTeam();
  const task = team.human.execute({ commandId: 'TEST-main-read-task', operation: 'task.create',
    payload: { subject: 'TEST decision', owner: 'team-lead' } });
  const directory = join(f.root, 'teams', team.binding.teamName, 'inboxes');
  mkdirSync(directory, { recursive: true });
  const message = { messageId: 'TEST-large-main', from: 'alice', to: 'user',
    timestamp: '2026-11-25T12:00:00.000Z', read: false, text: '漢'.repeat(140_000) };
  writeFileSync(join(directory, 'user.json'), JSON.stringify([message]));
  const host = (await f.capture())!;
  const product = await host.product(team.key);
  expect(product.data.tasks.map(row => row.id)).toEqual([task.effects.taskId]);
  const original = product.data.messages.find(row => row.messageId === message.messageId);
  expect(original?.text === message.text).toBe(true);
  expect(f.router.request.mock.calls.filter(([, r]) => r.method === 'team.snapshot').length)
    .toBeGreaterThan(1);
  expect(f.feature.initialize).toHaveBeenCalledOnce();
  expect(f.feature.discoverBindings).toHaveBeenCalledOnce();
  product.assertCurrent();
});

it.each(['scope', 'owner'] as const)('rejects publication when the captured %s changes during a read', async mode => {
  const f = fixture(), team = f.addTeam(), host = (await f.capture())!;
  f.afterRead(() => {
    if (mode === 'scope') f.revokeContext();
    else f.snapshot().bindings[0].ownerResourceRef = 'TEST-replacement-owner';
  });
  await expect(host.product(team.key)).rejects.toThrow();
});

it('reads authored configuration without any task, message, runtime or session operation', async () => {
  const f = fixture(), team = f.addTeam(), host = (await f.capture())!;
  const result = await host.savedConfiguration(team.key);
  expect(result.configuration.savedSettings?.prompt).toBe('TEST saved prompt');
  expect(result.configuration.members.find(row => row.name === 'alice')?.settings.role).toBe('Reviewer');
  expect(f.router.request.mock.calls.map(([, r]) => r.method)).toEqual([
    'team.lifecycle.read', 'team.roster.read', 'team.roster.read', 'team.lifecycle.read',
  ]);
  expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
});

it('refuses an authored configuration changed between its original read and confirmation', async () => {
  const f = fixture(), team = f.addTeam(), host = (await f.capture())!;
  f.afterRead(method => {
    if (method !== 'team.roster.read') return;
    f.afterRead(undefined);
    const before = team.human.readRoster();
    team.human.replaceRoster({ commandId: 'TEST-racing-definition', expectedRevision: before.revision,
      members: [{ name: 'alice', role: 'Changed role' }], savedSettings: before.savedSettings });
  });
  await expect(host.savedConfiguration(team.key)).rejects.toThrow();
});

it('refuses a trashed source and an unrelated owner masquerading as a project child', async () => {
  const f = fixture(), logical = f.addTeam({ name: 'logical', projectContextMode: 'per_project' });
  const child = f.addTeam({ name: 'child', ownerResourceRef: 'TEST-foreign-owner',
    projectContext: { logicalHandleId: logical.connection.handle.handleId,
      projectPath: join(f.root, 'TEST-child'), workContextId: 'TEST-child-context' } });
  const host = (await f.capture())!;
  expect(() => host.logicalConnection(child.connection)).toThrow();
  const lifecycle = logical.owner.lifecycleCommands('human');
  lifecycle.execute({ commandId: 'TEST-trash-source', operation: 'trash',
    expectedRevision: lifecycle.view().revision });
  await expect(host.savedConfiguration(logical.key)).rejects.toThrow();
});

it('keeps an unconfigured Host distinct from a held or incomplete source', async () => {
  const f = fixture();
  f.setSnapshot({ state: 'unconfigured', bindings: [] });
  await expect(f.capture()).resolves.toBeUndefined();
  f.setSnapshot({ state: 'hold', bindings: [] });
  await expect(f.capture()).rejects.toThrow();
});
