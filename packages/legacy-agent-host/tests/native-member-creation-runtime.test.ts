import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { CapturedClaudeMcpCatalogReader } from '../dist/mcp-catalog/captureClaudeCatalog.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RuntimeTeamCoordinator } from '../dist/composition/RuntimeTeamCoordinator.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { normalizeBinding } from '../dist/runtime/identity.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createTeamMcpTools } from '../dist/mcp/tools.js';
import { initialContextDigest } from '../dist/team-launch/context.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import type { Event, Input, Session } from '@agent-teams/provider-session-contracts';
import type { TestContext } from 'node:test';
import type { RuntimeMemberProfile } from '../dist/composition/runtimeProfile.js';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { HostedTeam } from '../dist/composition/MemberEntry.js';
import type { MemberProviderContext } from '../dist/adapters/providers/MemberProvider.js';
import type { OwnerState } from '../dist/team/ownerState.js';
import type { TeamLaunchRecord } from '../dist/team-launch/contracts.js';
import type { NativeMemberModelPreflight } from '../dist/composition/createRuntimeNativeMemberCreation.js';

class ControlledSession implements Session {
  readonly sessionRef: string;
  readonly submits: Input[] = [];
  private done = false;
  private waiting: ((r: IteratorResult<Event>) => void) | undefined;
  constructor(id: string) {
    this.sessionRef = `TEST-controlled-${id}`;
  }
  observe = (): AsyncIterable<Event> => ({
    [Symbol.asyncIterator]: () => ({
      next: () =>
        this.done
          ? Promise.resolve({ done: true, value: undefined })
          : new Promise((resolve) => {
              this.waiting = resolve;
            }),
    }),
  });
  submit: Session['submit'] = async (input) => {
    this.submits.push(input);
    return {
      ok: true,
      value: {
        inputId: input.inputId,
        operationRef: input.operationRef,
        delivery: 'client-consumed',
        providerAcceptance: 'unknown',
      },
    };
  };
  interrupt: Session['interrupt'] = async () => ({
    ok: false,
    code: 'unsupported',
  });
  respondToInteraction: Session['respondToInteraction'] = async () => ({
    ok: false,
    code: 'unsupported',
  });
  checkpoint: Session['checkpoint'] = () => ({
    ok: false,
    code: 'unsupported',
  });
  checkReadiness: Session['checkReadiness'] = async () => ({
    ok: true,
    value: undefined,
  });
  close: Session['close'] = async () => {
    this.done = true;
    this.waiting?.({ done: true, value: undefined });
    return { logicallyClosed: true, cleanup: 'confirmed' };
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await tick();
  }
  assert.fail('controlled fixture did not settle');
}

async function fixture(
  t: TestContext,
  preflight?: NativeMemberModelPreflight,
  crossProviderMcp = false
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-native-create-runtime-')));
  const binding = {
    backendId: 'TEST-backend',
    teamId: 'TEST-team',
    teamName: 'test-native-create-runtime',
  };
  const members = ['lead', 'peer'].map((name) => ({
    memberId: name,
    name,
    role: name === 'lead' ? ('lead' as const) : ('member' as const),
    delivery: {
      ...binding,
      runId: 'TEST-run',
      memberId: name,
      generation: '1',
    },
  }));
  const grants = [
    {
      principalId: 'human',
      memberName: 'user',
      permissions: ['read', 'task.write', 'message.write', 'admin'] as const,
    },
    ...members.map((member) => ({
      principalId: `native-${member.name}`,
      memberName: member.name,
      permissions: ['read', 'task.write', 'message.write', 'process.write'] as const,
    })),
  ].map((row) => ({ ...row, permissions: [...row.permissions] }));
  const savedSettings = {
    cwd: root,
    providerId: 'anthropic' as const,
    model: 'TEST-saved-model',
  };
  let coordinator: RuntimeTeamCoordinator;
  const owner = createFilesystemTeamOwner({
    root,
    binding,
    members,
    grants,
    savedSettings,
    assertRosterEditable: (members) => coordinator.assertRosterEditable(binding.teamId, members),
  });
  const team: HostedTeam = {
    operatorPrincipalId: 'human',
    definition: {
      binding,
      members,
      grants,
      savedSettings,
      scope: {
        projectId: 'TEST-project',
        workspaceId: 'TEST-workspace',
        ...binding,
        runId: 'TEST-run',
        memberId: 'TEST-host',
        generation: '1',
      },
    },
    owner,
    connection: owner.connect('human'),
  };
  const leadProject = join(root, 'TEST-original-lead-project');
  const leadCatalog = join(root, 'TEST-original-lead-catalog.json');
  const targetCatalog = join(root, 'TEST-target-ambient-catalog.json');
  const externalA = {
    'TEST-external-A': { type: 'stdio' as const, command: '/TEST/never-executed-A' },
  };
  if (crossProviderMcp) {
    mkdirSync(leadProject);
    writeFileSync(leadCatalog, JSON.stringify({ mcpServers: externalA }));
    writeFileSync(
      targetCatalog,
      JSON.stringify({ mcpServers: { 'TEST-ambient-B': { command: '/TEST/never-executed-B' } } })
    );
  }
  const profiles = members.map((member) => ({
    provider: 'claude' as const,
    teamId: binding.teamId,
    memberId: member.memberId,
    principalId: `native-${member.name}`,
    sessionId: member.name,
    generation: 1,
    configRevision: 'TEST-config',
    model: 'TEST-model',
    accountBinding: 'TEST-original-account',
    cwd: crossProviderMcp ? leadProject : join(root, 'TEST-lead-worktree-profile'),
    ...(crossProviderMcp
      ? {
          capturedMcpServers: externalA,
          capturedMcpSource: { userConfigPath: leadCatalog, projectPath: leadProject },
          mcpCatalogSource: { claudeConfigPath: leadCatalog },
        }
      : {}),
    environment: { HOME: root },
    executable: { path: join(root, 'TEST-never-run'), sha256: 'a'.repeat(64) },
    nativeTools: [],
    autoAllowedTools: [],
    limits: {
      queuedInputs: 8,
      inputBytes: 65536,
      outputBytes: 65536,
      outputEvents: 100,
      pendingInteractions: 4,
      timeoutMs: 10000,
    },
  }));
  const template = {
    ...profiles[0]!,
    cwd: join(root, 'TEST-template-cwd'),
    accountBinding: 'TEST-template-account',
    environment: { HOME: root, TEST_CAPTURE: 'preserved' },
    capturedMcpServers: {},
  };
  const {
    nativeTools: _nativeTools,
    autoAllowedTools: _autoAllowedTools,
    ...targetCommon
  } = template;
  const targetTemplate: RuntimeMemberProfile = crossProviderMcp
    ? {
        ...targetCommon,
        provider: 'opencode',
        protocolRevision: '1.19.4',
        endpoint: 'http://127.0.0.1:1',
        environment: {
          ...template.environment,
          XDG_CONFIG_HOME: root,
          XDG_DATA_HOME: root,
          XDG_CACHE_HOME: root,
        },
        nativeOptions: {
          providerId: 'TEST-target-provider',
          agent: 'build',
          toolApprovalMode: 'manual',
        },
        capturedMcpServers: {
          'TEST-ambient-B': { type: 'stdio', command: '/TEST/never-executed-B' },
        },
        mcpCatalogSource: { claudeConfigPath: targetCatalog },
        capturedMcpSource: { userConfigPath: targetCatalog, projectPath: root },
      }
    : template;
  const profile: TeamHostProfile = {
    schemaVersion: 1,
    owner: {
      ownerId: binding.backendId,
      revision: '1',
      storageRoot: root,
      profileId: 'TEST-profile',
      protocolVersion: 1,
      buildId: 'TEST-build',
      nodeSha256: 'a'.repeat(64),
      hostEntrySha256: 'b'.repeat(64),
    },
    principalId: 'human',
    teams: [team.definition],
    runtime: { members: profiles, providerTemplates: [targetTemplate] },
  };
  const contexts: MemberProviderContext[] = [],
    sessions: ControlledSession[] = [];
  let probe = 0;
  const store = new TeamOwnerStore(root, binding.teamName);
  let path = `launches/${runtimeDigest('TEST-run')}.json`;
  const create = () =>
    new RuntimeTeamCoordinator({
      profile,
      teams: new Map([[binding.teamId, team]]),
      assertWriter() {},
      nativeMemberModelPreflight: async (input) => {
        probe++;
        input.assertCurrent();
        const expected = store.read<TeamLaunchRecord>(path)!;
        assert.equal(
          expected.nativeAdditions?.length,
          1,
          'expected same-launch binding exists before model preflight'
        );
        assert.equal(expected.members.at(-1)?.attempts[0]?.claimed, false);
        assert.ok(store.read<OwnerState>('state.json')!.members.at(-1)?.delivery);
        await preflight?.(input);
        input.assertCurrent();
      },
      createProvider(context) {
        contexts.push(context);
        const session = new ControlledSession(context.profile.sessionId);
        sessions.push(session);
        return {
          factory: {
            async open() {
              assert.equal(context.canAllocate(), true);
              return {
                driver: session,
                capabilities: [...context.request.requiredCapabilities],
              };
            },
          },
          isReady: context.isCurrent,
          initialContextEvidence: () => ({
            kind: 'native-configuration',
            contextDigest: initialContextDigest(context.instructions),
            generation: context.endpoint.binding.generation,
            configRevision: context.request.configRevision,
          }),
          seal() {},
          async cleanup() {
            return true;
          },
        };
      },
    });
  coordinator = create();
  t.after(async () => {
    await coordinator.close();
    rmSync(root, { recursive: true, force: true });
  });
  if (!crossProviderMcp) {
    team.connection.replaceRoster({
      commandId: 'TEST-saved-roster',
      expectedRevision: team.connection.readRoster().revision,
      members: [{ name: 'peer' }],
    });
    await coordinator.executeLaunch(binding.teamId, 'capture', 'TEST-original-capture', {
      rosterCommandId: 'TEST-saved-roster',
    });
  }
  const launch = coordinator.executeLaunch(binding.teamId, 'read', 'TEST-read', {}) as unknown as {
    launchId: string;
    rosterRevision: string;
  };
  path = `launches/${runtimeDigest(launch.launchId)}.json`;
  await coordinator.executeLaunch(binding.teamId, 'start', 'TEST-original-start', {
    launchId: launch.launchId,
    rosterRevision: launch.rosterRevision,
  });
  await until(() => contexts.length === 2 && contexts.every((context) => context.canAllocate()));
  team.connection.execute({
    commandId: 'TEST-lead-DO',
    operation: 'message.send',
    payload: { to: 'lead', text: 'TEST original DO', actionMode: 'do' },
  });
  coordinator.kick();
  await until(() => sessions[0]!.submits.length === 1);
  const tool = createTeamMcpTools(contexts[0]!.connection);
  const input = {
    commandId: 'TEST-native-create',
    expectedRosterRevision: team.connection.readRoster().revision,
    member: {
      name: 'newcomer',
      providerId: crossProviderMcp ? 'opencode' : 'anthropic',
      model: 'TEST-selected-model',
      role: 'TEST descriptive role',
      workflow: 'TEST standing workflow',
    },
  };
  return {
    root,
    leadProject,
    leadCatalog,
    targetCatalog,
    externalA,
    team,
    owner,
    store,
    path,
    contexts,
    sessions,
    tool,
    input,
    profile,
    probe: () => probe,
    coordinator: () => coordinator,
    async cold() {
      await coordinator.close();
      coordinator = create();
      return coordinator;
    },
  };
}

test('finite MCP create uses original Session DO, same launch and factory; peers survive, reminders wait for real input, cold never allocates', async (t) => {
  const f = await fixture(t),
    before = f.store.read<TeamLaunchRecord>(f.path)!,
    peer = f.contexts[1]!,
    peerSession = f.sessions[1]!;
  const originalPeer = structuredClone(f.store.read<OwnerState>('state.json')!.members[1]);
  const result = await f.tool.callAsync('team_member_create', f.input);
  assert.equal(result.isError, undefined);
  assert.equal(f.contexts.length, 3);
  assert.equal(f.probe(), 1);
  const target = f.contexts[2]!;
  assert.equal(target.profile.cwd, f.root, 'canonical team root, never lead/template cwd');
  assert.equal(target.profile.accountBinding, 'TEST-template-account');
  assert.equal(target.profile.environment.TEST_CAPTURE, 'preserved');
  assert.equal(target.profile.model, 'TEST-selected-model');
  assert.match(target.instructions, /member/);
  assert.equal(
    target.profile.provider === 'claude' &&
      target.profile.nativeOptions?.projectInstructions?.append?.includes('TEST descriptive role'),
    true
  );
  assert.equal(target.canAllocate(), true);
  assert.equal(peer.canAllocate(), true);
  assert.deepEqual(f.store.read<OwnerState>('state.json')!.members[1], originalPeer);
  assert.deepEqual(f.store.read<TeamLaunchRecord>(f.path)!.members[1], before.members[1]);
  assert.equal(peerSession.submits.length, 0);
  assert.equal(f.sessions[2]!.submits.length, 0, 'creation never sends an initial input');
  const duplicate = await f.tool.callAsync('team_member_create', f.input);
  assert.deepEqual(duplicate, result);
  assert.equal(f.contexts.length, 3);
  assert.equal(f.probe(), 1);
  const epochs = f.store.read<OwnerState>('state.json')!.contextEpochs!;
  assert.equal(epochs.filter((row) => row.sourceRef.startsWith('native-roster:')).length, 2);
  f.team.connection.execute({
    commandId: 'TEST-peer-real-input',
    operation: 'message.send',
    payload: { to: 'peer', text: 'TEST real peer input' },
  });
  f.coordinator().kick();
  await until(() => peerSession.submits.length === 1);
  assert.match(String(peerSession.submits[0]!.content), /newcomer/);
  assert.match(String(peerSession.submits[0]!.content), /TEST real peer input/);
  // Completing the creating input cannot revoke the newly installed target's lifetime.
  const leadBinding = normalizeBinding(f.contexts[0]!.endpoint.binding);
  new FileRuntimeStore(f.root).fenced(leadBinding, (tx) => {
    const record = tx.get()!;
    record.inputs[0]!.phase = 'terminal';
    record.inputs[0]!.terminal = 'succeeded';
    tx.put(record);
  });
  f.team.connection.execute({
    commandId: 'TEST-newcomer-real-input',
    operation: 'message.send',
    payload: { to: 'newcomer', text: 'TEST newcomer real input' },
  });
  f.coordinator().kick();
  await until(() => f.sessions[2]!.submits.length === 1);
  assert.equal(target.canAllocate(), true);
  assert.match(String(f.sessions[2]!.submits[0]!.content), /TEST newcomer real input/);
  await f.cold();
  assert.equal(f.contexts.length, 3, 'cold metadata reconstruction must never open Sessions');
  assert.equal(
    f.owner.nativeRoster.nativeCreation().retained('human')[0]?.nativeCreation.phase,
    'completed'
  );
  const cold = f
    .coordinator()
    .executeLaunch('TEST-team', 'read', 'TEST-cold-read', {}) as unknown as {
    expected: number;
  };
  assert.equal(cold.expected, 3);
  assert.equal(
    f.coordinator().hasCurrentCapture('TEST-team'),
    true,
    'explicit native successor retains the same original active capture'
  );
});

test('original lead grant revoked during asynchronous model preflight cannot reach target factory or fall back to human admin', async (t) => {
  const f = await fixture(t, async () => {
    await Promise.resolve();
    revoke();
  });
  const revoke = () =>
    f.store.fenced(() => {
      const state = f.store.read<OwnerState>('state.json')!;
      state.grants.find((row) => row.principalId === f.contexts[0]!.profile.principalId)!.revoked =
        true;
      f.store.write('state.json', state);
    });
  await assert.rejects(f.tool.callAsync('team_member_create', f.input));
  assert.equal(f.probe(), 1);
  assert.equal(f.contexts.length, 2);
  assert.equal(
    f.team.connection.readRoster().members.length,
    3,
    'original expected canonical member remains queryable'
  );
  assert.equal(f.store.read<TeamLaunchRecord>(f.path)!.members.at(-1)?.attempts[0]?.claimed, false);
  assert.equal(f.contexts[1]!.canAllocate(), true, 'unrelated peer binding/grant survives');
  await f.cold();
  const retained = f.owner.nativeRoster.nativeCreation().retained('human')[0]!;
  assert.equal(retained.nativeCreation.phase, 'configured');
  await assert.rejects(
    f.coordinator().execute('TEST-team', 'open', {
      memberId: retained.nativeCreation.member.memberId,
    })
  );
  assert.equal(f.contexts.length, 2, 'cold human open cannot replay the original native creation');
});

test('active actual ASK and nonlead DO refuse; finite schema rejects prompt/workspace/authority aliases before canonical mutation', async (t) => {
  const f = await fixture(t),
    before = f.store.read<OwnerState>('state.json')!;
  for (const extra of [
    { prompt: 'no initial prompt' },
    { cwd: f.root },
    { isolation: 'worktree' },
    { inputId: 'pretend-input' },
  ])
    await assert.rejects(f.tool.callAsync('team_member_create', { ...f.input, ...extra }));
  f.team.connection.execute({
    commandId: 'TEST-peer-DO',
    operation: 'message.send',
    payload: { to: 'peer', text: 'TEST peer DO', actionMode: 'do' },
  });
  f.coordinator().kick();
  await until(() => f.sessions[1]!.submits.length === 1);
  await assert.rejects(
    createTeamMcpTools(f.contexts[1]!.connection).callAsync('team_member_create', f.input)
  );
  const binding = normalizeBinding(f.contexts[0]!.endpoint.binding);
  new FileRuntimeStore(f.root).fenced(binding, (tx) => {
    const record = tx.get()!;
    record.inputs[0]!.phase = 'terminal';
    record.inputs[0]!.terminal = 'succeeded';
    tx.put(record);
  });
  f.team.connection.execute({
    commandId: 'TEST-lead-ASK',
    operation: 'message.send',
    payload: { to: 'lead', text: 'TEST actual ASK', actionMode: 'ask' },
  });
  f.coordinator().kick();
  await until(() => f.sessions[0]!.submits.length === 2);
  await assert.rejects(f.tool.callAsync('team_member_create', f.input));
  assert.deepEqual(f.store.read<OwnerState>('state.json')!.members, before.members);
  assert.equal(f.contexts.length, 2);
  assert.equal(f.probe(), 0);
});

test('cross-provider creation inherits original lead A and original locator; target ambient B is never read and target native policy/account stay independent', async (t) => {
  const f = await fixture(t, undefined, true);
  let ambientReads = 0;
  const read = CapturedClaudeMcpCatalogReader.prototype.readCatalog;
  t.mock.method(
    CapturedClaudeMcpCatalogReader.prototype,
    'readCatalog',
    function (
      this: CapturedClaudeMcpCatalogReader,
      options: Parameters<CapturedClaudeMcpCatalogReader['readCatalog']>[0]
    ) {
      if (options.userConfigPath === f.targetCatalog) {
        ambientReads++;
        throw new Error('TEST ambient target catalog read forbidden');
      }
      return read.call(this, options);
    }
  );
  await f.tool.callAsync('team_member_create', f.input);
  const target = f.contexts[2]!.profile,
    lead = f.contexts[0]!.profile;
  assert.equal(target.provider, 'opencode');
  assert.deepEqual(target.capturedMcpServers, f.externalA);
  assert.deepEqual(target.capturedMcpSource, lead.capturedMcpSource);
  assert.equal(target.capturedMcpSource?.projectPath, f.leadProject);
  assert.equal(target.cwd, f.root);
  assert.notEqual(target.cwd, target.capturedMcpSource?.projectPath);
  assert.equal(target.accountBinding, 'TEST-template-account');
  assert.equal(target.environment.TEST_CAPTURE, 'preserved');
  assert.ok(target.provider === 'opencode' && target.mcpPolicyPlugin);
  assert.equal(
    target.provider === 'opencode' && target.nativeOptions.providerId,
    'TEST-target-provider'
  );
  assert.equal(
    'capturedMcpCatalog' in target,
    false,
    'lead native catalog must never become target native census'
  );
  assert.equal(ambientReads, 0);
});

test('lead MCP source changing A to C during native model preflight holds before target allocation, preserving original A in its receipt', async (t) => {
  const f = await fixture(
    t,
    async () => {
      await Promise.resolve();
      writeFileSync(
        f.leadCatalog,
        JSON.stringify({ mcpServers: { 'TEST-new-C': { command: '/TEST/never-executed-C' } } })
      );
    },
    true
  );
  let ambientReads = 0;
  const read = CapturedClaudeMcpCatalogReader.prototype.readCatalog;
  t.mock.method(
    CapturedClaudeMcpCatalogReader.prototype,
    'readCatalog',
    function (
      this: CapturedClaudeMcpCatalogReader,
      options: Parameters<CapturedClaudeMcpCatalogReader['readCatalog']>[0]
    ) {
      if (options.userConfigPath === f.targetCatalog) {
        ambientReads++;
        throw new Error('TEST ambient target catalog read forbidden');
      }
      return read.call(this, options);
    }
  );
  await assert.rejects(f.tool.callAsync('team_member_create', f.input));
  assert.equal(f.contexts.length, 2, 'source change must precede target factory admission');
  assert.equal(ambientReads, 0);
  assert.equal(f.store.read<TeamLaunchRecord>(f.path)!.members.at(-1)?.attempts[0]?.claimed, false);
  const original = f.owner.nativeRoster.nativeCreation().retained('human')[0]!;
  assert.equal(original.nativeCreation.phase, 'held');
  assert.deepEqual(
    f.contexts[0]!.profile.capturedMcpServers,
    f.externalA,
    'original snapshot must never be recaptured as C'
  );
});
