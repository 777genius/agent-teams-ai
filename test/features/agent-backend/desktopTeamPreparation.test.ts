// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hostTeamSelectionKey } from '../../../src/features/agent-backend/contracts';
import {
  BackendOperationsFacade,
  DesktopBackendFeature,
} from '../../../src/features/agent-backend/main';
import {
  prepareDesktopCapturedTeam,
  registerDesktopAgentBackend,
  removeDesktopAgentBackendHandlers,
  shutdownDesktopAgentBackend,
} from '../../../src/main/ipc/agentBackend';

import type {
  BackendLaunchConfigurationView,
  BackendLaunchModelProbe,
} from '../../../src/features/agent-backend/contracts/launch';
import type { BackendOperationRequest } from '../../../src/features/agent-backend/contracts/operations';
import type { CapturedTeamModelRequest } from '../../../src/features/agent-backend/main';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';

afterEach(async () => {
  await shutdownDesktopAgentBackend();
  removeDesktopAgentBackendHandlers();
  vi.restoreAllMocks();
});

function fixture() {
  const url = 'http://localhost:5173/';
  const frame = { url };
  const contents = { mainFrame: frame, isDestroyed: () => false, getURL: () => url };
  const window = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow;
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  let context = 'TEST-original-context';
  const handle = { handleId: 'TEST-original' };
  const initialize = vi.spyOn(DesktopBackendFeature.prototype, 'initialize').mockResolvedValue();
  vi.spyOn(DesktopBackendFeature.prototype, 'listBindings').mockReturnValue({
    state: 'ready',
    bindings: [{ handle, label: 'TEST', members: [] }],
  });
  vi.spyOn(DesktopBackendFeature.prototype, 'authorizeHandle').mockImplementation(
    (id, selected) => id === 'TEST-original-context' && selected.handleId === handle.handleId
  );
  const view: BackendLaunchConfigurationView = {
    launch: {
      launchId: 'TEST-launch',
      rosterRevision: 'TEST-roster',
      status: 'pending',
      ready: 0,
      expected: 1,
      retryCapability: 'same-binding-no-allocation-only',
      members: [],
    },
    members: [
      {
        memberId: 'TEST-member',
        label: 'Lead',
        role: 'lead',
        selected: {
          provider: 'claude',
          model: 'opus',
          workspace: '/TEST/workspace',
          capabilities: ['model'],
        },
      },
    ],
  };
  const probes = new Map<string, BackendLaunchModelProbe>();
  const invoke = vi
    .spyOn(BackendOperationsFacade.prototype, 'invoke')
    .mockImplementation(async (raw) => {
      const input = raw as BackendOperationRequest;
      if (input.operation === 'team.launch.model.configuration.read')
        return {
          ok: true,
          value: {
            source: { sourceId: view.launch.launchId, rosterRevision: view.launch.rosterRevision },
            members: structuredClone(view.members),
          },
        };
      if (input.operation === 'team.launch.probe.start')
        probes.set(input.commandId, {
          ...input.payload,
          commandId: input.commandId,
          phase: 'completed',
          ok: true,
          expiresAt: Date.now() + 60000,
        });
      return { ok: true, value: probes.get(input.commandId) ?? null };
    });
  registerDesktopAgentBackend({
    ipc: { handle() {}, removeHandler() {} } as Pick<IpcMain, 'handle' | 'removeHandler'>,
    getMainWindow: () => window,
    getActiveContextId: () => context,
    captureActiveSelection: () => {
      const captured = context;
      return { contextId: captured, isCurrent: () => context === captured };
    },
    rendererIndexPath: '/TEST/no-file-read/index.html',
    userDataPath: '/TEST/no-file-write/userData',
    env: {
      NODE_ENV: 'development',
      AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH: '/TEST/mocked-descriptor',
      AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256: '0'.repeat(64),
    },
  });
  const request: CapturedTeamModelRequest = {
    cwd: '/TEST/workspace',
    providerId: 'anthropic',
    modelChecks: [{ providerId: 'anthropic', model: 'opus' }],
  };
  const prepare = () =>
    prepareDesktopCapturedTeam(event, hostTeamSelectionKey(handle.handleId), request);
  return {
    event,
    frame,
    handle,
    request,
    prepare,
    initialize,
    invoke,
    setContext: (value: string) => {
      context = value;
    },
  };
}

describe('existing preparation captured shell port', () => {
  it('supersedes an in-flight selection and awaits original cleanup before admitting only the latest draft', async () => {
    const f = fixture();
    const normal = f.invoke.getMockImplementation()!;
    let releaseStart!: () => void, releaseCancel!: () => void;
    const startResponse = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const cancellation = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const effects: string[] = [];
    const records = new Map<string, BackendLaunchModelProbe>();
    let held = false;
    f.invoke.mockImplementation(async (raw, guard) => {
      const input = raw as BackendOperationRequest;
      if (input.operation === 'team.launch.model.configuration.read') return normal(raw, guard);
      if (input.operation === 'team.launch.probe.start') {
        const model = input.payload.model;
        effects.push(`start:${model}`);
        // A real namespace fence rejects this before creating a second journal record.
        if (held) return { ok: false, code: 'busy', outcome: 'rejected' };
        held = true;
        records.set(input.commandId, {
          ...input.payload,
          commandId: input.commandId,
          phase: model === 'sonnet' ? 'running' : 'completed',
          ok: model !== 'sonnet',
          expiresAt: Date.now() + 60000,
        });
        if (model === 'sonnet') await startResponse;
        else held = false;
      }
      if (input.operation === 'team.launch.probe.cancel') {
        expect(guard).toBeUndefined();
        expect(input.handle).toEqual(f.handle);
        expect(records.get(input.commandId)?.model).toBe('sonnet');
        effects.push('cancel:sonnet');
        await cancellation;
        held = false;
        effects.push('released:sonnet');
        const original = records.get(input.commandId)!;
        records.set(input.commandId, { ...original, phase: 'cancelled', ok: false });
      }
      return { ok: true, value: records.get(input.commandId) ?? null };
    });
    const prepare = (model: string) =>
      prepareDesktopCapturedTeam(f.event, hostTeamSelectionKey(f.handle.handleId), {
        ...f.request,
        modelChecks: [{ providerId: 'anthropic', model }],
      });
    const original = prepare('sonnet');
    await vi.waitFor(() => expect(effects).toEqual(['start:sonnet']));
    const intermediate = prepare('TEST-intermediate');
    const latest = prepare('opus');
    const duplicate = prepare('opus');
    releaseStart();
    await vi.waitFor(() => expect(effects).toEqual(['start:sonnet', 'cancel:sonnet']));
    expect(held).toBe(true);
    releaseCancel();
    expect((await original).ready).toBe(false);
    expect((await intermediate).ready).toBe(false);
    expect((await latest).ready).toBe(true);
    expect((await duplicate).ready).toBe(true);
    expect(effects).toEqual(['start:sonnet', 'cancel:sonnet', 'released:sonnet', 'start:opus']);
    expect([...records.values()].filter((probe) => probe.phase === 'completed')).toHaveLength(1);
  });

  it('rejects a different frame or handle before any model operation', async () => {
    const f = fixture();
    expect(
      (
        await prepareDesktopCapturedTeam(
          { ...f.event, senderFrame: { url: f.frame.url } } as unknown as IpcMainInvokeEvent,
          hostTeamSelectionKey(f.handle.handleId),
          f.request
        )
      ).ready
    ).toBe(false);
    expect(f.initialize).not.toHaveBeenCalled();
    expect(
      (await prepareDesktopCapturedTeam(f.event, hostTeamSelectionKey('TEST-forged'), f.request))
        .ready
    ).toBe(false);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('captures desired options before initialization and refuses an intervening shell context switch', async () => {
    const f = fixture();
    let release!: () => void;
    f.initialize.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const first = f.prepare();
    f.request.cwd = '/TEST/late-mutation';
    release();
    expect((await first).ready).toBe(true);
    f.invoke.mockClear();
    f.initialize.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const second = f.prepare();
    f.setContext('TEST-replacement-context');
    release();
    expect((await second).ready).toBe(false);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('drops foreground work authority but retains only original probe cancellation after navigation', async () => {
    const f = fixture();
    const normal = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (input, guard) => {
      const request = input as BackendOperationRequest;
      const result = await normal(input, guard);
      if (request.operation === 'team.launch.probe.start') f.setContext('TEST-replacement-context');
      return result;
    });
    expect((await f.prepare()).ready).toBe(false);
    const start = f.invoke.mock.calls.find(
      ([input]) => (input as BackendOperationRequest).operation === 'team.launch.probe.start'
    )!;
    const cancel = f.invoke.mock.calls.find(
      ([input]) => (input as BackendOperationRequest).operation === 'team.launch.probe.cancel'
    )!;
    expect(start[1]?.isCurrent()).toBe(false);
    expect(cancel[1]).toBeUndefined();
    expect(cancel[0]).toMatchObject({
      handle: { handleId: 'TEST-original' },
      commandId: (start[0] as BackendOperationRequest).commandId,
    });
  });
});
