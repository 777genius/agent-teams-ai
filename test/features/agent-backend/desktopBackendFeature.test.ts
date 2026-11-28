// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';

import { createStoppedImportComposition } from '../../../packages/legacy-agent-host/dist/composition/createStoppedImportComposition.js';
import { teamHostProfileSchema } from '../../../packages/legacy-agent-host/dist/composition/teamHostProfile.js';
import { configureRetainedOpenCodeImportAuthority } from '../../../scripts/legacy-agent-host/desktop-retained-opencode-authority';
import {
  AGENT_BACKEND_CONNECTIONS_CHANNEL,
  AGENT_BACKEND_CONNECTIONS_ROUTE,
  AGENT_BACKEND_INVOKE_CHANNEL,
  hostTeamSelectionKey,
} from '../../../src/features/agent-backend/contracts';
import {
  DesktopBackendFeature,
  FileHandleBindingStore,
  loadDesktopBackendDescriptor,
  registerAgentBackendIpc,
  registerBackendConnectionsHttp,
  registerBackendConnectionsIpc,
} from '../../../src/features/agent-backend/main';
import { captureHostScheduleTarget, restoreHostScheduleTarget } from '../../../src/features/agent-backend/main/application/captureHostScheduleTarget';
import { readinessOriginDigest } from '../../../src/features/agent-backend/main/infrastructure/CapturedLocalModelReadiness';
import { JsonLocalProviderPrivateNetworkApprovalStore } from '../../../src/features/runtime-provider-management/main';
import { setAppDataBasePath } from '../../../src/main/utils/pathDecoder';
import { clearShellEnvCache } from '../../../src/main/utils/shellEnv';
import { addLogSink } from '../../../src/shared/utils/logger';

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
import type { LocalModelReadinessContext } from '../../../src/features/agent-backend/main/infrastructure/CapturedLocalModelReadiness';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

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
async function fixture(startup: { block?: boolean; markerDelayMs?: number; closeBeforeMarker?: boolean } = {}): Promise<{
  descriptor: DesktopBackendDescriptor;
  bindingDirectory: string;
}> {
  const owners: DesktopBackendDescriptor['owners'][number][] = [];
  for (const ownerId of ['A', 'B']) {
    const storageRoot = await root();
    const hostEntry = join(storageRoot, 'host.mts');
    const source = `import { writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
      if (${startup.markerDelayMs ?? 0}) await new Promise(resolve=>setTimeout(resolve,${startup.markerDelayMs ?? 0}));
      if (${startup.closeBeforeMarker ?? false}) process.exit(0);
      writeFileSync(${JSON.stringify(join(storageRoot, 'started'))}, 'started');
      if (${startup.block ?? false}) await new Promise(resolve=>{
        const timer=setInterval(()=>{if(existsSync(${JSON.stringify(join(storageRoot, 'release-startup'))})){clearInterval(timer);resolve();}},10);
      });
      const { createHostServer } = await import(${JSON.stringify(serverUrl)});
      const historicalLaunch = {launchId:'historical-launch',rosterRevision:'roster-1',
        status:'pending',ready:0,expected:1,retryCapability:'same-binding-no-allocation-only',
        admission:{commandId:'historical-start',sourceRosterRevision:'roster-1'},
        members:[{memberId:'member-1',binding:null,attempt:{attemptId:'attempt-1',status:'not-started',
          nativeReady:false,usable:false,controlAvailable:false,noAllocation:true,reason:'not-started'}}]};
      const initialLaunch = launchId => ({...historicalLaunch,launchId,admission:undefined,expected:3,
        members:['member-1','member-2','member-3'].map(memberId=>({memberId,binding:{memberId,generation:'1'},
          attempt:{...historicalLaunch.members[0].attempt,attemptId:'initial-'+memberId,noAllocation:false}}))});
      const initialView = launchId => ({launch:initialLaunch(launchId),
        members:[{memberId:'member-1',label:'Worker',role:'lead',selected:{provider:'opencode',
          workspace:${JSON.stringify(storageRoot)},model:'home-server/TEST-original',capabilities:['model','permissions','effort']}},
          {memberId:'member-2',label:'Second',role:'member',selected:{provider:'opencode',
            workspace:${JSON.stringify(join(storageRoot, 'initial-secondary'))},model:'second-cloud/TEST-second',capabilities:['model']}},
          {memberId:'member-3',label:'Claude',role:'member',selected:{provider:'claude',
            workspace:${JSON.stringify(join(storageRoot, 'unread-claude'))},model:'TEST-claude',capabilities:['model']}}]});
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
        'team.registry.list': { lane:'control', handle: () => {
          appendFileSync(${JSON.stringify(join(storageRoot, 'registry-reads'))}, 'read\\n');
          if (existsSync(${JSON.stringify(join(storageRoot, 'disconnect-registry'))})) process.exit(0);
          const registry = ${JSON.stringify(join(storageRoot, 'registry.json'))};
          return {ok:true,value:existsSync(registry) ? JSON.parse(readFileSync(registry, 'utf8')) : {teams:[],held:[]}};
        } },
        'team.lifecycle.retired.read': { lane:'control', handle: () => {
          appendFileSync(${JSON.stringify(join(storageRoot, 'retirement-reads'))}, 'read\\n');
          const retired = ${JSON.stringify(join(storageRoot, 'retired.json'))};
          return {ok:true,value:{teamIds:existsSync(retired) ? JSON.parse(readFileSync(retired, 'utf8')) : []}};
        } },
        'team.launch.configuration.read': { lane:'control', handle: (request) => {
          appendFileSync(${JSON.stringify(join(storageRoot, 'launch-reads'))}, request.commandId+'\\n');
          if (['initial-launch','initial-missing','initial-expired'].includes(request.payload.launchId))
            return {ok:true,value:initialView(request.payload.launchId),
              ...(request.payload.launchId==='initial-missing'?{}:{localModelReadinessCapture:
                request.payload.launchId==='initial-expired'?{preparationId:'expired-preparation',
                  captureCommandId:'expired-capture',launchId:request.payload.launchId,rosterRevision:'roster-1',
                  captureDigest:'a'.repeat(64),remainingMs:0,targets:[]}:null})};
          if (request.payload.launchId === 'historical-launch') return {ok:true,
            localModelReadinessCapture:null,value:{launch:historicalLaunch,
              members:[{memberId:'member-1',label:'Worker',role:'lead',selected:{provider:'opencode',
                workspace:${JSON.stringify(storageRoot)},model:'home-server/TEST-model',capabilities:['model']}}]}};
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
        'team.launch.start': { lane:'work', handle: request => {
          appendFileSync(${JSON.stringify(join(storageRoot, 'launch-starts'))}, JSON.stringify(request)+'\\n');
          if (request.payload.launchId==='initial-launch') return {ok:true,value:{
            ...initialLaunch(request.payload.launchId),admission:{commandId:request.commandId,
              sourceRosterRevision:request.payload.rosterRevision,
              members:request.payload.configuration.members.map(({memberId,...configuration})=>({memberId,configuration}))}}};
          return {ok:true,value:historicalLaunch};
        }},
        'team.creation.prepare': { lane:'work', handle: (request) => ({ok:true,value:{
          preparationId:request.payload.preparationId,draftDigest:'a'.repeat(64),ready:true,
          probes:[{memberName:'team-lead',commandId:request.commandId,model:'TEST-model',
            phase:'completed',ok:true,expiresAt:Date.now()+90000}]}}) },
        'management.catalog': {lane:'work', handle:(request)=>{
          appendFileSync(${JSON.stringify(join(storageRoot, 'management-effects'))},JSON.stringify({profileId:request.profileId,configRevision:request.configRevision})+${JSON.stringify('\n')});
          return {ok:true,value:{profileId:request.profileId,configRevision:request.configRevision,providers:[]}};
        }} }});
      writeFileSync(${JSON.stringify(join(storageRoot, 'host-created'))}, server.handshake.buildId);
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

async function waitForStartupMarker(storageRoot: string, pending: Promise<unknown>, deadline: number): Promise<void> {
  let finished = false;
  const terminal = pending.then(
    () => { throw new Error('TEST Host operation completed before its startup marker'); },
    () => { throw new Error('TEST Host operation rejected before its startup marker'); }
  );
  const marker = async () => {
    while (!finished) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error('TEST original Host startup deadline expired');
      try {
        await access(join(storageRoot, 'started'));
        if (performance.now() >= deadline) throw new Error('TEST original Host startup deadline expired');
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)));
    }
  };
  try { await Promise.race([terminal, marker()]); }
  finally { finished = true; }
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

  const originalBindings = desktop.listBindings('context-A');
  const recovery = {
    handle: { handleId: 'opaque-A' }, commandId: 'TEST-explicit-recovery',
    operation: 'host.recovery.capture', payload: {},
  };
  const current = { isCurrent: () => true };
  const noCustody = process.platform === 'win32' ? 'hold' : 'unavailable';
  expect(desktop.facade.validate(recovery)).toEqual(recovery);
  expect(await desktop.facade.invoke(recovery, current)).toEqual({
    ok: false, code: noCustody, outcome: 'not-dispatched',
  });
  const continuation = { ...recovery, operation: 'host.recovery.start',
    payload: { capability: '11111111-1111-4111-8111-111111111111' } };
  expect(desktop.facade.validate(continuation)).toEqual(continuation);
  expect(await desktop.facade.invoke(continuation, current)).toEqual({
    ok: false, code: noCustody, outcome: 'not-dispatched',
  });
  expect(await desktop.facade.invoke({
    ...continuation, payload: { ...continuation.payload, pid: 1234 },
  }, current)).toEqual({ ok: false, code: 'invalid', outcome: 'not-dispatched' });
  expect(await desktop.facade.invoke(recovery, { isCurrent: () => false })).toEqual({
    ok: false, code: 'forbidden', outcome: 'not-dispatched',
  });
  expect(await disabled.facade.invoke(recovery, current)).toEqual({
    ok: false, code: 'unavailable', outcome: 'not-dispatched',
  });
  expect(desktop.listBindings('context-A')).toEqual(originalBindings);
  for (const owner of setup.descriptor.owners)
    await expect(access(join(owner.storageRoot, 'started'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  const snapshot = JSON.stringify(desktop.listBindings('context-A'));
  expect(snapshot).not.toContain('TEST-secret-token');
  expect(snapshot).not.toContain(setup.descriptor.owners[0].storageRoot);
  expect(snapshot).not.toContain('nodeExecutable');
});

it.each(['shared', 'per_project'] as const)(
  'preserves an explicit %s history mode when a retained handle is restored from its private descriptor',
  async (projectContextMode) => {
    const setup = await fixture();
    const original = setup.descriptor.handles[1];
    const selection = await selected({
      ...setup.descriptor,
      handles: [setup.descriptor.handles[0], { ...original, projectContextMode }],
    });
    const loaded = await loadDesktopBackendDescriptor(selection);
    expect(loaded.handles).toHaveLength(2);
    expect(loaded.handles[0]).not.toHaveProperty('projectContextMode');
    expect(loaded.handles[1]).toEqual({ ...original, projectContextMode });
    const desktop = feature({ descriptor: selection, bindingDirectory: setup.bindingDirectory });
    await desktop.initialize();
    expect(desktop.listBindings('context-B')).toMatchObject({
      state: 'ready',
      bindings: [{ handle: { handleId: 'opaque-B' }, projectContextMode }],
    });
    expect(desktop.listBindings('context-A').bindings[0]).not.toHaveProperty('projectContextMode');
    expect(desktop.authorizeHandle('context-A', { handleId: 'opaque-B' })).toBe(false);
    for (const owner of setup.descriptor.owners)
      await expect(access(join(owner.storageRoot, 'started'))).rejects.toMatchObject({ code: 'ENOENT' });
  }
);

it('rejects invalid retained history modes and injected project bindings in a private descriptor', async () => {
  const setup = await fixture();
  for (const extra of [
    { projectContextMode: null },
    { projectContextMode: 'TEST-invalid' },
    { projectContextMode: 1 },
    { projectContextMode: 'shared', projectContext: {
      logicalHandleId: 'opaque-A', projectPath: '/TEST-foreign', workContextId: 'TEST-foreign',
    } },
  ]) {
    await expect(loadDesktopBackendDescriptor(await selected({
      ...setup.descriptor,
      handles: [{ ...setup.descriptor.handles[0], ...extra }],
    }))).rejects.toMatchObject({ code: 'hold' });
  }
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
    const unusedGlobal = join(home, '.config', 'opencode', 'opencode.json');
    await mkdir(join(home, '.config', 'opencode'), { recursive: true });
    await writeFile(unusedGlobal, Buffer.alloc(1024 * 1024 + 1));
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
          providers: { hasConfiguredApiKey: boolean }[] }; global: { notConsulted: string } }[];
        approval: { source: { path: string }; approved: unknown[] } } } };
    expect(wire.binding.scope.projectId).toBe('project-1');
    expect(wire.localModelReadinessOrigin.origin.contextId).toBe('context-A');
    expect(wire.localModelReadinessOrigin.remainingMs).toBeGreaterThan(0);
    expect(wire.localModelReadinessOrigin.remainingMs).toBeLessThan(90000);
    expect(wire.localModelReadinessOrigin.origin.workspaces).toMatchObject([{
      path: workspace, project: { selectedPath: configPath, sources: expect.any(Array),
        providers: [{ hasConfiguredApiKey: true }] },
    }]);
    expect(wire.localModelReadinessOrigin.origin.workspaces[0].project.sources).toHaveLength(4);
    expect(wire.localModelReadinessOrigin.origin.workspaces[0].global)
      .toEqual({ notConsulted: 'project-precedence' });
    expect(wire.localModelReadinessOrigin.origin.approval.approved).toEqual([{
      configPath, providerId: 'home-server', baseUrl: 'http://192.168.1.20:8080/v1',
    }]);
    expect(raw).not.toContain('{file:');
    expect(raw).not.toContain('TEST-secret-token');
    const originalReads = await readFile(join(workspace, 'launch-reads'), 'utf8');
    expect(originalReads.trim().split('\n')).toHaveLength(1);
    await rm(unusedGlobal);

    const view: NonNullable<LocalModelReadinessContext['view']> = {
      launch: { launchId: 'launch-1', rosterRevision: 'roster-1' },
      members: [{ memberId: 'member-1', label: 'Worker', role: 'lead', selected: {
        provider: 'opencode', workspace, model: 'home-server/TEST-model', capabilities: ['model'],
      } }],
    };
    vi.stubEnv('XDG_CONFIG_HOME', join(home, 'different-original-config-root'));
    const saved = desktop.facade.invoke({ ...probe, commandId: 'saved-probe',
      payload: { ...probe.payload, model: 'public-cloud/TEST-model' } }, undefined,
      { view, remainingMs: () => deadline - performance.now() });
    view.members[0].selected!.workspace = join(home, 'changed-after-capture');
    expect(await saved).toMatchObject({ ok: true, value: { commandId: 'saved-probe', ok: true } });
    expect(await readFile(join(workspace, 'launch-reads'), 'utf8')).toBe(originalReads);
    const savedWire = JSON.parse((await readFile(join(workspace, 'probe-requests'), 'utf8'))
      .trim().split('\n')[1]);
    expect(savedWire.localModelReadinessOrigin.origin.workspaces[0].global).toMatchObject({
      selectedPath: null, selectorFailure: 'config-conflict', invalid: true, providers: [],
    });
    expect(savedWire.localModelReadinessOrigin.origin.workspaces[0].global.sources).toHaveLength(2);

    const declaration = JSON.parse(await readFile(configPath, 'utf8'));
    declaration.provider['public-cloud'] = { npm: '@ai-sdk/openai-compatible', options: {
      baseURL: 'https://api.example.test/v1', apiKey: 'TEST-public-key',
    } };
    await writeFile(configPath, JSON.stringify(declaration));
    const approvalPath = wire.localModelReadinessOrigin.origin.approval.source.path;
    await writeFile(approvalPath, Buffer.alloc(131073));
    const unavailableHome = join(home, 'TEST-unused-missing-home');
    vi.stubEnv('HOME', unavailableHome);
    vi.stubEnv('USERPROFILE', unavailableHome);
    clearShellEnvCache();
    view.members[0].selected!.workspace = workspace;
    const publicRequest = { ...probe, commandId: 'unused-dependencies',
      payload: { ...probe.payload, model: 'public-cloud/TEST-model' } };
    expect(await desktop.facade.invoke(publicRequest, undefined,
      { view, remainingMs: () => deadline - performance.now() })).toMatchObject({ ok: true });
    const dispatched = await readFile(join(workspace, 'probe-requests'), 'utf8');
    const publicWire = JSON.parse(dispatched.trim().split('\n').at(-1)!);
    expect(publicWire.localModelReadinessOrigin.origin.workspaces[0].global)
      .toEqual({ notConsulted: 'project-precedence' });
    expect(publicWire.localModelReadinessOrigin.origin.approval)
      .toEqual({ notConsulted: 'no-private-target' });
    expect((await readFile(approvalPath)).byteLength).toBe(131073);
    for (const [commandId, model] of [
      ['required-private-approval', 'home-server/TEST-model'],
      ['required-global', 'missing-provider/TEST-model'],
      ['unknown-default-source', '__provider_default__'],
    ] as const) {
      expect(await desktop.facade.invoke({ ...probe, commandId,
        payload: { ...probe.payload, model } }, undefined,
      { view, remainingMs: () => deadline - performance.now() }), commandId).toMatchObject({ ok: false });
      expect(await readFile(join(workspace, 'probe-requests'), 'utf8'), commandId).toBe(dispatched);
    }
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
      const beforeHistorical = await readFile(join(workspace, 'probe-requests'), 'utf8');
      expect(await desktop.facade.invoke({ handle: { handleId: 'opaque-A' }, commandId: 'historical-start',
        operation: 'team.launch.start', payload: { launchId: 'historical-launch', rosterRevision: 'roster-1' } }))
        .toMatchObject({ ok: true, value: { admission: { commandId: 'historical-start' } } });
      expect(await readFile(join(workspace, 'probe-requests'), 'utf8')).toBe(beforeHistorical);
      const historicalWire = JSON.parse(await readFile(join(workspace, 'launch-starts'), 'utf8'));
      expect(historicalWire.localModelReadinessOrigin).toBeUndefined();
      expect(historicalWire.localModelReadinessTransfer).toBeUndefined();
      expect(approvalCapture).not.toHaveBeenCalled();
    } finally { approvalCapture.mockRestore(); }

    const secondWorkspace = join(workspace, 'initial-secondary');
    await mkdir(secondWorkspace);
    await writeFile(join(secondWorkspace, 'opencode.json'), JSON.stringify({ provider: { 'second-cloud': {
      npm: '@ai-sdk/openai-compatible', options: {
        baseURL: 'https://second.example.test/v1', apiKey: 'TEST-second-key',
      },
    } } }));
    const initialPayload = { launchId: 'initial-launch', rosterRevision: 'roster-1',
      configuration: { members: [{ memberId: 'member-1', model: 'public-cloud/TEST-model',
        permissions: 'bypass' as const, effort: 'high' as const }] } };
    const beforeStarts = await readFile(join(workspace, 'launch-starts'), 'utf8');
    const beforeProbes = await readFile(join(workspace, 'probe-requests'), 'utf8');
    expect(await invoke(trusted, { handle: { handleId: 'opaque-A' }, commandId: 'initial-start',
      operation: 'team.launch.start', payload: initialPayload })).toMatchObject({
      ok: true, value: { launchId: 'initial-launch', admission: { commandId: 'initial-start' } },
    });
    const afterStarts = await readFile(join(workspace, 'launch-starts'), 'utf8');
    expect(afterStarts.startsWith(beforeStarts)).toBe(true);
    const initialLines = afterStarts.slice(beforeStarts.length).trim().split('\n');
    expect(initialLines).toHaveLength(1);
    const initialWire = JSON.parse(initialLines[0]);
    expect(initialWire.commandId).toBe('initial-start');
    expect(initialWire.payload).toEqual(initialPayload);
    expect(initialWire.binding.owner).toMatchObject({ ownerId: 'A', revision: 'v1' });
    const initialOrigin = initialWire.localModelReadinessOrigin.origin;
    expect(initialOrigin.ownerDigest).toBe(readinessOriginDigest(initialWire.binding.owner));
    expect(initialOrigin.contextId).toBe('context-A');
    expect(initialOrigin.commandId).toBe('initial-start');
    expect(initialOrigin.selectionDigest).toBe(readinessOriginDigest({
      handleId: 'opaque-A', scope: setup.descriptor.handles[0].scope, payload: initialPayload,
    }));
    expect(initialOrigin.workspaces.map((row: { path: string }) => row.path))
      .toEqual([workspace, secondWorkspace]);
    expect(initialOrigin.workspaces.map((row: { global: unknown }) => row.global))
      .toEqual([{ notConsulted: 'project-precedence' }, { notConsulted: 'project-precedence' }]);
    expect(initialOrigin.approval).toEqual({ notConsulted: 'no-private-target' });
    expect(Number.isSafeInteger(initialWire.localModelReadinessOrigin.remainingMs)).toBe(true);
    expect(initialWire.localModelReadinessOrigin.remainingMs).toBeGreaterThan(0);
    expect(initialWire.localModelReadinessOrigin.remainingMs)
      .toBeLessThanOrEqual(setup.descriptor.owners[0].profile.requestTimeoutMs);
    for (const launchId of ['initial-missing', 'initial-expired']) {
      expect(await invoke(trusted, { handle: { handleId: 'opaque-A' }, commandId: launchId,
        operation: 'team.launch.start', payload: { ...initialPayload, launchId } }))
        .toEqual({ ok: false, code: 'hold', outcome: 'not-dispatched' });
      expect(await readFile(join(workspace, 'launch-starts'), 'utf8')).toBe(afterStarts);
    }
    expect(await readFile(join(workspace, 'probe-requests'), 'utf8')).toBe(beforeProbes);
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

it('keeps Windows descriptor digest and schema checks without treating synthetic POSIX mode bits as authority', async () => {
  const setup = await fixture();
  const selection = await selected(setup.descriptor);
  await chmod(selection.path, 0o666);
  expect((await stat(selection.path)).mode & 0o077).not.toBe(0);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    await expect(loadDesktopBackendDescriptor(selection)).resolves.toEqual(setup.descriptor);
    await expect(
      loadDesktopBackendDescriptor({ ...selection, sha256: '0'.repeat(64) })
    ).rejects.toMatchObject({ code: 'hold' });
    const malformed = await selected({ ...setup.descriptor, schemaVersion: 2 });
    await expect(loadDesktopBackendDescriptor(malformed)).rejects.toMatchObject({ code: 'hold' });
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
  for (const owner of setup.descriptor.owners)
    await expect(access(join(owner.storageRoot, 'started'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('continues to hold non-private POSIX descriptor files', async () => {
  const setup = await fixture();
  const selection = await selected(setup.descriptor);
  await chmod(selection.path, 0o644);
  expect((await stat(selection.path)).mode & 0o077).not.toBe(0);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    await expect(loadDesktopBackendDescriptor(selection)).rejects.toMatchObject({ code: 'hold' });
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
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


it('keeps healthy owner discovery available after original transport loss', async () => {
  const setup = await fixture();
  const contextId = 'TEST-shared-context', a = setup.descriptor.owners[0]!;
  const b = setup.descriptor.owners[1]!, originalA = setup.descriptor.handles[0]!;
  const descriptor: DesktopBackendDescriptor = {
    ...setup.descriptor,
    creation: { owner: originalA.owner, contextIds: [contextId] },
    handles: [
      ...setup.descriptor.handles.map(row => ({ ...row, contextId })),
      { ...originalA, contextId, handleId: 'TEST-retired-A',
        scope: { ...originalA.scope, teamId: 'TEST-retired-team-A' } },
    ],
  };
  await writeFile(join(a.storageRoot, 'retired.json'), JSON.stringify(['TEST-retired-team-A']));
  const desktop = feature({ descriptor: await selected(descriptor),
    bindingDirectory: setup.bindingDirectory });
  const handlers = new Map<string, (...args: unknown[]) => Promise<BackendConnectionSnapshot>>();
  const ipc = { handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn() } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>;
  registerBackendConnectionsIpc(ipc, desktop, () => contextId);
  const invoke = handlers.get(AGENT_BACKEND_CONNECTIONS_CHANNEL)!;
  const before = await invoke({});
  expect(before.state).toBe('ready');
  expect(before.unavailableOwners).toBeUndefined();
  expect(before.bindings.map(row => row.handle.handleId)).toEqual(['opaque-A', 'opaque-B']);
  const guard = { isCurrent: () => true };
  const targetA = await captureHostScheduleTarget(desktop, contextId, hostTeamSelectionKey('opaque-A'), guard);
  const targetB = await captureHostScheduleTarget(desktop, contextId, hostTeamSelectionKey('opaque-B'), guard);
  const bReads = await readFile(join(b.storageRoot, 'retirement-reads'), 'utf8');

  await writeFile(join(a.storageRoot, 'disconnect-registry'), 'TEST original transport close');
  const partial = await invoke({});
  expect(partial.bindings).toEqual(before.bindings);
  expect(partial).toMatchObject({ state: 'ready', unavailableOwners: [{
    kind: 'owner', ownerResourceRef: targetA.ownerResourceRef,
    code: 'unavailable', outcome: 'unknown',
  }] });
  expect(partial.unavailableOwners).toHaveLength(1);
  expect(await readFile(join(b.storageRoot, 'retirement-reads'), 'utf8')).toBe(bReads + 'read\n');
  expect(partial.bindings.some(row => row.handle.handleId === 'TEST-retired-A')).toBe(false);
  await expect(desktop.captureBackup(contextId, guard)).rejects.toMatchObject({ code: 'hold' });
  await expect(captureHostScheduleTarget(desktop, contextId, hostTeamSelectionKey('opaque-A'), guard))
    .rejects.toMatchObject({ code: 'forbidden' });
  await expect(restoreHostScheduleTarget(desktop, hostTeamSelectionKey('opaque-A'), targetA, () => true))
    .rejects.toMatchObject({ code: 'unavailable' });
  const restoredB = await restoreHostScheduleTarget(desktop, hostTeamSelectionKey('opaque-B'), targetB, () => true);
  expect(restoredB.target).toEqual(targetB);
  expect(restoredB.isCurrent()).toBe(true);
  expect(await desktop.facade.invoke(request('opaque-A', 'TEST-no-fallback'), guard))
    .toMatchObject({ ok: false });
  expect(await desktop.facade.invoke(request('opaque-B', 'TEST-original-healthy-B'), guard))
    .toMatchObject({ ok: true });
  await expect(access(join(a.storageRoot, 'effects'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(b.storageRoot, 'effects'), 'utf8')).toBe('TEST-original-healthy-B\n');
  expect(desktop.listBindings(contextId).bindings).toEqual(before.bindings);
  expect(vi.mocked(console.warn).mock.calls).toEqual([]);
});

it('keeps malformed registry, binding conflicts and stale discovery context fatal', async () => {
  const setup = await fixture(), contextId = 'TEST-original-context';
  const originalA = setup.descriptor.handles[0]!, a = setup.descriptor.owners[0]!;
  const descriptor: DesktopBackendDescriptor = { ...setup.descriptor,
    creation: { owner: originalA.owner, contextIds: [contextId] },
    handles: setup.descriptor.handles.map(row => ({ ...row, contextId })),
  };
  const desktop = feature({ descriptor: await selected(descriptor),
    bindingDirectory: setup.bindingDirectory });
  const guard = { isCurrent: () => true };
  const before = await desktop.discoverBindings(contextId, guard);
  const registry = join(a.storageRoot, 'registry.json');
  await writeFile(registry, JSON.stringify({ teams: 'TEST-malformed', held: [] }));
  await expect(desktop.discoverBindings(contextId, guard)).rejects.toThrow();
  expect(desktop.listBindings(contextId)).toEqual(before);
  await writeFile(registry, JSON.stringify({ held: [], teams: [{
    contextId, teamId: originalA.scope.teamId, teamName: 'team-A',
    displayName: originalA.label, members: originalA.members,
    binding: { schemaVersion: 1, handleId: originalA.handleId,
      scope: { ...originalA.scope, runId: 'TEST-conflicting-run' } },
  }] }));
  await expect(desktop.discoverBindings(contextId, guard))
    .rejects.toMatchObject({ code: 'binding-conflict' });
  expect(desktop.listBindings(contextId)).toEqual(before);
  await rm(registry);
  let current = true;
  const pending = desktop.discoverBindings(contextId, { isCurrent: () => current });
  current = false;
  await expect(pending).rejects.toMatchObject({ code: 'forbidden' });
  expect(desktop.listBindings(contextId)).toEqual(before);
  expect(await desktop.discoverBindings(contextId, guard)).toEqual(before);
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
  const setup = await fixture({ block: true, markerDelayMs: 1100 });
  const desktop = feature({
    descriptor: await selected(setup.descriptor),
    bindingDirectory: setup.bindingDirectory,
  });
  await desktop.initialize();
  const originalDiagnostics = process.env.LEGACY_DESKTOP_STARTUP_DIAGNOSTICS;
  const observations: { phase: string; kind: string; elapsedMs: number }[] = [];
  const phases = ['profile-validation-start', 'profile-validation-complete', 'child-captured',
    'ready', 'request-timeout', 'request-admitted', 'response-accepted',
    'owner-start', 'owner-started', 'read-start', 'read-complete'];
  const kinds = ['handshake', 'rpc', 'registry-list', 'retirement-read'];
  let dropped = 0;
  let pendingObservation: {
    state: 'pending' | 'resolved-success' | 'resolved-failure' | 'resolved-unprojected' | 'rejected';
    code?: string; outcome?: string;
  } = { state: 'pending' };
  const removeSink = addLogSink(entry => {
    if (entry.level !== 'diagnostic' || entry.namespace !== 'TEST:HostStartup' ||
        entry.args[0] !== 'Host startup observation') return;
    const value = entry.args[1];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const row = value as Record<string, unknown>;
    if (typeof row.phase !== 'string' || !phases.includes(row.phase) ||
        typeof row.kind !== 'string' || !kinds.includes(row.kind) ||
        typeof row.elapsedMs !== 'number' || !Number.isSafeInteger(row.elapsedMs) ||
        row.elapsedMs < 0) return;
    if (observations.length < 16)
      observations.push({ phase: row.phase, kind: row.kind, elapsedMs: row.elapsedMs });
    else dropped++;
  });
  try {
    process.env.LEGACY_DESKTOP_STARTUP_DIAGNOSTICS = '1';
    let current = true;
    // One original budget from the selected fixture, including validation and child startup.
    const startedAt = performance.now();
    const startupDeadline = startedAt + setup.descriptor.owners[0]!.profile.startupTimeoutMs;
    const pending = desktop.facade.invoke(request('opaque-A', 'stale-during-start'), {
      isCurrent: () => current,
    });
    void pending.then(result => {
      try {
        pendingObservation = result.ok ? { state: 'resolved-success' } : {
          state: 'resolved-failure',
          code: ['invalid', 'conflict', 'forbidden', 'hold', 'busy', 'unavailable', 'shutting-down']
            .includes(result.code) ? result.code : 'unrecognized',
          outcome: ['not-dispatched', 'rejected', 'unknown'].includes(result.outcome)
            ? result.outcome : 'unrecognized',
        };
      } catch {
        pendingObservation = { state: 'resolved-unprojected' };
      }
    }, () => { pendingObservation = { state: 'rejected' }; });
    await waitForStartupMarker(setup.descriptor.owners[0]!.storageRoot, pending, startupDeadline);
    expect(performance.now() - startedAt).toBeGreaterThan(1000);
    current = false;
    await writeFile(join(setup.descriptor.owners[0].storageRoot, 'release-startup'), 'release');
    expect(await pending).toEqual({ ok: false, code: 'forbidden', outcome: 'not-dispatched' });
    expect(
      await readFile(join(setup.descriptor.owners[0].storageRoot, 'host-created'), 'utf8')
    ).toBe('TEST-desktop-v1');
    await expect(
      access(join(setup.descriptor.owners[0].storageRoot, 'effects'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    removeSink();
    if (originalDiagnostics === undefined) delete process.env.LEGACY_DESKTOP_STARTUP_DIAGNOSTICS;
    else process.env.LEGACY_DESKTOP_STARTUP_DIAGNOSTICS = originalDiagnostics;
    try {
      process.stdout.write(JSON.stringify({ kind: 'TEST_LAZY_HOST_STARTUP_OBSERVATION',
        point: 'case-finally', observations, dropped, pending: pendingObservation }) + '\n');
    } catch {
      // A passive observation cannot replace the original test result.
    }
  }
});

it('rejects a lazy startup marker when the original selected Host closes first', async () => {
  const setup = await fixture({ closeBeforeMarker: true });
  const desktop = feature({ descriptor: await selected(setup.descriptor), bindingDirectory: setup.bindingDirectory });
  await desktop.initialize();
  const owner = setup.descriptor.owners[0]!;
  const deadline = performance.now() + owner.profile.startupTimeoutMs;
  const pending = desktop.facade.invoke(request('opaque-A', 'closed-before-start'), { isCurrent: () => true });
  await expect(waitForStartupMarker(owner.storageRoot, pending, deadline))
    .rejects.toThrow('TEST Host operation completed before its startup marker');
  expect(await pending).toMatchObject({ ok: false });
  for (const file of ['started', 'host-created', 'effects'])
    await expect(access(join(owner.storageRoot, file))).rejects.toMatchObject({ code: 'ENOENT' });
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


type CapturedTestPrompt = Parameters<NonNullable<
  ConstructorParameters<typeof DesktopBackendFeature>[0]['onNativePromptSuggestion']
>>[0];

function originalPrompt(teamId: string) {
  return { provider: 'codex', teamId, runId: 'run-1', memberId: 'member-1', memberName: 'Worker',
    generation: 'gen-1', suggestionId: 'TEST-suggestion', messageId: 'TEST-message',
    inputId: 'TEST-input', operationRef: 'TEST-operation', completedTurnRef: 'TEST-turn',
    text: 'Review the original changes' };
}

it('wires actual initial Host prompts through captured settings and the selected owner projection', async () => {
  const setup = await fixture();
  const owners = await Promise.all(setup.descriptor.owners.map(async owner => {
    const original = await readFile(owner.profile.hostEntry, 'utf8');
    const marker = "'team.execute': { lane:'work', handle: (request) => {";
    expect(original.split(marker)).toHaveLength(2);
    const candidate = originalPrompt(`team-${owner.ownerId}`);
    const foreign = originalPrompt(`team-${owner.ownerId === 'A' ? 'B' : 'A'}`);
    const rows = [null, [], { ...candidate, runId: 'foreign-run' }, foreign,
      { ...candidate, memberId: 'foreign-member' }, { ...candidate, provider: 'opencode' },
      { ...candidate, inputId: '' }, candidate];
    const source = original.replace(marker, `${marker}
      for (const row of ${JSON.stringify(rows)}) server.notifyData('runtime.prompt-suggestion.updated', row);
      writeFileSync(${JSON.stringify(join(owner.storageRoot, 'prompt-enabled'))},
        process.env.AGENT_TEAMS_NATIVE_NEXT_PROMPT_ENABLED);
    `);
    await writeFile(owner.profile.hostEntry, source);
    return { ...owner, profile: { ...owner.profile,
      env: { ...owner.profile.env, AGENT_TEAMS_NATIVE_NEXT_PROMPT_ENABLED: '0' },
      hostEntrySha256: createHash('sha256').update(source).digest('hex') } };
  }));
  const published: CapturedTestPrompt[] = [];
  const replaced = vi.fn();
  const options: ConstructorParameters<typeof DesktopBackendFeature>[0] = {
    descriptor: await selected({ ...setup.descriptor, owners }),
    bindingDirectory: setup.bindingDirectory,
    nativeNextPromptEnabled: true,
    onNativePromptSuggestion: value => { published.push(value); },
  };
  const desktop = feature(options);
  Object.assign(options, { nativeNextPromptEnabled: false, onNativePromptSuggestion: replaced });
  await desktop.initialize();
  for (const owner of owners) {
    expect(await desktop.facade.invoke(request(`opaque-${owner.ownerId}`, `TEST-prompt-${owner.ownerId}`)))
      .toMatchObject({ ok: true });
    await vi.waitFor(() => {
      expect(published.filter(row => row.teamId === `team-${owner.ownerId}`)).toHaveLength(1);
    });
    expect(await readFile(join(owner.storageRoot, 'prompt-enabled'), 'utf8')).toBe('1');
  }
  expect(published.map(row => ({ ownerHandle: row.ownerHandle, teamId: row.teamId,
    runId: row.runId, memberId: row.memberId, conversationRef: row.conversationRef }))).toEqual([
    { ownerHandle: hostTeamSelectionKey('opaque-A'), teamId: 'team-A', runId: 'run-1',
      memberId: 'member-1', conversationRef: 'direct:worker' },
    { ownerHandle: hostTeamSelectionKey('opaque-B'), teamId: 'team-B', runId: 'run-1',
      memberId: 'member-1', conversationRef: 'direct:worker' },
  ]);
  expect(published.every(Object.isFrozen)).toBe(true);
  expect(replaced).not.toHaveBeenCalled();
});

it('binds prompt publication to the current client, original roster and one matching handle', async () => {
  const { captureHostPromptSuggestions } = await import(
    '../../../src/features/agent-backend/main/composition/captureHostPromptSuggestions'
  );
  const { CapturedHostClient } = await import('../../../src/features/agent-backend/main');
  const { ownerKey } = await import('../../../src/features/agent-backend/main/application/backendBinding');
  const setup = await fixture();
  const owner = setup.descriptor.owners[0]!;
  const original = new CapturedHostClient(owner.profile);
  const successor = new CapturedHostClient(owner.profile);
  const handle = setup.descriptor.handles[0]!;
  let definitions: DesktopBackendDescriptor['handles'] = [handle];
  let current: typeof original | undefined = original;
  let ready = true;
  const published: CapturedTestPrompt[] = [];
  const replacement = vi.fn();
  const input = {
    definitions: () => definitions,
    currentClient: (key: string) => key === ownerKey(owner) ? current : undefined,
    isCurrent: () => ready,
    publish: (value: CapturedTestPrompt) => { published.push(value); },
    enabled: true,
  };
  const optionsFor = captureHostPromptSuggestions(input);
  const originalOptions = optionsFor(owner);
  Object.assign(input, { publish: replacement, enabled: false });
  const nextOptions = optionsFor(owner);
  const oldSink = originalOptions.onNativePromptSuggestion;
  const nextSink = nextOptions.onNativePromptSuggestion;
  if (!oldSink || !nextSink) throw new Error('TEST captured prompt sink missing');
  const candidate = originalPrompt('team-A');
  expect(originalOptions.nativeNextPromptEnabled).toBe(true);
  expect(nextOptions.nativeNextPromptEnabled).toBe(true);
  oldSink(candidate, original);
  expect(published).toHaveLength(1);
  definitions = [handle, handle];
  oldSink(candidate, original);
  expect(published).toHaveLength(2);
  definitions = [handle, { ...handle, handleId: 'opaque-second-A' }];
  oldSink(candidate, original);
  definitions = [{ ...handle, members: [] }];
  oldSink(candidate, original);
  definitions = [handle];
  current = successor;
  oldSink(candidate, original);
  expect(published).toHaveLength(2);
  nextSink(candidate, successor);
  expect(published).toHaveLength(3);
  ready = false;
  nextSink(candidate, successor);
  ready = true;
  current = undefined;
  nextSink(candidate, successor);
  expect(published).toHaveLength(3);
  expect(replacement).not.toHaveBeenCalled();
  expect((await original.shutdown()).childExit).toBe('confirmed');
  expect((await successor.shutdown()).childExit).toBe('confirmed');
});

function retainedReceiptProfile(descriptor: DesktopBackendDescriptor) {
  const selectedOwner = descriptor.owners.find(owner =>
    owner.ownerId === descriptor.defaultOwner.ownerId &&
    owner.revision === descriptor.defaultOwner.revision);
  if (!selectedOwner) throw new Error('TEST original selected owner is required');
  return teamHostProfileSchema.parse({
    schemaVersion: 1,
    owner: {
      ownerId: selectedOwner.ownerId, revision: selectedOwner.revision,
      storageRoot: selectedOwner.storageRoot, profileId: selectedOwner.profile.profileId,
      protocolVersion: 1, buildId: selectedOwner.profile.expectedBuildId,
      nodeSha256: selectedOwner.profile.nodeSha256,
      hostEntrySha256: selectedOwner.profile.hostEntrySha256,
    },
    principalId: 'TEST-human',
    teams: [],
  });
}

it('retained fixture pairs actual Main capture with actual Host receipt absence without starting an owner', async () => {
  const setup = await fixture();
  const profile = retainedReceiptProfile(setup.descriptor);
  const original = JSON.stringify({ profile, descriptor: setup.descriptor });
  let authorityReads = 0;
  const receiptPorts = {
    assertCurrent: () => { authorityReads += 1; },
    attach: () => { throw new Error('TEST receipt reads must not attach a Team'); },
    validateConfiguration: () => { throw new Error('TEST receipt reads must not publish a Team'); },
  };
  expect(createStoppedImportComposition({ profile, ...receiptPorts })).toBeUndefined();
  const missing = feature({
    descriptor: await selected(setup.descriptor), bindingDirectory: await root(),
  });
  await expect(missing.captureStoppedImport('local', { isCurrent: () => true }))
    .rejects.toMatchObject({ code: 'unavailable', outcome: 'not-dispatched' });

  const configured = configureRetainedOpenCodeImportAuthority(profile, { ...setup.descriptor });
  expect(JSON.stringify({ profile, descriptor: setup.descriptor })).toBe(original);
  const preparedProfile = teamHostProfileSchema.parse(configured.profile);
  const descriptorSelection = await selected(configured.descriptor);
  const parsedDescriptor = await loadDesktopBackendDescriptor(descriptorSelection);
  expect(preparedProfile.creation).toEqual({ contextIds: ['local'] });
  expect(parsedDescriptor.creation).toEqual({
    owner: setup.descriptor.defaultOwner, contextIds: ['local'],
    importAuthority: { principalId: profile.principalId },
  });
  const missingAuthority = feature({
    descriptor: await selected({ ...configured.descriptor, creation: {
      owner: setup.descriptor.defaultOwner, contextIds: ['local'],
    } }),
    bindingDirectory: await root(),
  });
  await expect(missingAuthority.captureStoppedImport('local', { isCurrent: () => true }))
    .rejects.toMatchObject({ code: 'unavailable', outcome: 'not-dispatched' });

  const desktop = feature({
    descriptor: descriptorSelection, bindingDirectory: setup.bindingDirectory,
  });
  let current = true;
  const target = await desktop.captureStoppedImport('local', { isCurrent: () => current });
  expect(target.authority).toMatchObject({
    root: profile.owner.storageRoot, ownerId: profile.owner.ownerId,
    profileId: profile.owner.profileId, principalId: profile.principalId, contextIds: ['local'],
  });
  target.authority.assertCurrent();
  await expect(desktop.captureStoppedImport('foreign-context', { isCurrent: () => true }))
    .rejects.toMatchObject({ code: 'forbidden', outcome: 'not-dispatched' });

  const composition = createStoppedImportComposition({ profile: preparedProfile, ...receiptPorts });
  if (!composition) throw new Error('TEST captured receipt composition must exist');
  const signal = new AbortController().signal;
  const invoke = async (
    operation: 'list' | 'lookup', contextId = 'local', owner = preparedProfile.owner
  ) => {
    const method = composition.methods[`team.import.${operation}`];
    if (!method) throw new Error('TEST original receipt method must exist');
    expect(method.lane).toBe('control');
    return method.handle(
      { owner, commandId: 'TEST-retained-absence', payload: { contextId } },
      { requestId: `TEST-retained-${operation}`, signal }
    );
  };
  expect(await invoke('list')).toEqual({ ok: true, value: { entries: [] } });
  expect(await invoke('lookup')).toEqual({ ok: true, value: null });
  expect(await invoke('list', 'foreign-context')).toEqual({
    ok: false, code: 'forbidden', outcome: 'not-dispatched',
  });
  expect(await invoke('lookup', 'local', { ...preparedProfile.owner, revision: 'foreign-revision' }))
    .toEqual({ ok: false, code: 'forbidden', outcome: 'not-dispatched' });
  expect(authorityReads).toBeGreaterThan(0);
  for (const owner of setup.descriptor.owners)
    await expect(access(join(owner.storageRoot, 'started'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(join(profile.owner.storageRoot, '.host-team-registry', 'imports')))
    .rejects.toMatchObject({ code: 'ENOENT' });
  current = false;
  expect(() => target.authority.assertCurrent()).toThrow('Backend routing: forbidden');
});

it('retained fixture preserves opaque runtime inputs and refuses foreign metadata without changing its inputs', async () => {
  const setup = await fixture();
  // This value is not executed or treated as a runtime recipe; the setup must preserve it opaquely.
  const runtime = { providerTemplates: [{ testIdentity: 'TEST-original-template' }], members: [] };
  const profile = { ...retainedReceiptProfile(setup.descriptor), runtime };
  const descriptor = { ...setup.descriptor };
  const configured = configureRetainedOpenCodeImportAuthority(profile, descriptor);
  const creation = {
    owner: setup.descriptor.defaultOwner, contextIds: ['local'],
    importAuthority: { principalId: profile.principalId },
  };
  expect(configured.profile).toEqual({ ...profile, creation: { contextIds: ['local'] } });
  expect(configured.descriptor).toEqual({ ...descriptor, creation });
  expect(configured.profile.runtime).toBe(runtime);
  expect(configured.profile.teams).toBe(profile.teams);
  expect(configured.descriptor.owners).toBe(descriptor.owners);
  expect(configured.descriptor.handles).toBe(descriptor.handles);
  expect(configureRetainedOpenCodeImportAuthority(configured.profile, configured.descriptor))
    .toEqual(configured);
  const cases = [
    { profile, descriptor: { ...descriptor, defaultOwner: { ownerId: 'B', revision: 'v1' } } },
    { profile: { ...profile, owner: { ...profile.owner, profileId: 'foreign-profile' } }, descriptor },
    { profile: { ...profile, owner: { ...profile.owner, storageRoot: '/TEST-foreign-root' } }, descriptor },
    { profile, descriptor: { ...descriptor, owners: descriptor.owners.map(owner =>
      owner.ownerId === descriptor.defaultOwner.ownerId
        ? { ...owner, profile: { ...owner.profile, nodeSha256: 'f'.repeat(64) } } : owner) } },
    { profile: { ...profile, creation: { contextIds: ['foreign-context'] } }, descriptor },
    { profile, descriptor: { ...descriptor, creation: {
      ...creation, importAuthority: { principalId: 'foreign-principal' },
    } } },
    { profile, descriptor: { ...descriptor, creation: { ...creation, contextIds: ['local', 'foreign'] } } },
    { profile, descriptor: { ...descriptor, creation: {
      ...creation, owner: { ownerId: 'B', revision: 'v1' },
    } } },
    { profile, descriptor: { ...descriptor, owners: [...descriptor.owners, descriptor.owners[0]] } },
  ];
  for (const candidate of cases) {
    const before = JSON.stringify(candidate);
    expect(() => configureRetainedOpenCodeImportAuthority(candidate.profile, candidate.descriptor))
      .toThrow();
    expect(JSON.stringify(candidate)).toBe(before);
  }
});
