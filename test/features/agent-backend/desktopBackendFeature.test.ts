// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';

import {
  AGENT_BACKEND_CONNECTIONS_CHANNEL,
  AGENT_BACKEND_CONNECTIONS_ROUTE,
  AGENT_BACKEND_INVOKE_CHANNEL,
} from '../../../src/features/agent-backend/contracts';
import {
  DesktopBackendFeature,
  FileHandleBindingStore,
  loadDesktopBackendDescriptor,
  registerAgentBackendIpc,
  registerBackendConnectionsHttp,
  registerBackendConnectionsIpc,
} from '../../../src/features/agent-backend/main';
import { JsonLocalProviderPrivateNetworkApprovalStore } from '../../../src/features/runtime-provider-management/main';
import { setAppDataBasePath } from '../../../src/main/utils/pathDecoder';
import { clearShellEnvCache } from '../../../src/main/utils/shellEnv';

import type {
  BackendConnectionSnapshot,
  BackendOperationRequest,
} from '../../../src/features/agent-backend/contracts';
import type {
  DesktopBackendDescriptor,
  DesktopBackendDescriptorSelection,
  HandleBindingStore,
  SelectedHostProfile,
} from '../../../src/features/agent-backend/main';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { LocalModelReadinessContext } from '../../../src/features/agent-backend/main/infrastructure/CapturedLocalModelReadiness';

const roots: string[] = [];
const features: DesktopBackendFeature[] = [];
let native: Pick<SelectedHostProfile, 'nodeExecutable' | 'nodeVersion' | 'nodeSha256'>;
let serverUrl: string;
beforeAll(async () => {
  const nodeExecutable = await realpath(process.env.AGENT_BACKEND_TEST_NODE ?? process.execPath);
  native = {
    nodeExecutable,
    nodeVersion: execFileSync(nodeExecutable, ['--version'], { env: {}, encoding: 'utf8' }).trim(),
    nodeSha256: createHash('sha256')
      .update(await readFile(nodeExecutable))
      .digest('hex'),
  };
  serverUrl = execFileSync(
    nodeExecutable,
    [
      '--input-type=module',
      '-e',
      'process.stdout.write(import.meta.resolve("@agent-teams/legacy-agent-host"))',
    ],
    { env: {}, cwd: process.cwd(), encoding: 'utf8' }
  );
});
afterEach(async () => {
  await Promise.all(features.splice(0).map((feature) => feature.shutdown()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'TEST-desktop-backend-')));
  roots.push(path);
  return path;
}
async function selected(value: unknown): Promise<DesktopBackendDescriptorSelection> {
  const path = join(await root(), 'descriptor.json');
  const bytes = JSON.stringify(value);
  await writeFile(path, bytes, { mode: 0o600 });
  return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
}
async function fixture(blockStartup = false): Promise<{
  descriptor: DesktopBackendDescriptor;
  bindingDirectory: string;
}> {
  const owners: DesktopBackendDescriptor['owners'][number][] = [];
  for (const ownerId of ['A', 'B']) {
    const storageRoot = await root();
    const hostEntry = join(storageRoot, 'host.mts');
    const source = `import { createHostServer } from ${JSON.stringify(serverUrl)};
      import { writeFileSync, appendFileSync, existsSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(storageRoot, 'started'))}, 'started');
      if (${blockStartup}) await new Promise(resolve=>{
        const timer=setInterval(()=>{if(existsSync(${JSON.stringify(join(storageRoot, 'release-startup'))})){clearInterval(timer);resolve();}},10);
      });
      const server = createHostServer({ input: process.stdin, output: process.stdout, buildId:'TEST-desktop-v1', methods: {
        'team.execute': { lane:'work', handle: (request) => {
          appendFileSync(${JSON.stringify(join(storageRoot, 'effects'))}, request.commandId+'\\n');
          return {ok:true,value:{commandId:request.commandId,phase:'completed',command:{commandId:request.commandId,...request.payload},effects:{taskId:'task-1'},result:{id:'task-1',status:'pending',subject:${JSON.stringify(ownerId)}}}};
        }},
        'team.crossTeam.send': { lane:'work', handle: (request) => {
          appendFileSync(${JSON.stringify(join(storageRoot, 'pair-effects'))}, JSON.stringify(request)+'\\n');
          return {ok:true,value:{kind:'cross-team-receipt',commandId:request.commandId,
            messageId:request.payload.request.messageId,conversationId:'TEST-conversation',
            toMember:'lead',phase:'completed',deduplicated:false}};
        }},
        'team.lifecycle.retired.read': { lane:'control', handle: () => ({ok:true,value:{teamIds:[]}}) },
        'team.launch.configuration.read': { lane:'control', handle: (request) => {
          appendFileSync(${JSON.stringify(join(storageRoot, 'launch-reads'))}, request.commandId+'\\n');
          return {ok:true,value:{launch:{launchId:request.payload.launchId,rosterRevision:'roster-1',
            status:'pending',ready:0,expected:1,retryCapability:'same-binding-no-allocation-only',
            members:[{memberId:'member-1',binding:null,attempt:{attemptId:'attempt-1',status:'not-started',
              nativeReady:false,usable:false,controlAvailable:false,noAllocation:true,reason:'not-started'}}]},
            members:[{memberId:'member-1',label:'Worker',role:'lead',selected:{provider:'opencode',
              workspace:${JSON.stringify(storageRoot)},model:'home-server/TEST-model',capabilities:['model']}}]}};
        }},
        'team.launch.probe.start': { lane:'work', handle: (request) => {
          appendFileSync(${JSON.stringify(join(storageRoot, 'probe-requests'))}, JSON.stringify(request)+'\\n');
          return {ok:true,value:{...request.payload,commandId:request.commandId,phase:'completed',ok:true,
            expiresAt:Date.now()+90000}};
        }},
        'team.creation.prepare': { lane:'work', handle: (request) => ({ok:true,value:{
          preparationId:request.payload.preparationId,draftDigest:'a'.repeat(64),ready:true,
          probes:[{memberName:'team-lead',commandId:request.commandId,model:'TEST-model',
            phase:'completed',ok:true,expiresAt:Date.now()+90000}]}}) },
        'management.catalog': {lane:'work', handle:(request)=>{
          appendFileSync(${JSON.stringify(join(storageRoot, 'management-effects'))},JSON.stringify({profileId:request.profileId,configRevision:request.configRevision})+${JSON.stringify('\n')});
          return {ok:true,value:{profileId:request.profileId,configRevision:request.configRevision,providers:[]}};
        }} }});
      void server.closed.then(()=>process.exit(0));`;
    await writeFile(hostEntry, source);
    owners.push({
      ownerId,
      revision: 'v1',
      storageRoot,
      profile: {
        ...native,
        profileId: `TEST-${ownerId}`,
        hostEntry,
        hostEntrySha256: createHash('sha256').update(source).digest('hex'),
        expectedBuildId: 'TEST-desktop-v1',
        cwd: storageRoot,
        env: { HOME: storageRoot, TMPDIR: storageRoot, TEST_PRIVATE_TOKEN: 'TEST-secret-token' },
        startupTimeoutMs: 3000,
        requestTimeoutMs: 1000,
        writeTimeoutMs: 1000,
        shutdownTimeoutMs: 300,
      },
    });
  }
  return {
    bindingDirectory: await root(),
    descriptor: {
      schemaVersion: 1,
      defaultOwner: { ownerId: 'A', revision: 'v1' },
      owners,
      handles: owners.map((owner) => ({
        handleId: `opaque-${owner.ownerId}`,
        owner: { ownerId: owner.ownerId, revision: owner.revision },
        contextId: `context-${owner.ownerId}`,
        label: `Team ${owner.ownerId}`,
        members: [{ memberId: 'member-1', label: 'Worker' }],
        scope: {
          projectId: 'project-1',
          workspaceId: 'workspace-1',
          teamId: `team-${owner.ownerId}`,
          runId: 'run-1',
          memberId: 'member-1',
          generation: 'gen-1',
        },
      })),
    },
  };
}
function feature(
  options: ConstructorParameters<typeof DesktopBackendFeature>[0]
): DesktopBackendFeature {
  const result = new DesktopBackendFeature(options);
  features.push(result);
  return result;
}
function request(handleId: string, commandId: string): BackendOperationRequest {
  return {
    handle: { handleId },
    commandId,
    operation: 'task.create',
    payload: { subject: 'Task' },
  };
}

it('leaves unconfigured mode empty and initializes configured handles without starting either host', async () => {
  const disabled = feature({ descriptor: null, bindingDirectory: await root() });
  await disabled.initialize();
  expect(disabled.listBindings('local')).toEqual({ state: 'unconfigured', bindings: [] });
  const setup = await fixture();
  const desktop = feature({
    descriptor: await selected(setup.descriptor),
    bindingDirectory: setup.bindingDirectory,
  });
  await desktop.initialize();
  expect(desktop.listBindings('context-A')).toEqual({
    state: 'ready',
    bindings: [
      {
        handle: { handleId: 'opaque-A' },
        label: 'Team A',
        members: [{ memberId: 'member-1', label: 'Worker' }],
        ownerResourceRef: expect.stringMatching(/^[a-f0-9]{64}$/),
        teamResourceRef: expect.stringMatching(
          /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
        ),
      },
    ],
  });
  expect(desktop.listBindings('other-context').bindings).toEqual([]);
  expect(desktop.authorizeHandle('context-A', { handleId: 'opaque-B' })).toBe(false);
  for (const owner of setup.descriptor.owners)
    await expect(access(join(owner.storageRoot, 'started'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  const snapshot = JSON.stringify(desktop.listBindings('context-A'));
  expect(snapshot).not.toContain('TEST-secret-token');
  expect(snapshot).not.toContain(setup.descriptor.owners[0].storageRoot);
  expect(snapshot).not.toContain('nodeExecutable');
});

it('captures global and exact project provider scopes without Team handles or default-owner fallback', async () => {
  const setup = await fixture();
  const projectPath = await root();
  const binding = {
    runtimeId: 'opencode' as const,
    owner: { ownerId: 'B', revision: 'v1' },
    contextId: 'auth-context',
    projectPath: null,
    profileId: 'TEST-management-B',
    configRevision: 'TEST-config-B',
  };
  const descriptor = {
    ...setup.descriptor,
    handles: [],
    management: [binding, { ...binding, projectPath }],
  };
  const desktop = feature({
    descriptor: await selected(descriptor),
    bindingDirectory: setup.bindingDirectory,
  });
  await desktop.initialize();
  expect(desktop.listBindings('auth-context')).toEqual({ state: 'ready', bindings: [] });
  await expect(desktop.captureProviderManagement('wrong-context', null)).rejects.toMatchObject({
    code: 'unavailable',
  });
  await expect(
    desktop.captureProviderManagement('auth-context', await root())
  ).rejects.toMatchObject({ code: 'unavailable' });
  const captured = await desktop.captureProviderManagement('auth-context', null);
  const scoped = await desktop.captureProviderManagement('auth-context', projectPath);
  expect(scoped.profileId).toBe(captured.profileId);
  expect(scoped.configRevision).toBe(captured.configRevision);
  expect(scoped.targetId).not.toBe(captured.targetId);
  expect(scoped.isCurrent()).toBe(true);
  expect(captured.targetId).toMatch(/^[a-f0-9]{64}$/);
  const recovered = await desktop.restoreProviderManagement('auth-context', captured.targetId);
  expect(recovered.targetId).toBe(captured.targetId);
  expect(recovered.isCurrent()).toBe(true);
  const foreign = await desktop.restoreProviderManagement('other-context', captured.targetId);
  expect(foreign.isCurrent()).toBe(false);
  await expect(foreign.request('catalog', {})).rejects.toMatchObject({ code: 'forbidden' });
  const replacement = feature({
    descriptor: await selected({
      ...descriptor,
      management: [{ ...binding, configRevision: 'TEST-replacement' }],
    }),
    bindingDirectory: setup.bindingDirectory,
  });
  await expect(
    replacement.restoreProviderManagement('auth-context', captured.targetId)
  ).rejects.toMatchObject({ code: 'unavailable' });
  // Resolving the current source starts only the granted Host; native management remains lazy.
  await expect(access(join(setup.descriptor.owners[0].storageRoot, 'started'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(join(setup.descriptor.owners[1].storageRoot, 'started'))).resolves.toBeUndefined();
  await expect(access(join(setup.descriptor.owners[1].storageRoot, 'management-effects'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await captured.request('catalog', {})).toEqual({
    ok: true,
    value: { profileId: binding.profileId, configRevision: binding.configRevision, providers: [] },
  });
  await expect(
    access(join(setup.descriptor.owners[0].storageRoot, 'started'))
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(
    await readFile(join(setup.descriptor.owners[1].storageRoot, 'management-effects'), 'utf8')
  ).toBe(
    JSON.stringify({ profileId: binding.profileId, configRevision: binding.configRevision }) + '\n'
  );
  expect(JSON.stringify(desktop.listBindings('auth-context'))).not.toContain(binding.profileId);
  await expect(
    loadDesktopBackendDescriptor(await selected({ ...descriptor, management: [binding, binding] }))
  ).rejects.toMatchObject({ code: 'hold' });
});

it('routes paired facade sends through the original captured owner with both immutable bindings', async () => {
  const setup = await fixture();
  const source = setup.descriptor.handles[0]!;
  const destination = {
    ...source,
    handleId: 'opaque-A-target',
    scope: { ...source.scope, teamId: 'team-A-target' },
  };
  const desktop = feature({
    descriptor: await selected({
      ...setup.descriptor,
      handles: [
        ...setup.descriptor.handles,
        destination,
        { ...destination, handleId: 'opaque-other-context', contextId: 'context-B' },
      ],
    }),
    bindingDirectory: setup.bindingDirectory,
  });
  await desktop.initialize();
  const paired = {
    handle: { handleId: source.handleId },
    commandId: 'TEST-pair-command',
    operation: 'crossTeam.send' as const,
    payload: {
      target: { handleId: destination.handleId },
      fromMember: 'user',
      messageId: 'TEST-pair-command',
      text: 'TEST paired send',
    },
  };
  expect(await desktop.facade.invoke(paired)).toMatchObject({
    ok: true,
    value: { kind: 'cross-team-receipt', commandId: paired.commandId, phase: 'completed' },
  });
  const effectsPath = join(setup.descriptor.owners[0]!.storageRoot, 'pair-effects');
  const effects = await readFile(effectsPath, 'utf8');
  const captured = JSON.parse(effects.trim());
  expect(captured.binding).toMatchObject({
    handleId: source.handleId,
    scope: source.scope,
    owner: { ownerId: 'A', revision: 'v1' },
  });
  expect(captured.payload).toEqual({
    request: paired.payload,
    targetBinding: {
      ...captured.binding,
      handleId: destination.handleId,
      scope: destination.scope,
    },
  });
  expect(
    await desktop.facade.invoke({
      ...paired,
      commandId: 'TEST-foreign-pair',
      payload: {
        ...paired.payload,
        messageId: 'TEST-foreign-pair',
        target: { handleId: 'opaque-B' },
      },
    })
  ).toMatchObject({ ok: false });
  expect(
    await desktop.facade.invoke({
      ...paired,
      commandId: 'TEST-other-context',
      payload: {
        ...paired.payload,
        messageId: 'TEST-other-context',
        target: { handleId: 'opaque-other-context' },
      },
    })
  ).toEqual({ ok: false, code: 'forbidden', outcome: 'not-dispatched' });
  expect(await readFile(effectsPath, 'utf8')).toBe(effects);
  await expect(
    access(join(setup.descriptor.owners[1]!.storageRoot, 'started'))
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('uses two lazily captured subprocess hosts and captured context grants for finite IPC operations', async () => {
  const setup = await fixture();
  const desktop = feature({
    descriptor: await selected({ ...setup.descriptor, creation: {
      owner: { ownerId: 'A', revision: 'v1' }, contextIds: ['context-A'],
    } }),
    bindingDirectory: setup.bindingDirectory,
  });
  await desktop.initialize();
  let currentContext = 'context-A';
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = {
    handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn(),
  } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>;
  const trusted = {} as IpcMainInvokeEvent;
  registerAgentBackendIpc(
    ipc,
    desktop.facade,
    (event, operation) =>
      event === trusted && desktop.authorizeHandle(currentContext, operation.handle)
  );
  const invoke = handlers.get(AGENT_BACKEND_INVOKE_CHANNEL)!;
  expect(await invoke(trusted, request('opaque-B', 'denied-B'))).toEqual({
    ok: false,
    code: 'forbidden',
    outcome: 'not-dispatched',
  });
  expect(await invoke(trusted, request('opaque-A', 'command-A'))).toMatchObject({
    ok: true,
    value: { task: { subject: 'A' } },
  });
  currentContext = 'context-B';
  expect(await invoke(trusted, request('opaque-B', 'command-B'))).toMatchObject({
    ok: true,
    value: { task: { subject: 'B' } },
  });
  expect(await invoke(trusted, request('opaque-A', 'stale-context'))).toEqual({
    ok: false,
    code: 'forbidden',
    outcome: 'not-dispatched',
  });
  expect(await readFile(join(setup.descriptor.owners[0].storageRoot, 'effects'), 'utf8')).toBe(
    'command-A\n'
  );
  expect(await readFile(join(setup.descriptor.owners[1].storageRoot, 'effects'), 'utf8')).toBe(
    'command-B\n'
  );

  const originalHome = process.env.HOME, originalUserProfile = process.env.USERPROFILE;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const home = await root(), workspace = setup.descriptor.owners[0].storageRoot;
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
  setAppDataBasePath(home);
  clearShellEnvCache();
  try {
    const configPath = join(workspace, '.opencode', 'opencode.jsonc');
    await mkdir(join(workspace, '.opencode'));
    await writeFile(configPath, JSON.stringify({ provider: { 'home-server': {
      npm: '@ai-sdk/openai-compatible', options: {
        baseURL: 'http://192.168.1.20:8080/v1', apiKey: '{file:/TEST-not-read/secret}',
      },
    } } }));
    await new JsonLocalProviderPrivateNetworkApprovalStore().approve({
      configPath, providerId: 'home-server', baseUrl: 'http://192.168.1.20:8080/v1',
    });
    const probe: BackendOperationRequest = {
      handle: { handleId: 'opaque-A' }, commandId: 'original-probe', operation: 'team.launch.probe.start',
      payload: { launchId: 'launch-1', rosterRevision: 'roster-1', memberId: 'member-1',
        model: 'home-server/TEST-model' },
    };
    currentContext = 'context-A';
    expect(await invoke(trusted, { ...probe, localModelReadinessOrigin: { schemaVersion: 1 } }))
      .toEqual({ ok: false, code: 'invalid', outcome: 'not-dispatched' });
    await expect(access(join(workspace, 'probe-requests'))).rejects.toMatchObject({ code: 'ENOENT' });
    const deadline = performance.now() + 90000;
    expect(await desktop.facade.invoke(probe, {
      isCurrent: () => currentContext === 'context-A',
    }, { remainingMs: () => deadline - performance.now() })).toMatchObject({
      ok: true, value: { commandId: 'original-probe', phase: 'completed', ok: true },
    });
    const raw = await readFile(join(workspace, 'probe-requests'), 'utf8');
    const wire = JSON.parse(raw) as { binding: { scope: { projectId: string } };
      localModelReadinessOrigin: { remainingMs: number; origin: { contextId: string;
        workspaces: { path: string; project: { selectedPath: string; sources: unknown[];
          providers: { hasConfiguredApiKey: boolean }[] }; global: { sources: unknown[] } }[];
        approval: { approved: unknown[] } } } };
    expect(wire.binding.scope.projectId).toBe('project-1');
    expect(wire.localModelReadinessOrigin.origin.contextId).toBe('context-A');
    expect(wire.localModelReadinessOrigin.remainingMs).toBeGreaterThan(0);
    expect(wire.localModelReadinessOrigin.remainingMs).toBeLessThan(90000);
    expect(wire.localModelReadinessOrigin.origin.workspaces).toMatchObject([{
      path: workspace, project: { selectedPath: configPath, sources: expect.any(Array),
        providers: [{ hasConfiguredApiKey: true }] },
    }]);
    expect(wire.localModelReadinessOrigin.origin.workspaces[0].project.sources).toHaveLength(4);
    expect(wire.localModelReadinessOrigin.origin.workspaces[0].global.sources).toHaveLength(2);
    expect(wire.localModelReadinessOrigin.origin.approval.approved).toEqual([{
      configPath, providerId: 'home-server', baseUrl: 'http://192.168.1.20:8080/v1',
    }]);
    expect(raw).not.toContain('{file:');
    expect(raw).not.toContain('TEST-secret-token');
    expect(await readFile(join(workspace, 'launch-reads'), 'utf8')).toBe('original-probe:origin\n');

    const view: NonNullable<LocalModelReadinessContext['view']> = {
      launch: { launchId: 'launch-1', rosterRevision: 'roster-1' },
      members: [{ memberId: 'member-1', label: 'Worker', role: 'lead', selected: {
        provider: 'opencode', workspace, model: 'home-server/TEST-model', capabilities: ['model'],
      } }],
    };
    vi.stubEnv('XDG_CONFIG_HOME', join(home, 'different-original-config-root'));
    const saved = desktop.facade.invoke({ ...probe, commandId: 'saved-probe' }, undefined,
      { view, remainingMs: () => deadline - performance.now() });
    view.members[0].selected!.workspace = join(home, 'changed-after-capture');
    expect(await saved).toMatchObject({ ok: true, value: { commandId: 'saved-probe', ok: true } });
    expect(await readFile(join(workspace, 'launch-reads'), 'utf8')).toBe('original-probe:origin\n');
    const savedWire = JSON.parse((await readFile(join(workspace, 'probe-requests'), 'utf8'))
      .trim().split('\n')[1]);
    expect(savedWire.localModelReadinessOrigin.origin.workspaces[0].global).toMatchObject({
      selectedPath: null, selectorFailure: 'config-conflict', invalid: true, providers: [],
    });
    const approvalCapture = vi.spyOn(JsonLocalProviderPrivateNetworkApprovalStore.prototype, 'capture');
    try {
      view.members[0].selected!.provider = 'claude';
      view.members[0].selected!.workspace = workspace;
      expect(await desktop.facade.invoke({ ...probe, commandId: 'claude-probe' }, undefined,
        { view, remainingMs: () => deadline - performance.now() })).toMatchObject({ ok: true });
      const creation = await desktop.captureTeamCreation('context-A', { isCurrent: () => true });
      expect(await creation.prepare('prepare', { preparationId: 'claude-create', draft: {
        contextId: 'context-A', teamName: 'TEST-team', savedSettings: { cwd: workspace, providerId: 'anthropic' }, members: [],
      } })).toMatchObject({ preparationId: 'claude-create', ready: true });
      expect(approvalCapture).not.toHaveBeenCalled();
    } finally { approvalCapture.mockRestore(); }
  } finally {
    vi.stubEnv('HOME', originalHome);
    vi.stubEnv('USERPROFILE', originalUserProfile);
    vi.stubEnv('XDG_CONFIG_HOME', originalXdg);
    setAppDataBasePath(null);
    clearShellEnvCache();
  }
});

it('captures only the explicit supported review transport profile from a private descriptor', async () => {
  const setup = await fixture();
  const withReview = {
    ...setup.descriptor,
    owners: setup.descriptor.owners.map((owner) => ({
      ...owner,
      profile: { ...owner.profile, reviewTransport: 'review-v1' },
    })),
  };
  const parsed = await loadDesktopBackendDescriptor(await selected(withReview));
  expect(parsed.owners.every((owner) => owner.profile.reviewTransport === 'review-v1')).toBe(true);
  const unsupported = {
    ...withReview,
    owners: withReview.owners.map((owner) => ({
      ...owner,
      profile: { ...owner.profile, reviewTransport: 'review-v2' },
    })),
  };
  await expect(loadDesktopBackendDescriptor(await selected(unsupported))).rejects.toMatchObject({
    code: 'hold',
  });
});

it('rejects digest mismatch, symlink/noncanonical path and oversized private descriptor safely', async () => {
  const setup = await fixture();
  const selection = await selected(setup.descriptor);
  await expect(
    loadDesktopBackendDescriptor({ ...selection, sha256: '0'.repeat(64) })
  ).rejects.toMatchObject({ code: 'hold' });
  const alias = join(await root(), 'alias.json');
  await symlink(selection.path, alias);
  await expect(loadDesktopBackendDescriptor({ ...selection, path: alias })).rejects.toMatchObject({
    code: 'hold',
  });
  const oversized = await selected('x'.repeat(256 * 1024));
  await expect(loadDesktopBackendDescriptor(oversized)).rejects.toMatchObject({ code: 'hold' });
  const malformed = await selected({
    ...setup.descriptor,
    owners: [{ ...setup.descriptor.owners[0], profile: { injected: 'TEST-secret-token' } }],
  });
  const desktop = feature({ descriptor: malformed, bindingDirectory: setup.bindingDirectory });
  await desktop.initialize();
  expect(desktop.listBindings('context-A')).toEqual({ state: 'hold', bindings: [] });
});

it('cannot expose or dispatch handles after shutdown races a pending durable binding read', async () => {
  const setup = await fixture();
  const store = new FileHandleBindingStore(setup.bindingDirectory);
  let release!: () => void;
  let signal!: () => void;
  const pending = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bindings: HandleBindingStore = {
    create: (binding) => store.create(binding),
    read: async (id) => {
      signal();
      await gate;
      return store.read(id);
    },
  };
  const desktop = feature({
    descriptor: await selected(setup.descriptor),
    bindingDirectory: setup.bindingDirectory,
    bindings,
  });
  const opening = desktop.initialize();
  await pending;
  const closing = desktop.shutdown();
  release();
  await Promise.all([opening, closing]);
  expect(desktop.listBindings('context-A')).toEqual({ state: 'shutting-down', bindings: [] });
  expect(await desktop.facade.invoke(request('opaque-A', 'after-quit'))).toEqual({
    ok: false,
    code: 'shutting-down',
    outcome: 'not-dispatched',
  });
  for (const owner of setup.descriptor.owners)
    await expect(access(join(owner.storageRoot, 'started'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
});

it('connection discovery ignores renderer context claims and denies navigation/context changes during initialization', async () => {
  const setup = await fixture();
  const desktop = feature({
    descriptor: await selected(setup.descriptor),
    bindingDirectory: setup.bindingDirectory,
  });
  let context: string | null = 'context-A';
  const ipcHandlers = new Map<string, (...args: unknown[]) => Promise<BackendConnectionSnapshot>>();
  const ipc = {
    handle: vi.fn((channel, handler) => ipcHandlers.set(channel, handler)),
    removeHandler: vi.fn(),
  } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>;
  registerBackendConnectionsIpc(ipc, desktop, () => context);
  const invoke = ipcHandlers.get(AGENT_BACKEND_CONNECTIONS_CHANNEL)!;
  expect(await invoke({}, { contextId: 'context-B' })).toEqual({ state: 'hold', bindings: [] });
  const late = invoke({});
  context = 'context-B';
  expect(await late).toEqual({ state: 'hold', bindings: [] });
  expect((await invoke({})).bindings[0].handle.handleId).toBe('opaque-B');
  context = null;
  expect(await invoke({})).toEqual({ state: 'hold', bindings: [] });
  expect(vi.mocked(console.warn).mock.calls).toEqual([
    [
      '[Feature:AgentBackendConnections]',
      'Captured backend discovery held',
      { phase: 'context-after-initialize', code: 'context-changed' },
    ],
    [
      '[Feature:AgentBackendConnections]',
      'Captured backend discovery held',
      { phase: 'capture-context', code: 'missing-context' },
    ],
  ]);
  vi.mocked(console.warn).mockClear();
});

it('HTTP discovery uses the same captured context and rejects client context overrides', async () => {
  const setup = await fixture();
  const desktop = feature({
    descriptor: await selected(setup.descriptor),
    bindingDirectory: setup.bindingDirectory,
  });
  let context: string | null = 'context-A';
  const app = Fastify();
  registerBackendConnectionsHttp(app, desktop, () => context);
  try {
    const response = await app.inject({ method: 'GET', url: AGENT_BACKEND_CONNECTIONS_ROUTE });
    expect(response.json()).toEqual(desktop.listBindings('context-A'));
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `${AGENT_BACKEND_CONNECTIONS_ROUTE}?contextId=context-B`,
        })
      ).json()
    ).toEqual({ state: 'hold', bindings: [] });
    context = null;
    expect(
      (await app.inject({ method: 'GET', url: AGENT_BACKEND_CONNECTIONS_ROUTE })).json()
    ).toEqual({ state: 'hold', bindings: [] });
    // This finite warning may already be deduplicated by the preceding IPC case.
    expect(vi.mocked(console.warn).mock.calls.length).toBeLessThanOrEqual(1);
    for (const call of vi.mocked(console.warn).mock.calls)
      expect(call).toEqual([
        '[Feature:AgentBackendConnections]',
        'Captured backend discovery held',
        { phase: 'capture-context', code: 'missing-context' },
      ]);
    vi.mocked(console.warn).mockClear();
  } finally {
    await app.close();
  }
});

it('rechecks captured context after lazy host startup before dispatching a finite command', async () => {
  const setup = await fixture(true);
  const desktop = feature({
    descriptor: await selected(setup.descriptor),
    bindingDirectory: setup.bindingDirectory,
  });
  await desktop.initialize();
  let current = true;
  const pending = desktop.facade.invoke(request('opaque-A', 'stale-during-start'), {
    isCurrent: () => current,
  });
  await vi.waitFor(async () => {
    await access(join(setup.descriptor.owners[0].storageRoot, 'started'));
  });
  current = false;
  await writeFile(join(setup.descriptor.owners[0].storageRoot, 'release-startup'), 'release');
  expect(await pending).toEqual({ ok: false, code: 'forbidden', outcome: 'not-dispatched' });
  await expect(
    access(join(setup.descriptor.owners[0].storageRoot, 'effects'))
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('native health starts only the granted default owner and reports actual handshake without provider or Team work', async () => {
  const f = await fixture();
  const backend = feature({
    descriptor: await selected(f.descriptor),
    bindingDirectory: f.bindingDirectory,
  });
  await expect(backend.readRuntimeHealth('context-B')).rejects.toMatchObject({ code: 'forbidden' });
  for (const owner of f.descriptor.owners)
    await expect(access(join(owner.storageRoot, 'started'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  expect(await backend.readRuntimeHealth('context-A')).toEqual({ buildId: 'TEST-desktop-v1' });
  await expect(
    access(join(f.descriptor.owners[0]!.storageRoot, 'started'))
  ).resolves.toBeUndefined();
  for (const path of ['effects', 'management-effects'])
    await expect(access(join(f.descriptor.owners[0]!.storageRoot, path))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  await expect(access(join(f.descriptor.owners[1]!.storageRoot, 'started'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
