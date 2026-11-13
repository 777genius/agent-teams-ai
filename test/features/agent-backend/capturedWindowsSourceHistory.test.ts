// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';
import { runtimeMemberProfileSchema, runtimeSourceRecipeIdentity } from '@agent-teams/legacy-agent-host/owned-process';

import { FileRuntimeSourceIndex } from '../../../packages/legacy-agent-host/dist/adapters/profile/FileRuntimeSourceIndex.js';
import { FileManagementCommandStore } from '../../../packages/legacy-agent-host/dist/adapters/providers/FileManagementCommandStore.js';
import { publishRuntimeSourceSchema } from '../../../packages/legacy-agent-host/dist/composition/runtimeSourceContracts.js';
import { teamHostProfileSchema } from '../../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import { providerManagementProfileSchema } from '../../../packages/legacy-agent-host/dist/management/profile.js';
import { runtimeDigest } from '../../../packages/legacy-agent-host/dist/runtime/identity.js';
import { CapturedWindowsRuntimeSources } from '../../../src/features/agent-backend/main/infrastructure/CapturedWindowsRuntimeSources';
import { captureWindowsSourceAssociation } from '../../../src/features/agent-backend/main/infrastructure/capturedWindowsSourceAssociation';

import type { ResolvedLaunchSpec, RuntimeSourceProcessOrigin } from '@agent-teams/legacy-agent-host/owned-process';
import type { SelectedWindowsProcessProfile } from '../../../src/features/agent-backend/main/infrastructure/CapturedWindowsRuntimeSources';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Original journals and Main policy; inert bytes are never executed and no native broker is opened. */
function fixture(options: { allowB?: boolean; sameHome?: boolean; creation?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-main-source-history-'))); roots.push(root);
  const homeA = join(root, 'home-A'), homeB = options.sameHome ? homeA : join(root, 'home-B');
  for (const home of new Set([homeA, homeB])) mkdirSync(home);
  const binary = (name: string) => {
    const path = join(root, name), bytes = `TEST inert image ${name}\n`;
    writeFileSync(path, bytes); return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const original = binary('TEST-original.exe'), next = binary('TEST-next.exe');
  const broker = { path: 'C:\\TEST\\broker.exe', sha256: 'b'.repeat(64), arch: process.arch as 'x64' | 'arm64',
    protocol: 1 as const, capability: 'service-scopes-v1' as const };
  const scope = (name: string) => ({ teamId: `TEST-team-${name}`, projectId: `TEST-project-${name}`, workspaceId: `TEST-workspace-${name}` });
  const seed = providerManagementProfileSchema.parse({ provider: 'codex', protocolRevision: '0.162.0',
    profileId: 'TEST-management-A', configRevision: 'TEST-config-A', accountBinding: 'TEST-account-A',
    cwd: homeA, executable: original, environment: { HOME: homeA, CODEX_HOME: homeA }, timeoutMs: 1000, windowsBroker: broker });
  const member = (name: 'A' | 'B') => {
    const value = runtimeMemberProfileSchema.parse({
    provider: 'codex', protocolRevision: '0.162.0', executable: original, windowsBroker: broker,
    cwd: name === 'A' ? homeA : homeB,
    environment: { HOME: name === 'A' ? homeA : homeB, CODEX_HOME: name === 'A' ? homeA : homeB },
    accountBinding: `TEST-account-${options.sameHome ? 'A' : name}`, teamId: scope(name).teamId, memberId: 'TEST-member',
    principalId: `TEST-principal-${name}`, sessionId: `TEST-session-${name}`, generation: 1,
    configRevision: `TEST-config-${name}`, model: 'TEST-model',
    limits: { queuedInputs: 1, inputBytes: 1024, outputBytes: 1024, outputEvents: 100, pendingInteractions: 1, timeoutMs: 1000 },
    nativeOptions: { approvalPolicy: 'never', sandbox: 'read-only' },
    });
    if (value.provider !== 'codex') throw new Error('TEST expected Codex recipe');
    return value;
  };
  const template = { ...member('A'), teamId: 'TEST-template', memberId: 'TEST-template' };
  const context = teamHostProfileSchema.parse({ schemaVersion: 1, principalId: 'TEST-human',
    processCustody: { kind: 'main-windows-v1' },
    owner: { ownerId: 'TEST-owner', revision: 'TEST-v1', storageRoot: root,
      profileId: 'TEST-captured-profile', protocolVersion: 1, buildId: 'TEST-build',
      nodeSha256: 'a'.repeat(64), hostEntrySha256: 'b'.repeat(64) },
    teams: (['A', 'B'] as const).map(name => ({
      scope: { ...scope(name), runId: `TEST-run-${name}`, memberId: 'TEST-human', generation: '1' },
      binding: { backendId: 'TEST-owner', teamId: scope(name).teamId, teamName: `test-team-${name}` },
      members: [{ memberId: 'TEST-member', name: 'alice', role: 'member' }],
      grants: [{ principalId: 'TEST-human', memberName: 'user', permissions: ['read', 'admin'] }],
    })), management: [seed],
    runtime: { members: [member('A'), member('B')], providerTemplates: [template] },
    ...(options.creation ? { creation: { contextIds: ['TEST-context-A'] } } : {}) });
  const input = publishRuntimeSourceSchema.parse({ grant: { targetId: 'c'.repeat(64), ownerId: context.owner.ownerId,
    ownerRevision: context.owner.revision, contextId: 'TEST-context-A', projectPath: options.creation ? seed.cwd : null, runtimeId: 'codex',
    profileId: seed.profileId, configRevision: seed.configRevision, teamScopes: [scope('A'), ...(options.allowB ? [scope('B')] : [])] },
    commandId: 'TEST-publish-A', expectedRevision: 'd'.repeat(64), candidate: { sourceKind: 'app-managed', executable: next,
      nativeCli: { executable: next, version: '0.162.0' } } });
  input.expectedRevision = runtimeDigest({ grant: input.grant, seed });
  const selection = { previousRevision: input.expectedRevision, commandId: input.commandId, grant: input.grant, candidate: input.candidate };
  const record = { ...selection, revision: runtimeDigest(selection) };
  const store = new FileManagementCommandStore(root);
  store.write({ schemaVersion: 1, kind: 'runtime.source', commandId: input.commandId,
    profileId: seed.profileId, configRevision: seed.configRevision, providerId: seed.provider,
    fingerprint: runtimeDigest(input), selectionDigest: input.expectedRevision, resourceId: input.grant.targetId,
    resourceHeld: false, sourceId: input.grant.targetId, revision: record.revision,
    expectedRevision: input.expectedRevision, publicationJson: JSON.stringify(input), phase: 'published', nativeVersion: '0.162.0' });
  new FileRuntimeSourceIndex(root, () => {}).publish(record, input.expectedRevision);
  const profile = (name: 'A' | 'B'): SelectedWindowsProcessProfile => {
    const value = member(name);
    return { ...value, association: captureWindowsSourceAssociation('member', value)! };
  };
  const spec = (name: 'A' | 'B'): ResolvedLaunchSpec => {
    const selected = profile(name);
    return { executable: next.path, commandLine: 'TEST app-server --listen stdio://', cwd: selected.cwd,
      environment: Object.entries(selected.environment).map(([key, value]) => `${key}=${value}`) };
  };
  const origin = (name: 'A' | 'B'): RuntimeSourceProcessOrigin => ({ sourceId: input.grant.targetId, revision: record.revision,
    origin: { kind: 'runtime', scope: scope(name), projectPath: seed.cwd, teamId: scope(name).teamId,
      memberId: 'TEST-member', recipeIdentity: runtimeSourceRecipeIdentity(member(name)) } });
  const main = new CapturedWindowsRuntimeSources(context, [input.grant], [profile('A'), profile('B')], () => {});
  const admit = (name: 'A' | 'B') => ({ capability: `TEST-${name}`, phase: 'prepare' as const, runtimeSourceOrigin: origin(name) });
  return { root, context, input, record, next, broker, member, profile, template, spec, origin, admit, main, store, seed };
}

it('same original image cannot transfer A source authority to B account and Team', () => {
  const f = fixture();
  expect(f.main.select(f.spec('A'), f.next.sha256, f.broker, f.admit('A'))?.profile.environment)
    .toEqual(f.profile('A').environment);
  expect(f.main.select(f.spec('B'), f.next.sha256, f.broker, f.admit('B'))).toBeUndefined();
  expect(f.main.select(f.spec('B'), f.next.sha256, f.broker, f.admit('A'))).toBeUndefined();
  expect(f.main.select(f.spec('A'), f.next.sha256, f.broker, { capability: 'TEST-no-origin', phase: 'prepare' })).toBeUndefined();
});

it('same image and HOME still require exact original Team, scope and recipe association', () => {
  const f = fixture({ sameHome: true });
  expect(f.spec('A')).toEqual(f.spec('B'));
  expect(runtimeSourceRecipeIdentity(f.member('A'))).toEqual(runtimeSourceRecipeIdentity(f.member('B')));
  expect(f.main.select(f.spec('A'), f.next.sha256, f.broker, f.admit('A'))).toBeDefined();
  expect(f.main.select(f.spec('B'), f.next.sha256, f.broker, f.admit('B'))).toBeUndefined();
  const a = f.origin('A');
  if (a.origin.kind !== 'runtime') throw new Error('TEST origin');
  for (const origin of [
    { ...a, origin: { ...a.origin, teamId: 'TEST-team-B' } },
    { ...a, origin: { ...a.origin, recipeIdentity: runtimeSourceRecipeIdentity({
      ...f.member('B'), accountBinding: 'TEST-unselected-account',
    }) } },
    { ...a, revision: '0'.repeat(64) },
    { ...a, sourceId: '0'.repeat(64) },
  ]) expect(f.main.select(f.spec('A'), f.next.sha256, f.broker,
    { ...f.admit('A'), runtimeSourceOrigin: origin })).toBeUndefined();
});

it('the existing source grant can explicitly authorize B while preserving B own original namespace', () => {
  const f = fixture({ allowB: true });
  expect(f.main.select(f.spec('B'), f.next.sha256, f.broker, f.admit('B'))?.profile.environment)
    .toEqual(f.profile('B').environment);
  const management = { ...f.profile('A'), association: captureWindowsSourceAssociation('management', f.seed)! };
  const main = new CapturedWindowsRuntimeSources(f.context, [f.input.grant], [management], () => {});
  const origin = { sourceId: f.input.grant.targetId, revision: f.record.revision,
    origin: { kind: 'management', profileId: f.seed.profileId, configRevision: f.seed.configRevision } } satisfies RuntimeSourceProcessOrigin;
  expect(main.select(f.spec('A'), f.next.sha256, f.broker, { ...f.admit('A'), runtimeSourceOrigin: origin })).toBeDefined();
  expect(main.select(f.spec('A'), f.next.sha256, f.broker, { ...f.admit('A'), runtimeSourceOrigin:
    { ...origin, origin: { ...origin.origin, configRevision: 'TEST-foreign' } } })).toBeUndefined();
});

it('an original template admits an eligible new Team/worktree, never relabels an existing Team', () => {
  const f = fixture({ creation: true, sameHome: true });
  const selected = { ...f.template, association: captureWindowsSourceAssociation('template', f.template)! };
  const main = new CapturedWindowsRuntimeSources(f.context, [f.input.grant], [selected], () => {});
  const cwd = join(f.root, 'TEST-worktree'); mkdirSync(cwd);
  const origin = { sourceId: f.input.grant.targetId, revision: f.record.revision,
    origin: { kind: 'runtime', scope: { teamId: 'TEST-new-team', projectId: 'TEST-context-A', workspaceId: 'TEST-context-A' },
      teamId: 'TEST-new-team', memberId: 'TEST-new-member', projectPath: f.seed.cwd,
      recipeIdentity: runtimeSourceRecipeIdentity(f.template) } } satisfies RuntimeSourceProcessOrigin;
  expect(main.select({ ...f.spec('A'), cwd }, f.next.sha256, f.broker,
    { ...f.admit('A'), runtimeSourceOrigin: origin })).toBeDefined();
  expect(main.select(f.spec('B'), f.next.sha256, f.broker, { ...f.admit('B'), runtimeSourceOrigin:
    { ...origin, origin: { ...origin.origin, teamId: 'TEST-team-B', scope: { ...origin.origin.scope, teamId: 'TEST-team-B' } } } })).toBeUndefined();
});

it('cold Main validates the original history and rechecks its successful receipt before resume', () => {
  const f = fixture();
  const capture = f.main.select(f.spec('A'), f.next.sha256, f.broker, f.admit('A'))!;
  const cold = new CapturedWindowsRuntimeSources(f.context, [f.input.grant], [f.profile('A')], () => {});
  expect(cold.select(f.spec('A'), f.next.sha256, f.broker, f.admit('A'))).toBeDefined();
  const saved = f.store.read(f.input.commandId)!;
  f.store.write({ ...saved, phase: 'held', resourceHeld: false });
  expect(() => capture.assertCurrent()).toThrow();
  expect(() => cold.select(f.spec('A'), f.next.sha256, f.broker, { ...f.admit('A'), phase: 'resume' })).toThrow();
});
