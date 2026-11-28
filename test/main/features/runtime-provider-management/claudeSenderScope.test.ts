import { expect, it, vi } from 'vitest';
import { createRuntimeProviderManagementFeature } from '../../../../src/features/runtime-provider-management/main/composition/createRuntimeProviderManagementFeature';
import { registerRuntimeProviderManagementIpc } from '../../../../src/features/runtime-provider-management/main/adapters/input/registerRuntimeProviderManagementIpc';
import { withCapturedClaudeAuthentication } from '../../../../src/features/runtime-provider-management/main/adapters/output/withCapturedClaudeAuthentication';
import {
  RUNTIME_PROVIDER_MANAGEMENT_SETUP_FORM,
  RUNTIME_PROVIDER_MANAGEMENT_VIEW,
} from '../../../../src/features/runtime-provider-management/contracts';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { RuntimeProviderManagementPort } from '../../../../src/features/runtime-provider-management/core/application';
import type { CapturedProviderManagement } from '@features/agent-backend/main';

function fixture(selected = true) {
  let current = true;
  let release: (() => void) | undefined;
  let paused = false;
  const requests: string[] = [];
  const fallback = vi.fn(async () => {
    throw new Error('TEST unexpected legacy route');
  });
  const legacyView = vi.fn(async (input: { runtimeId: 'opencode' | 'claude' }) => ({
    schemaVersion: 1 as const,
    runtimeId: input.runtimeId,
    error: {
      code: 'unsupported-action' as const,
      message: 'TEST unchanged existing owner',
      recoverable: true,
    },
  }));
  const original: RuntimeProviderManagementPort = {
    loadView: legacyView,
    loadProviderDirectory: fallback,
    loadSetupForm: fallback,
    connectProvider: fallback,
    connectWithApiKey: fallback,
    forgetCredential: fallback,
    loadModels: fallback,
    cancelModelLoad: fallback,
    testModel: fallback,
    cancelModelTest: fallback,
    setDefaultModel: fallback,
    clearProjectDefaultModel: fallback,
    configureModelLimits: fallback,
    submitOAuthCode: fallback,
    cancelOAuth: fallback,
    onOAuthProgress: () => () => {},
  };
  const capture = vi.fn(
    async (_project: string | null, guard?: () => boolean): Promise<CapturedProviderManagement> => {
      if (paused)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return {
        targetId: 'a'.repeat(64),
        profileId: 'TEST-profile',
        configRevision: 'TEST-revision',
        isCurrent: () => guard?.() ?? true,
        async request(operation) {
          if (guard && !guard()) throw new Error('TEST stale captured sender');
          requests.push(operation);
          return {
            ok: true,
            value: {
              profileId: 'TEST-profile',
              configRevision: 'TEST-revision',
              loggedIn: false,
              canLogin: true,
              canLogout: true,
              authMethod: 'none',
            },
          };
        },
      };
    }
  );
  const port = selected ? withCapturedClaudeAuthentication(original, capture, undefined) : original;
  const feature = createRuntimeProviderManagementFeature({ port });
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>
  >();
  const ipc = {
    handle: (
      name: string,
      handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>
    ) => {
      handlers.set(name, handler);
    },
  } as unknown as IpcMain;
  const event = {} as IpcMainInvokeEvent;
  registerRuntimeProviderManagementIpc(
    ipc,
    feature,
    selected ? (sender) => (sender === event ? () => current : null) : undefined
  );
  const invoke = (channel: string, input: unknown, sender = event) =>
    handlers.get(channel)!(sender, input);
  return {
    invoke,
    capture,
    requests,
    fallback: legacyView,
    port,
    revoke: () => {
      current = false;
    },
    pause: () => {
      paused = true;
    },
    resume: () => release?.(),
  };
}
const input = {
  runtimeId: 'claude',
  providerId: 'anthropic',
  projectPath: '/TEST/project',
};

it('rejects an untrusted IPC sender before the real facade selects any Claude target', async () => {
  const f = fixture();
  expect(
    await f.invoke(RUNTIME_PROVIDER_MANAGEMENT_SETUP_FORM, input, {} as IpcMainInvokeEvent)
  ).toMatchObject({ error: { code: 'runtime-unhealthy' } });
  expect(f.capture).not.toHaveBeenCalled();
  expect(f.requests).toEqual([]);
  expect(vi.mocked(console.error).mock.calls).toEqual([
    [
      '[Feature:RuntimeProviderManagement:IPC]',
      'Failed to load runtime provider setup form',
      'Original Claude account sender is unavailable',
    ],
  ]);
  vi.mocked(console.error).mockClear();
});

it('carries the original sender guard through async target capture and refuses revocation before native status', async () => {
  const f = fixture();
  f.pause();
  const pending = f.invoke(RUNTIME_PROVIDER_MANAGEMENT_SETUP_FORM, input);
  await vi.waitFor(() => expect(f.capture).toHaveBeenCalledOnce());
  f.revoke();
  f.resume();
  expect(await pending).toMatchObject({ error: { code: 'runtime-unhealthy' } });
  expect(f.requests).toEqual([]);
});

it('retains the original sender-bound token and refuses a later request after that authority is revoked', async () => {
  const f = fixture();
  const result = (await f.invoke(RUNTIME_PROVIDER_MANAGEMENT_SETUP_FORM, input)) as {
    setupForm: { connectionContextToken: string };
  };
  expect(result.setupForm.connectionContextToken).toBeTruthy();
  expect(
    await f.invoke(RUNTIME_PROVIDER_MANAGEMENT_VIEW, {
      ...input,
      connectionContextToken: result.setupForm.connectionContextToken,
    })
  ).toMatchObject({ view: { runtimeId: 'claude' } });
  f.revoke();
  expect(
    await f.invoke(RUNTIME_PROVIDER_MANAGEMENT_VIEW, {
      ...input,
      connectionContextToken: result.setupForm.connectionContextToken,
    })
  ).toMatchObject({ error: { code: 'runtime-unhealthy' } });
  expect(f.capture).toHaveBeenCalledOnce();
  expect(f.requests).toEqual(['claude.auth', 'claude.auth']);
  expect(vi.mocked(console.error).mock.calls).toEqual([
    [
      '[Feature:RuntimeProviderManagement:IPC]',
      'Failed to load runtime provider management view',
      'Original Claude account sender is unavailable',
    ],
  ]);
  vi.mocked(console.error).mockClear();
});

it('leaves the existing OpenCode path unchanged rather than claiming broader sender qualification', async () => {
  const f = fixture();
  expect(
    await f.invoke(
      RUNTIME_PROVIDER_MANAGEMENT_VIEW,
      { runtimeId: 'opencode' },
      {} as IpcMainInvokeEvent
    )
  ).toMatchObject({ runtimeId: 'opencode', error: { message: 'TEST unchanged existing owner' } });
  expect(f.fallback).toHaveBeenCalledOnce();
  expect(f.capture).not.toHaveBeenCalled();
});

it('preserves original legacy Claude settings when Main selects the legacy port without a Host sender callback', async () => {
  const f = fixture(false);
  expect(await f.invoke(RUNTIME_PROVIDER_MANAGEMENT_VIEW, { runtimeId: 'claude' })).toMatchObject({
    runtimeId: 'claude',
    error: { message: 'TEST unchanged existing owner' },
  });
  expect(f.fallback).toHaveBeenCalledOnce();
  expect(f.capture).not.toHaveBeenCalled();
  expect(f.requests).toEqual([]);
});
