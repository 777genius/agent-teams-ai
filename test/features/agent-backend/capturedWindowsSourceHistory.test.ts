// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, win32 } from 'node:path';

import { applyLaunchConfiguration, buildOpenCodeCoordinationConfig, buildOpenCodeCoordinationEnvironment,
  buildOpenCodeManagementEnvironment, runtimeMemberProfileSchema, runtimeSourceRecipeIdentity,
  selectOpenCodeCoordinationProvider, teamModelProbeProfile, withOpenCodeModelLimits } from '@agent-teams/legacy-agent-host/owned-process';
import { afterEach, expect, it } from 'vitest';

import { FileRuntimeSourceIndex } from '../../../packages/legacy-agent-host/dist/adapters/profile/FileRuntimeSourceIndex.js';
import { FileManagementCommandStore } from '../../../packages/legacy-agent-host/dist/adapters/providers/FileManagementCommandStore.js';
import { OpenCodeManagementHost } from '../../../packages/legacy-agent-host/dist/adapters/providers/OpenCodeManagementHost.js';
import { applyOpenCodeRuntimeSource } from '../../../packages/legacy-agent-host/dist/composition/applyOpenCodeRuntimeSource.js';
import { publishRuntimeSourceSchema } from '../../../packages/legacy-agent-host/dist/composition/runtimeSourceContracts.js';
import { teamHostProfileSchema } from '../../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import { providerManagementProfileSchema } from '../../../packages/legacy-agent-host/dist/management/profile.js';
import { runtimeDigest } from '../../../packages/legacy-agent-host/dist/runtime/identity.js';
import { CapturedWindowsRuntimeSources } from '../../../src/features/agent-backend/main/infrastructure/CapturedWindowsRuntimeSources';
import { captureWindowsSourceAssociation } from '../../../src/features/agent-backend/main/infrastructure/capturedWindowsSourceAssociation';

import type { SelectedWindowsProcessProfile } from '../../../src/features/agent-backend/main/infrastructure/CapturedWindowsRuntimeSources';
import type { NativeProcessProfile, ResolvedLaunchSpec, RuntimeSourceProcessOrigin } from '@agent-teams/legacy-agent-host/owned-process';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Original journals and Main policy; inert bytes are never executed and no native broker is opened. */
function fixture(options: { allowB?: boolean; sameHome?: boolean; creation?: boolean;
  openCode?: boolean; retainOriginal?: boolean; environment?: Record<string, string>;
  managementEnvironment?: Record<string, string> } = {}) {
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
  const provider = options.openCode ? 'opencode' : 'codex', version = options.openCode ? '1.19.4' : '0.162.0';
  const environment = (home: string) => ({ HOME: home, CODEX_HOME: home, ...options.environment,
    ...(options.openCode ? { USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home,
      XDG_STATE_HOME: home, PATH: 'TEST original path', NODE_OPTIONS: '--conditions=TEST-published',
      TEST_IMMUTABLE: 'TEST original value', OPENCODE_CAPTURED_FLAG: 'TEST removed only for coordination',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'TEST-provider/TEST-initial', instructions: ['TEST preserved'],
        agent: { build: { prompt: 'TEST original agent' } },
        provider: { 'TEST-provider': { npm: '@ai-sdk/openai-compatible', options: { apiKey: 'TEST-original-key' },
          models: { 'TEST-initial': { name: 'initial' },
            'TEST-source': { name: 'source', limit: { output: 1000, context: 12000 } },
            'TEST-selected': { name: 'selected' } } } } }) } : {}) });
  const preferences = { defaultModelId: 'TEST-provider/TEST-source', modelLimitOverrides: {
    'TEST-provider/TEST-source': { contextTokens: 12000, outputTokens: 1000 },
    'TEST-provider/TEST-selected': { contextTokens: 24000, outputTokens: 2000 },
  } };
  const seed = providerManagementProfileSchema.parse({ provider,
    ...(options.openCode ? { endpoint: 'http://127.0.0.1:14321' } : { protocolRevision: '0.162.0' }),
    profileId: 'TEST-management-A', configRevision: 'TEST-config-A', accountBinding: 'TEST-account-A',
    cwd: homeA, executable: original, environment: { ...environment(homeA), ...options.managementEnvironment },
    timeoutMs: 1000, windowsBroker: broker });
  const member = (name: 'A' | 'B') => {
    const value = runtimeMemberProfileSchema.parse({
    provider, protocolRevision: version, executable: original, windowsBroker: broker,
    cwd: name === 'A' ? homeA : homeB,
    environment: environment(name === 'A' ? homeA : homeB),
    accountBinding: `TEST-account-${options.sameHome ? 'A' : name}`, teamId: scope(name).teamId, memberId: 'TEST-member',
    principalId: `TEST-principal-${name}`, sessionId: `TEST-session-${name}`, generation: 1,
    configRevision: `TEST-config-${name}`, model: options.openCode ? 'TEST-initial' : 'TEST-model',
    limits: { queuedInputs: 1, inputBytes: 1024, outputBytes: 1024, outputEvents: 100, pendingInteractions: 1, timeoutMs: 1000 },
    ...(options.openCode ? { endpoint: 'http://127.0.0.1:14321',
      nativeOptions: { providerId: 'TEST-provider', agent: 'build' }, managedPreferences: preferences }
      : { nativeOptions: { approvalPolicy: 'never', sandbox: 'read-only' } }),
    });
    if (!options.openCode && value.provider !== 'codex') throw new Error('TEST expected Codex recipe');
    if (options.openCode && value.provider !== 'opencode') throw new Error('TEST expected V1 recipe');
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
    ownerRevision: context.owner.revision, contextId: 'TEST-context-A', projectPath: options.creation ? seed.cwd : null, runtimeId: provider,
    profileId: seed.profileId, configRevision: seed.configRevision, teamScopes: [scope('A'), ...(options.allowB ? [scope('B')] : [])] },
    commandId: 'TEST-publish-A', expectedRevision: 'd'.repeat(64), candidate: { sourceKind: 'app-managed', executable: next,
      nativeCli: { executable: next, version }, ...(options.openCode ? { openCodePreferences: preferences } : {}) } });
  input.expectedRevision = runtimeDigest({ grant: input.grant, seed });
  const store = new FileManagementCommandStore(root);
  const publish = (request: typeof input) => {
    const selection = { previousRevision: request.expectedRevision, commandId: request.commandId,
      grant: request.grant, candidate: request.candidate };
    const record = { ...selection, revision: runtimeDigest(selection) };
    store.write({ schemaVersion: 1, kind: 'runtime.source', commandId: request.commandId,
      profileId: seed.profileId, configRevision: seed.configRevision, providerId: seed.provider,
      fingerprint: runtimeDigest(request), selectionDigest: runtimeDigest({ grant: request.grant, seed }), resourceId: request.grant.targetId,
      resourceHeld: false, sourceId: request.grant.targetId, revision: record.revision,
      expectedRevision: request.expectedRevision, publicationJson: JSON.stringify(request), phase: 'published', nativeVersion: version });
    new FileRuntimeSourceIndex(root, () => {}).publish(record, request.expectedRevision);
    return record;
  };
  const retained = options.retainOriginal ? publish({ ...input, commandId: 'TEST-publish-original',
    candidate: { ...input.candidate, executable: original, nativeCli: { executable: original, version } } }) : undefined;
  if (retained) input.expectedRevision = retained.revision;
  const record = publish(input);
  const profile = (name: 'A' | 'B'): SelectedWindowsProcessProfile => {
    const value = member(name);
    return { ...value, association: captureWindowsSourceAssociation('member', value)!,
      ...(options.openCode ? { environmentRecipe: { kind: 'member' as const, profile: value } } : {}) };
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
  return { root, context, input, record, retained, next, broker, member, profile, template, spec, origin, admit, main, store, seed };
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


it('retained A and published B keep their entire environment through cold Main prepare and resume', () => {
  const f = fixture({ retainOriginal: true, environment: {
    PATH: 'TEST captured path', NODE_OPTIONS: '--conditions=TEST-original', TEST_IMMUTABLE: 'original',
  } });
  const cold = new CapturedWindowsRuntimeSources(f.context, [f.input.grant], [f.profile('A')], () => {});
  for (const record of [f.retained!, f.record]) {
    const spec = { ...f.spec('A'), executable: record.candidate.executable.path };
    const origin = { ...f.origin('A'), revision: record.revision };
    for (const phase of ['prepare', 'resume'] as const) {
      const admission = { ...f.admit('A'), phase, runtimeSourceOrigin: origin };
      expect(cold.select(spec, record.candidate.executable.sha256, f.broker, admission)).toBeDefined();
      for (const environment of [
        spec.environment.filter(value => !value.startsWith('TEST_IMMUTABLE=')),
        spec.environment.map(value => value.startsWith('PATH=') ? 'PATH=changed' : value),
        [...spec.environment, 'NODE_PATH=TEST injected loader'],
        [...spec.environment, 'Path=TEST case alias'],
      ]) expect(cold.select({ ...spec, environment }, record.candidate.executable.sha256, f.broker, admission)).toBeUndefined();
    }
  }
});

function constructedManagementProfile(profile: ConstructorParameters<typeof OpenCodeManagementHost>[0]) {
  let captured: NativeProcessProfile | undefined;
  const reached = new Error('TEST real management constructor before native work');
  expect(() => new OpenCodeManagementHost(profile, { canAllocate: () => true, isCurrent: () => true }, {
    createProcess(value) { captured = value; throw reached; },
  })).toThrow(reached);
  if (!captured) throw new Error('TEST missing native profile');
  return captured;
}

it('published V1 source/default and two model-limit overlays admit eligible member and template management probes', () => {
  const f = fixture({ openCode: true, creation: true, sameHome: true });
  for (const kind of ['member', 'template'] as const) {
    const original = kind === 'member' ? f.member('A') : f.template;
    if (original.provider !== 'opencode') throw new Error('TEST V1 source');
    const published = { ...applyOpenCodeRuntimeSource(original, f.input.candidate), executable: f.next };
    const limited = withOpenCodeModelLimits(published, { providerId: 'TEST-provider', modelId: 'TEST-source',
      limits: { contextTokens: 12000, outputTokens: 1000 } });
    const selected = applyLaunchConfiguration(limited, { model: 'TEST-provider/TEST-selected', effort: 'high' });
    const probe = teamModelProbeProfile(selected);
    if (probe.provider !== 'opencode') throw new Error('TEST V1 probe');
    const captured = constructedManagementProfile(probe);
    const profile: SelectedWindowsProcessProfile = { ...original,
      association: captureWindowsSourceAssociation(kind, original)!,
      environmentRecipe: { kind, profile: original } };
    const origin: RuntimeSourceProcessOrigin = kind === 'member' ? f.origin('A') : {
      sourceId: f.input.grant.targetId, revision: f.record.revision, origin: {
        kind: 'runtime', scope: { teamId: 'TEST-new-team', projectId: 'TEST-context-A', workspaceId: 'TEST-context-A' },
        teamId: 'TEST-new-team', memberId: 'TEST-new-member', projectPath: f.seed.cwd,
        recipeIdentity: runtimeSourceRecipeIdentity(original),
      },
    };
    const cold = new CapturedWindowsRuntimeSources(f.context, [f.input.grant], [profile], () => {});
    const spec = { ...f.spec('A'), environment: Object.entries(captured.environment).map(([key, value]) => key + '=' + value) };
    const config: Record<string, unknown> = JSON.parse(captured.environment.OPENCODE_CONFIG_CONTENT!);
    for (const phase of ['prepare', 'resume'] as const) {
      const admission = { ...f.admit('A'), phase, runtimeSourceOrigin: origin };
      expect(cold.select(spec, f.next.sha256, f.broker, admission)).toBeDefined();
      const environment = Object.entries({ ...captured.environment,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, instructions: ['TEST substituted preserved configuration'] }) })
        .map(([key, value]) => key + '=' + value);
      expect(cold.select({ ...spec, environment }, f.next.sha256, f.broker, admission)).toBeUndefined();
    }
  }
});

it('published ordinary V1 management admits actual same-value limit reconstruction without normalizing captured bytes', () => {
  const f = fixture({ openCode: true });
  if (f.seed.provider !== 'opencode') throw new Error('TEST V1 management');
  const published = { ...applyOpenCodeRuntimeSource(f.seed, f.input.candidate), executable: f.next };
  const limited = withOpenCodeModelLimits(published, { providerId: 'TEST-provider', modelId: 'TEST-source',
    limits: { contextTokens: 12000, outputTokens: 1000 } });
  const captured = constructedManagementProfile(limited);
  expect(published.environment.OPENCODE_CONFIG_CONTENT).toContain('"limit":{"output":1000,"context":12000}');
  expect(captured.environment.OPENCODE_CONFIG_CONTENT).toContain('"limit":{"context":12000,"output":1000}');
  const profile: SelectedWindowsProcessProfile = { ...f.seed,
    association: captureWindowsSourceAssociation('management', f.seed)!,
    environmentRecipe: { kind: 'management', profile: f.seed } };
  const main = new CapturedWindowsRuntimeSources(f.context, [f.input.grant], [profile], () => {});
  const origin: RuntimeSourceProcessOrigin = { sourceId: f.input.grant.targetId, revision: f.record.revision,
    origin: { kind: 'management', profileId: f.seed.profileId, configRevision: f.seed.configRevision } };
  const spec = { ...f.spec('A'), environment: Object.entries(captured.environment).map(([key, value]) => key + '=' + value) };
  for (const phase of ['prepare', 'resume'] as const)
    expect(main.select(spec, f.next.sha256, f.broker, { ...f.admit('A'), phase, runtimeSourceOrigin: origin })).toBeDefined();
});

it('published V1 general coordination uses its actual pure builders and keeps immutable entries in cold Main', () => {
  const f = fixture({ openCode: true, managementEnvironment: { HOME: 'C:\\TEST\\source-home',
    USERPROFILE: 'C:\\TEST\\source-home', XDG_CONFIG_HOME: 'C:\\TEST\\source-config', XDG_DATA_HOME: 'C:\\TEST\\source-data',
    XDG_CACHE_HOME: 'C:\\TEST\\source-cache', XDG_STATE_HOME: 'C:\\TEST\\source-state' } });
  if (f.seed.provider !== 'opencode') throw new Error('TEST V1 source');
  const probe = { ...applyOpenCodeRuntimeSource(f.seed, f.input.candidate), executable: f.next };
  // Pure assembly takes Windows names; private backing namespaces and history remain native to this runner.
  const child = mkdtempSync(join(f.root, 'agent-teams-coordination-'));
  const directory = (name: string) => {
    mkdirSync(join(child, name)); return win32.join(probe.environment.XDG_DATA_HOME!, basename(child), name);
  };
  const paths = { home: directory('home'), config: directory('config'), data: directory('data'),
    cache: directory('cache'), state: directory('state') };
  const input = { providerId: 'TEST-provider', modelId: 'TEST-source' };
  const provider = selectOpenCodeCoordinationProvider({ npm: '@ai-sdk/openai-compatible',
    options: { baseURL: 'http://127.0.0.1:14320/v1', TEST_preserved_option: { value: 'logical Host input' } },
    models: { 'TEST-source': { name: 'TEST selected model' }, 'TEST-other': { name: 'must be omitted' } } }, input, 'TEST-private-key');
  if (!provider) throw new Error('TEST coordination provider');
  const isolated = buildOpenCodeCoordinationEnvironment(probe.environment, paths);
  const config = buildOpenCodeCoordinationConfig(probe, input, provider,
    { url: 'http://127.0.0.1:14322/coordination', bearerToken: 'c'.repeat(43) });
  const environment = buildOpenCodeManagementEnvironment(isolated, config,
    { password: 'p'.repeat(43), witnessAgent: 'management_' + 'a'.repeat(24), witness: 'w'.repeat(43), coordination: true });
  expect(environment.HOME).not.toBe(f.seed.environment.HOME);
  expect(environment.NODE_OPTIONS).toBe(f.seed.environment.NODE_OPTIONS);
  expect(Object.hasOwn(environment, 'OPENCODE_CAPTURED_FLAG')).toBe(false);
  const profile: SelectedWindowsProcessProfile = { ...f.seed,
    association: captureWindowsSourceAssociation('management', f.seed)!,
    environmentRecipe: { kind: 'management', profile: f.seed } };
  const cold = new CapturedWindowsRuntimeSources(f.context, [f.input.grant], [profile], () => {});
  const origin: RuntimeSourceProcessOrigin = { sourceId: f.input.grant.targetId, revision: f.record.revision,
    origin: { kind: 'management', profileId: f.seed.profileId, configRevision: f.seed.configRevision } };
  for (const phase of ['prepare', 'resume'] as const) {
    const admission = { ...f.admit('A'), phase, runtimeSourceOrigin: origin };
    const spec = (value: Record<string, string>): ResolvedLaunchSpec => ({ ...f.spec('A'),
      environment: Object.entries(value).map(([key, entry]) => key + '=' + entry) });
    expect(cold.select(spec(environment), f.next.sha256, f.broker, admission)).toBeDefined();
    for (const changed of [
      { ...environment, TEST_IMMUTABLE: 'changed' },
      { ...environment, NODE_OPTIONS: '--require=TEST changed loader' },
      { ...environment, OPENCODE_UNKNOWN_FLAG: '1' },
      { ...environment, XDG_CACHE_HOME: f.root },
      { ...environment, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...JSON.parse(environment.OPENCODE_CONFIG_CONTENT), TEST_unknown: true }) },
    ]) expect(cold.select(spec(changed), f.next.sha256, f.broker, admission)).toBeUndefined();
  }
});
