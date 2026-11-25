// @vitest-environment node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { expect, it } from 'vitest';

import { createFilesystemTeamOwner } from '../../../packages/legacy-agent-host/dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerStore } from '../../../packages/legacy-agent-host/dist/adapters/team/TeamOwnerStore.js';
import { runtimeDigest } from '../../../packages/legacy-agent-host/dist/runtime/identity.js';
import { ProviderManagementCoordinator } from '../../../packages/legacy-agent-host/dist/composition/ProviderManagementCoordinator.js';
import { runtimeMemberProfileSchema } from '../../../packages/legacy-agent-host/dist/composition/runtimeProfile.js';
import { RuntimeTeamCoordinator } from '../../../packages/legacy-agent-host/dist/composition/RuntimeTeamCoordinator.js';
import { modelConfigurationFromLaunch } from '../../../packages/legacy-agent-host/dist/composition/savedTeamModelProbe.js';
import { teamHostProfileSchema } from '../../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import { executeTeamModelProbe, teamModelProbeProfile } from '../../../packages/legacy-agent-host/dist/composition/teamLaunchModelProbe.js';
import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';
import { projectLaunchConfiguration, projectLaunchModelConfiguration } from '../../../src/features/agent-backend/main/adapters/output/projectLaunchConfiguration';
import { prepareCapturedTeamModels } from '../../../src/features/agent-backend/main/application/prepareCapturedTeamModels';
import { captureLocalModelReadinessOrigin, captureRequestReadinessBudget, createReadinessPreparation, readinessPreparationWire } from '../../../src/features/agent-backend/main/infrastructure/CapturedLocalModelReadiness';
import { FileTeamModelProbeIntents } from '../../../src/features/agent-backend/main/infrastructure/FileTeamModelProbeIntents';
import { JsonLocalProviderPrivateNetworkApprovalStore } from '../../../src/features/runtime-provider-management/main/readiness';
import { parseOpenCodeQualifiedModelRef } from '../../../src/shared/utils/opencodeModelRef';
import { readEmulatedSourceActionProbe } from '../../../tools/owned-process-broker/nativeEmulatedSourceReadiness';

import type { TeamLaunchRecord } from '../../../packages/legacy-agent-host/dist/team-launch/contracts.js';
import type { BackendLaunchModelSelection } from '../../../src/features/agent-backend/contracts/launch';
import type { BackendOperationRequest, BackendOperationResult } from '../../../src/features/agent-backend/contracts/operations';
import type { LocalModelReadinessContext } from '../../../src/features/agent-backend/main/infrastructure/CapturedLocalModelReadiness';

const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Finite peer only: no vendor binary, authentication or inference is used. */
async function fixture(options: { runtimeEnabled?: boolean; projectConfiguration?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-desktop-backend-')));
  const scope = join(root, 'TEST-peer-opencode-scope'), workspace = join(root, 'workspace');
  for (const path of [scope, workspace, join(root, 'hoststore'),
    ...['home', 'tmp', 'config', 'data', 'cache'].map(name => join(scope, name))]) await mkdir(path, { mode: 0o700 });
  const node = await realpath(process.execPath);
  const source = await realpath(resolve('tools/owned-process-broker/fixtures/providerDesktopPeer.mjs'));
  const sourceHash = digest(await readFile(source));
  const bytes = `#!${node}\nimport assert from 'node:assert/strict';
import{createHash}from'node:crypto';import{readFileSync,realpathSync}from'node:fs';
assert.equal(realpathSync(${JSON.stringify(source)}),${JSON.stringify(source)});
assert.equal(createHash('sha256').update(readFileSync(${JSON.stringify(source)})).digest('hex'),${JSON.stringify(sourceHash)});
await import(${JSON.stringify(pathToFileURL(source).href)});\n`;
  const executable = { path: join(root, 'TEST-opencode-peer.mjs'), sha256: digest(bytes) };
  await writeFile(executable.path, bytes, { mode: 0o700, flag: 'wx' });
  const config = { provider: { 'test-provider': { npm: '@ai-sdk/openai-compatible',
    options: { baseURL: 'http://127.0.0.1:19999/TEST-no-network', apiKey: 'TEST-LOCALHOST-ONLY' },
    models: { 'TEST-model': { name: 'TEST model', limit: { context: 4096, output: 1024 } } } } } };
  if (options.projectConfiguration !== false) await writeFile(join(workspace, 'opencode.json'), JSON.stringify(config), { mode: 0o600, flag: 'wx' });
  const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  const member = runtimeMemberProfileSchema.parse({ provider: 'opencode', protocolRevision: '1.19.4',
    teamId: 'TEST-team', memberId: 'alice-id', principalId: 'alice-session', sessionId: 'TEST-seed-session',
    generation: 1, configRevision: 'TEST-runtime', accountBinding: 'TEST-no-vendor-account', model: 'TEST-model',
    cwd: workspace, executable, endpoint: `http://127.0.0.1:${address.port}`,
    environment: { HOME: join(scope, 'home'), TMPDIR: join(scope, 'tmp'), XDG_CONFIG_HOME: join(scope, 'config'),
      XDG_DATA_HOME: join(scope, 'data'), XDG_CACHE_HOME: join(scope, 'cache'), PATH: `${dirname(node)}:/usr/bin:/bin`,
      TEST_EMULATED_DESKTOP_PROVIDER: '1', TEST_PEER_SCENARIO: 'desktop-ui-v1', TEST_PEER_PROVIDER: 'opencode',
      TEST_PEER_ROLE: 'runtime', TEST_DESKTOP_PEER_ROOT: scope, TEST_DESKTOP_PEER_WORKSPACE: workspace,
      TEST_PEER_EFFECTS: join(scope, 'effects.ndjson'), OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      ...(options.runtimeEnabled ? { TEST_PEER_MCP_POLICY_SHA256: digest(await readFile(resolve(
        'packages/legacy-agent-host/dist/adapters/providers/OpenCodeMcpPolicyPlugin.js'))) } : {}) },
    nativeOptions: { providerId: 'test-provider', agent: 'build', toolApprovalMode: 'manual' },
    limits: { queuedInputs: 1, inputBytes: 65536, outputBytes: 65536, outputEvents: 100,
      pendingInteractions: 1, timeoutMs: 10000 } });
  const binding = { backendId: 'TEST-owner', teamId: 'TEST-team', teamName: 'test-opencode-transfer' };
  const profile = teamHostProfileSchema.parse({ schemaVersion: 1, principalId: 'TEST-human',
    owner: { ownerId: binding.backendId, revision: 'TEST-owner-revision', storageRoot: join(root, 'hoststore'),
      profileId: 'TEST-profile', protocolVersion: 1, buildId: 'TEST-build', nodeSha256: digest(await readFile(node)),
      hostEntrySha256: digest(await readFile(resolve('packages/legacy-agent-host/dist/cli.js'))) },
    runtime: { members: [member], providerTemplates: [structuredClone(member)] }, teams: [{ binding,
      scope: { projectId: 'TEST-project', workspaceId: 'TEST-workspace', teamId: binding.teamId,
        runId: 'TEST-original-run', memberId: 'human', generation: '1' },
      members: [{ memberId: member.memberId, name: 'alice', role: 'lead',
        delivery: { ...binding, runId: 'TEST-original-run', memberId: member.memberId, generation: '1' } }],
      savedSettings: { cwd: workspace, providerId: 'opencode', model: 'test-provider/TEST-model', prompt: '', skipPermissions: false },
      grants: [{ principalId: 'TEST-human', memberName: 'user', permissions: ['read', 'admin'] },
        { principalId: member.principalId, memberName: 'alice', permissions: ['read', 'message.write'] }] }] });
  const definition = profile.teams[0];
  const owner = createFilesystemTeamOwner({ root: profile.owner.storageRoot, binding,
    members: definition.members, savedSettings: definition.savedSettings, grants: definition.grants,
    assertRosterEditable: members => runtime.assertRosterEditable(binding.teamId, members) });
  const team = { definition, owner, connection: owner.connect(profile.principalId) };
  const management = new ProviderManagementCoordinator([teamModelProbeProfile(member)], () => {
    // This finite fixture keeps one unchanged owner for the whole original action.
  }, profile.owner.storageRoot);
  const runtime: RuntimeTeamCoordinator = new RuntimeTeamCoordinator({ profile, teams: new Map([[binding.teamId, team]]), modelReadiness: management,
    assertWriter() { /* The same TEST owner remains current until cleanup. */ },
    ...(options.runtimeEnabled ? {} : {
      createProvider() { assert.fail('Model preflight and capture must not allocate a Team Runtime'); } }) });
  return { root, scope, workspace, profile, team, management, runtime, async close() {
    await runtime.close(); await management.close(); await rm(root, { recursive: true, force: true });
  } };
}

// POSIX finite shebang fixture; Windows custody remains under its separate native gate.
it('unchanged OpenCode readiness binds the original product roster before capture, with one finite probe', { skip: process.platform === 'win32' }, async () => {
  for (const prospective of [false, true]) {
    const f = await fixture();
    try {
      const handle = { handleId: 'TEST-handle' }, teamId = f.team.definition.binding.teamId;
      // Retain the old launch source explicitly; an unstarted seed's model read now returns the product source.
      const read = () => projectLaunchModelConfiguration(prospective
        ? f.runtime.executeLaunch(teamId, 'model.configuration.read', 'TEST-read', {})
        : modelConfigurationFromLaunch(f.runtime.executeLaunch(teamId, 'configuration.read', 'TEST-read', {})));
      const view = read(), roster = f.team.connection.readRoster();
      if (prospective) {
        expect(view.source.sourceId).toMatch(/^saved-model-/);
        expect(view.source.rosterRevision).toBe(roster.revision);
      } else {
        expect(view.source.sourceId).toBe(f.team.definition.scope.runId);
        expect(view.source.rosterRevision).not.toBe(roster.revision);
      }
      let probeCommand = '', selection: BackendLaunchModelSelection;
      const invoke = async (request: BackendOperationRequest, budget?: LocalModelReadinessContext): Promise<BackendOperationResult> => {
        if (request.operation === 'team.launch.model.configuration.read') return { ok: true, value: read() };
        if (!['team.launch.probe.start', 'team.launch.probe.read', 'team.launch.probe.cancel'].includes(request.operation))
          assert.fail('Unexpected operation');
        const action = request.operation.slice('team.launch.probe.'.length) as 'start' | 'read' | 'cancel';
        const origin = action === 'start' ? await captureLocalModelReadinessOrigin({ kind: 'team', owner: f.profile.owner,
          contextId: 'local', commandId: request.commandId, selection: { handleId: handle.handleId,
            scope: f.team.definition.scope, payload: request.payload }, workspaces: [f.workspace],
          targets: [{ workspace: f.workspace, providerId: 'test-provider' }],
          current() { /* One original TEST owner and selection. */ }, budget: budget!,
          home: join(f.scope, 'home'), environment: f.profile.runtime!.members[0].environment }) : undefined;
        if (action === 'start') { expect(probeCommand).toBe(''); probeCommand = request.commandId; }
        const value = await executeTeamModelProbe({ runtime: f.runtime, management: f.management, teamId,
          commandId: request.commandId, action, payload: request.payload, ...(origin ? { readiness: {
            preparation: { origin, remainingMs: budget!.remainingMs() }, owner: f.profile.owner,
            handleId: handle.handleId, scope: f.team.definition.scope } } : {}) });
        return projectBackendResult(request, { ok: true, value });
      };
      if (prospective) {
        const prepared = await prepareCapturedTeamModels({ backend: { invoke }, handle,
          intents: new FileTeamModelProbeIntents(join(f.root, 'intents'), f.root), isCurrent: () => true,
          request: { cwd: f.workspace, providerId: 'opencode', preparationId: 'TEST-preparation',
            modelChecks: [{ providerId: 'opencode', model: 'test-provider/TEST-model', targets: [{ kind: 'lead' }] }] } });
        expect(prepared.ready).toBe(true);
        expect(prepared.capturedTeamReadiness?.selections).toHaveLength(1);
        selection = prepared.capturedTeamReadiness!.selections![0]!;
        expect(selection.draft).toEqual({ providerId: 'opencode', target: { kind: 'lead' }, workspace: f.workspace });
      } else {
        selection = { launchId: view.source.sourceId, rosterRevision: view.source.rosterRevision,
          memberId: 'alice-id', model: 'test-provider/TEST-model' };
        const deadline = Date.now() + 100000;
        await invoke({ handle, commandId: 'TEST-old-probe', operation: 'team.launch.probe.start', payload: selection },
          { remainingMs: () => deadline - Date.now() });
        const selected = f.runtime.captureLaunchModelProbe(teamId, selection, 'read');
        await f.management.probes.awaitPrepared(probeCommand, selected.context);
        expect(f.management.probes.readRetainedProbe(probeCommand, selected.context)).toMatchObject({
          phase: 'completed', ok: true, resourceHeld: false });
      }
      const expected = { expectedRevision: roster.revision, savedSettings: { ...roster.savedSettings!, prompt: 'TEST_UI_BOOT' }, members: [] };
      f.team.connection.replaceRoster({ commandId: 'TEST-roster-CAS', ...expected });
      const capture = () => f.runtime.executeLaunch(teamId, 'capture', 'TEST-capture', { rosterCommandId: 'TEST-roster-CAS' }, {
        preparationId: 'TEST-preparation', remainingMs: 90000, probes: [{ commandId: probeCommand, selection }],
        roster: { commandId: 'TEST-roster-CAS', expected } });
      if (prospective) {
        await capture();
        expect(f.team.owner.runtimeCaptures(f.profile.principalId)).toHaveLength(1);
      } else {
        await expect(capture()).rejects.toMatchObject({ code: 'held' });
        expect(f.team.owner.runtimeCaptures(f.profile.principalId)).toEqual([]);
      }
      const effects = (await readFile(join(f.scope, 'effects.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(effects.filter(row => row.event === 'input')).toEqual([expect.objectContaining({ marker: 'TEST_MODEL_PROBE' })]);
      expect(effects.filter(row => row.event === 'launch')).toHaveLength(1);
      expect(effects.some(row => row.event === 'failure' || row.event === 'connected')).toBe(false);
    } finally { await f.close(); }
  }
});

/** The source gate's aggregate route: original capture, then original action readiness. */
it('captured OpenCode bare Start stays held while its original aggregate probe permits one Runtime without replay', {
  skip: process.platform === 'win32', timeout: 45000,
}, async () => {
  for (const prepared of [false, true]) {
    const f = await fixture({ runtimeEnabled: true, projectConfiguration: false });
    try {
      const teamId = f.team.definition.binding.teamId, handleId = 'TEST-action-handle', contextId = 'local';
      const roster = f.team.connection.readRoster(), rosterCommandId = 'TEST-action-roster';
      f.team.connection.replaceRoster({ commandId: rosterCommandId, expectedRevision: roster.revision,
        savedSettings: roster.savedSettings!, members: [] });
      const view = projectLaunchConfiguration(await f.runtime.executeLaunch(teamId, 'capture',
        'TEST-action-capture', { rosterCommandId }));
      const payload = { launchId: view.launch.launchId, rosterRevision: view.launch.rosterRevision };
      const commandId = 'TEST-action-start', budget = captureRequestReadinessBudget(15000);
      expect(f.runtime.readModelReadinessCapture(teamId, payload)).toBeNull();
      expect(view.launch.admission).toBeUndefined();
      expect(view.launch.members).toHaveLength(1);
      expect(view.launch.members[0]).toMatchObject({ memberId: 'alice-id', status: 'not-started' });
      expect(view.members[0]?.selected).toMatchObject({
        provider: 'opencode', workspace: f.workspace, model: 'TEST-model',
      });
      const store = new TeamOwnerStore(f.profile.owner.storageRoot, f.team.definition.binding.teamName);
      const original = store.read<TeamLaunchRecord>('launches/' + runtimeDigest(payload.launchId) + '.json');
      assert.ok(original?.definition.capture);
      const effectsPath = join(f.scope, 'effects.ndjson');
      if (!prepared) {
        await expect(f.runtime.executeLaunch(teamId, 'start', commandId, payload)).rejects.toMatchObject({ code: 'held' });
        await expect(readFile(effectsPath)).rejects.toMatchObject({ code: 'ENOENT' });
        continue;
      }
      const approvalPath = join(f.root, 'TEST-private-network-approvals.json');
      const origin = await captureLocalModelReadinessOrigin({ kind: 'team', owner: f.profile.owner,
        contextId, commandId, selection: { handleId, scope: f.team.definition.scope, payload },
        workspaces: [f.workspace], targets: [{ workspace: f.workspace,
          providerId: parseOpenCodeQualifiedModelRef(view.members[0]!.selected!.model)?.sourceId ?? null }],
        current() { /* One original TEST owner remains current until cleanup. */ }, budget,
        home: join(f.scope, 'home'), environment: { ...f.profile.runtime!.members[0]!.environment },
        readApprovals: new JsonLocalProviderPrivateNetworkApprovalStore(approvalPath).capture() });
      await f.runtime.executeLaunch(teamId, 'start', commandId, payload, {
        preparation: readinessPreparationWire(createReadinessPreparation(origin, budget)),
        owner: f.profile.owner, handleId, scope: f.team.definition.scope });
      const read = async () => {
        const value = await f.runtime.execute(teamId, 'read', { memberId: 'alice-id' }, 'TEST-action-ready');
        assert.ok(value && typeof value === 'object' && !Array.isArray(value));
        return value as Record<string, unknown>;
      };
      const deadline = performance.now() + 15000;
      let runtime = await read();
      assert.ok(performance.now() < deadline, 'Original finite Runtime observation budget');
      while (runtime.nativeReady !== true) {
        assert.ok(performance.now() < deadline, 'Original finite Runtime readiness budget');
        await delay(Math.min(25, Math.max(0, deadline - performance.now())));
        runtime = await read();
        assert.ok(performance.now() < deadline, 'Original finite Runtime observation budget');
      }
      const receipt = readEmulatedSourceActionProbe({ profile: f.profile, team: 0, handleId, contextId,
        commandId, payload, fingerprint: original.fingerprint, captureDigest: runtimeDigest(original.definition.capture) });
      expect(receipt).toMatchObject({ phase: 'completed', ok: true, resourceHeld: false });
      const beforeReplay = await readFile(effectsPath, 'utf8');
      const effects: Record<string, unknown>[] = beforeReplay.trim().split('\n').map(line => JSON.parse(line));
      const probes = effects.filter(row => row.event === 'input');
      expect(effects.filter(row => row.event === 'launch')).toHaveLength(2);
      expect(probes).toEqual([expect.objectContaining({ role: 'runtime', marker: 'TEST_MODEL_PROBE' })]);
      expect(effects.filter(row => row.event === 'terminal')).toEqual([
        expect.objectContaining({ pid: probes[0]!.pid, marker: 'TEST_MODEL_PROBE', outcome: 'succeeded' }),
      ]);
      expect(effects.filter(row => row.event === 'connected')).toHaveLength(1);
      expect(effects.some(row => row.event === 'connected' && row.pid === probes[0]!.pid)).toBe(false);
      expect(effects.some(row => row.event === 'failure')).toBe(false);
      await f.runtime.executeLaunch(teamId, 'start', commandId, payload);
      expect(await readFile(effectsPath, 'utf8')).toBe(beforeReplay);
      expect(f.runtime.readModelReadinessCapture(teamId, payload)).toBeNull();
      assert.equal(typeof runtime.generation, 'string');
      await f.runtime.execute(teamId, 'stop', { memberId: 'alice-id', expectedGeneration: runtime.generation }, 'TEST-action-stop');
      expect(await read()).toMatchObject({ phase: 'closed', custody: 'released', nativeReady: false });
      await expect(readFile(approvalPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(f.workspace, 'opencode.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await f.close(); }
  }
});
