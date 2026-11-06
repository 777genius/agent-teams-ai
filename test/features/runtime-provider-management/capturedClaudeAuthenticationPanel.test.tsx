// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { CapturedClaudeAuthenticationPanel } from '../../../src/features/runtime-provider-management/renderer/CapturedClaudeAuthenticationPanel';

import type {
  RuntimeProviderManagementConnectInput,
  RuntimeProviderManagementProviderResponse,
  RuntimeProviderOAuthProgressDto,
} from '../../../src/features/runtime-provider-management/contracts';

const h = vi.hoisted(() => ({
  recordConnection: vi.fn(),
  listeners: new Set<(event: RuntimeProviderOAuthProgressDto) => void>(),
  connect:
    vi.fn<
      (
        input: RuntimeProviderManagementConnectInput
      ) => Promise<RuntimeProviderManagementProviderResponse>
    >(),
  submitCode: vi.fn(async (_input: { operationId: string; code: string }) => ({ ok: true })),
  cancel: vi.fn(async (_input: { operationId: string }) => ({ ok: true })),
  forget: vi.fn(async () => ({ schemaVersion: 1, runtimeId: 'claude' })),
}));
const provider = {
  providerId: 'anthropic',
  displayName: 'Claude',
  state: 'connected',
  ownership: ['local'],
  recommended: false,
  modelCount: 0,
  defaultModelId: null,
  authMethods: ['oauth'],
  actions: [],
  detail: null,
} as const;
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/analytics/productAnalytics', () => ({
  classifyAnalyticsError: () => 'unknown',
  elapsedMsSince: () => 0,
  recordProviderConnectionEnd: h.recordConnection,
}));
vi.mock('@renderer/api', () => ({
  api: {
    runtimeProviderManagement: {
      loadProviderDirectory: async () => ({
        schemaVersion: 1,
        runtimeId: 'claude',
        directory: {
          runtimeId: 'claude',
          totalCount: 1,
          returnedCount: 1,
          query: null,
          filter: 'all',
          limit: 1,
          cursor: null,
          nextCursor: null,
          entries: [
            {
              providerId: 'anthropic',
              displayName: 'Claude',
              state: 'not-connected',
              ownership: ['local'],
              recommended: false,
              modelCount: null,
              defaultModelId: null,
              authMethods: ['oauth'],
              actions: [],
              detail: null,
              setupKind: 'connect-oauth',
              sources: ['inventory'],
              sourceLabel: 'Claude account',
              providerSource: 'native',
              metadata: {
                hasKnownModels: false,
                requiresManualConfig: false,
                supportedInlineAuth: true,
                configuredAuthless: false,
              },
            },
          ],
          diagnostics: [],
          fetchedAt: '2026-10-23T00:00:00Z',
        },
      }),
      loadSetupForm: async () => ({
        schemaVersion: 1,
        runtimeId: 'claude',
        setupForm: {
          runtimeId: 'claude',
          connectionContextToken: 'TEST-original-form-token',
          providerId: 'anthropic',
          displayName: 'Claude',
          method: 'oauth',
          supported: true,
          title: 'Sign in to Claude',
          description: null,
          submitLabel: 'Sign in with browser',
          disabledReason: null,
          source: 'oauth',
          secret: null,
          prompts: [],
          authOptions: [
            {
              id: 'oauth:0',
              method: 'oauth',
              methodIndex: 0,
              label: 'Claude subscription',
              supported: true,
              disabledReason: null,
              secret: null,
              prompts: [],
            },
          ],
          defaultAuthOptionId: 'oauth:0',
          verification: null,
        },
      }),
      connectProvider: h.connect,
      submitOAuthCode: h.submitCode,
      cancelOAuth: h.cancel,
      forgetCredential: h.forget,
      onOAuthProgress: (listener: (event: RuntimeProviderOAuthProgressDto) => void) => {
        h.listeners.add(listener);
        return () => h.listeners.delete(listener);
      },
    },
  },
}));

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
let resolveConnect: (response: RuntimeProviderManagementProviderResponse) => void;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  h.listeners.clear();
  h.recordConnection.mockClear();
  h.connect.mockReset();
  h.submitCode.mockClear();
  h.cancel.mockClear();
  h.forget.mockClear();
  h.connect.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveConnect = resolve;
      })
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const settle = async (check: () => void) => {
  let failure: unknown;
  for (let i = 0; i < 30; i++) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 10));
    });
    try {
      check();
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
};
async function start() {
  await act(async () =>
    root.render(
      <CapturedClaudeAuthenticationPanel
        open
        projectPath="/TEST/original-project"
        action="login"
        connectionContextToken="TEST-original-form-token"
      />
    )
  );
  await settle(() =>
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false)
  );
  await act(async () => host.querySelector<HTMLFormElement>('form')!.requestSubmit());
  const input = h.connect.mock.calls[0]![0];
  await act(async () => {
    for (const listener of h.listeners)
      listener({
        operationId: input.oauthOperationId!,
        runtimeId: 'claude',
        providerId: 'anthropic',
        displayName: 'Claude',
        authOptionId: 'oauth:0',
        methodIndex: 0,
        phase: 'waiting-for-code',
        completionMethod: 'code',
        instructions: 'Complete sign-in and enter the returned code.',
        message: null,
      });
  });
  return input;
}

it('uses the original sign-in/code controls with exact captured form context and no terminal arguments', async () => {
  const input = await start();
  expect(input).toMatchObject({
    runtimeId: 'claude',
    providerId: 'anthropic',
    projectPath: '/TEST/original-project',
    connectionContextToken: 'TEST-original-form-token',
    authOptionId: 'oauth:0',
    authMethodIndex: 0,
  });
  expect(Object.keys(input)).not.toContain('command');
  const code = host.querySelector<HTMLInputElement>('input[aria-label="Authorization code"]');
  expect(code).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      code,
      'TEST-code#TEST-state'
    );
    code!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const continuation = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === 'Continue'
  )!;
  await act(async () => continuation.click());
  expect(h.submitCode).toHaveBeenCalledWith({
    operationId: input.oauthOperationId,
    code: 'TEST-code#TEST-state',
  });
  await act(async () => {
    resolveConnect({ schemaVersion: 1, runtimeId: 'claude', provider });
    await new Promise((done) => setTimeout(done, 0));
  });
  expect(h.connect).toHaveBeenCalledTimes(1);
  expect(h.recordConnection).toHaveBeenCalledWith(
    expect.objectContaining({ runtime: 'claude', outcome: 'connected_unverified' })
  );
});

it('existing Cancel targets only the original pending operation and does not submit an empty code', async () => {
  const input = await start();
  const cancel = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === 'runtimeProvider.actions.cancel'
  )!;
  await act(async () => cancel.click());
  expect(h.cancel).toHaveBeenCalledWith({ operationId: input.oauthOperationId });
  expect(h.submitCode).not.toHaveBeenCalled();
  await act(async () => {
    resolveConnect({
      schemaVersion: 1,
      runtimeId: 'claude',
      error: { code: 'auth-failed', message: 'Sign-in cancelled.', recoverable: true },
    });
    await new Promise((done) => setTimeout(done, 0));
  });
  expect(h.connect).toHaveBeenCalledTimes(1);
});
