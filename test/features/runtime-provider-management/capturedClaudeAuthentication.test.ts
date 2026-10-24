// @vitest-environment node
import { expect, it, vi } from 'vitest';

import { readCapturedClaudeAuthentication } from '../../../src/features/runtime-provider-management/main/adapters/output/capturedClaudeAuthentication';
import { CapturedProviderOAuth } from '../../../src/features/runtime-provider-management/main/adapters/output/CapturedProviderOAuth';
import { withCapturedClaudeAuthentication } from '../../../src/features/runtime-provider-management/main/adapters/output/withCapturedClaudeAuthentication';
import { addLogSink } from '../../../src/shared/utils/logger';

import type { ProviderOAuthSnapshot } from '../../../packages/legacy-agent-host/src/management/contracts';
import type { CapturedProviderManagement } from '../../../src/features/agent-backend/main/infrastructure/CapturedProviderManagement';
import type { RuntimeProviderManagementPort } from '../../../src/features/runtime-provider-management/core/application';
import type { ProviderOAuthIntent } from '../../../src/features/runtime-provider-management/main/infrastructure/FileProviderOAuthIntentStore';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';

function fixture() {
  let current = true,
    authenticated = false;
  let snapshot: ProviderOAuthSnapshot | undefined;
  const requests: { operation: string; payload: Record<string, unknown> }[] = [];
  const target: CapturedProviderManagement = {
    targetId: 'a'.repeat(64),
    profileId: 'TEST-profile',
    configRevision: 'TEST-config',
    isCurrent: () => current,
    async request(operation, payload): Promise<JsonValue> {
      requests.push({ operation, payload: structuredClone(payload) });
      if (operation === 'claude.auth')
        return {
          ok: true,
          value: {
            profileId: target.profileId,
            configRevision: target.configRevision,
            loggedIn: authenticated,
            authMethod: authenticated ? 'claude.ai' : 'none',
            canLogin: true,
            canLogout: true,
          },
        };
      if (operation === 'credential') {
        authenticated = false;
        return {
          ok: true,
          value: {
            ...payload,
            profileId: target.profileId,
            configRevision: target.configRevision,
            phase: 'completed',
          },
        };
      }
      if (operation === 'oauth.start')
        snapshot = {
          operationId: String(payload.operationId),
          profileId: target.profileId,
          configRevision: target.configRevision,
          providerId: 'anthropic',
          methodIndex: 0,
          phase: 'waiting-for-code',
          sequence: 1,
          expiresAt: Date.now() + 60000,
          completionMethod: 'code',
        };
      if (operation === 'oauth.authorization')
        return {
          ok: true,
          value: {
            authorizationUrl: 'https://TEST.invalid/authorize?state=TEST-secret',
            instructions: 'TEST-private-native-output',
            browserOwner: 'native',
          },
        };
      if (operation === 'oauth.complete') {
        authenticated = true;
        snapshot = { ...snapshot!, phase: 'completed', sequence: snapshot!.sequence + 1 };
      }
      if (operation === 'oauth.cancel')
        snapshot = { ...snapshot!, phase: 'cancelled', sequence: snapshot!.sequence + 1 };
      if (!snapshot) throw new Error('TEST unexpected management request');
      return { ok: true, value: { ...snapshot } };
    },
  };
  const intents = new Map<string, ProviderOAuthIntent>();
  const openExternal = vi.fn(async () => {});
  const oauth = new CapturedProviderOAuth({
    intents: {
      read: async (id) => intents.get(id) ?? null,
      create: async (intent) => {
        if (intents.has(intent.operationId)) return false;
        intents.set(intent.operationId, intent);
        return true;
      },
    },
    restore: async (id) => {
      expect(id).toBe(target.targetId);
      return target;
    },
    openExternal,
  });
  const capture = vi.fn(async (project: string | null) => {
    expect(project).toBe('/TEST/project');
    return target;
  });
  const fallback = vi.fn(async () => {
    throw new Error('TEST Claude action must not fall back');
  });
  const original: RuntimeProviderManagementPort = {
    loadView: fallback,
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
  const port = withCapturedClaudeAuthentication(original, capture, oauth);
  const load = () =>
    port.loadSetupForm({
      runtimeId: 'claude',
      providerId: 'anthropic',
      projectPath: '/TEST/project',
    });
  const input = (token: string) => ({
    runtimeId: 'claude' as const,
    providerId: 'anthropic',
    method: 'oauth' as const,
    authMethodIndex: 0,
    authOptionId: 'oauth:0',
    oauthOperationId: 'TEST-auth-original-operation',
    connectionContextToken: token,
    projectPath: '/TEST/project',
  });
  return {
    port,
    target,
    oauth,
    capture,
    requests,
    fallback,
    intents,
    openExternal,
    load,
    input,
    revoke: () => {
      current = false;
    },
  };
}

it('submits the original captured native form, keeps native browser ownership and returns exact safe code progress', async () => {
  const f = fixture();
  const form = await f.load();
  const events: unknown[] = [];
  const unsubscribe = f.oauth.subscribe((event) => events.push(event));
  const pending = f.port.connectProvider(f.input(form.setupForm!.connectionContextToken!));
  await vi.waitFor(() => expect(events).toHaveLength(1));
  expect(events[0]).toMatchObject({
    runtimeId: 'claude',
    operationId: 'TEST-auth-original-operation',
    phase: 'waiting-for-code',
  });
  expect(JSON.stringify(events)).not.toContain('TEST-secret');
  expect(JSON.stringify(events)).not.toContain('TEST-private-native-output');
  expect(
    await f.oauth.submitCode({
      operationId: 'TEST-auth-original-operation',
      code: 'TEST-code#TEST-state',
    })
  ).toEqual({ ok: true });
  expect((await pending).provider?.state).toBe('connected');
  expect(f.capture).toHaveBeenCalledTimes(1);
  expect(f.openExternal).not.toHaveBeenCalled();
  expect(f.fallback).not.toHaveBeenCalled();
  expect(JSON.stringify([...f.intents.values()])).not.toContain('TEST-code');
  expect(f.requests.find((row) => row.operation === 'oauth.complete')?.payload).toMatchObject({
    commandId: 'TEST-auth-original-operation:code',
  });
  unsubscribe();
});

it('refuses a revoked original form and a substituted project without selecting or dispatching to another owner', async () => {
  const f = fixture();
  const form = await f.load();
  const captured = f.input(form.setupForm!.connectionContextToken!);
  expect(
    (await f.port.connectProvider({ ...captured, projectPath: '/TEST/other-project' })).error
  ).toBeDefined();
  f.revoke();
  expect((await f.port.connectProvider(captured)).error).toBeDefined();
  expect(f.capture).toHaveBeenCalledTimes(1);
  expect(f.requests.map((row) => row.operation)).toEqual(['claude.auth']);
  expect(f.fallback).not.toHaveBeenCalled();
});

it('cancels only the original captured operation and never substitutes an empty code or a fresh login', async () => {
  const f = fixture();
  const form = await f.load();
  const pending = f.port.connectProvider(f.input(form.setupForm!.connectionContextToken!));
  await vi.waitFor(() =>
    expect(f.requests.some((row) => row.operation === 'oauth.start')).toBe(true)
  );
  expect(await f.oauth.cancel({ operationId: 'TEST-auth-original-operation' })).toEqual({
    ok: true,
  });
  expect((await pending).error).toBeDefined();
  expect(f.requests.filter((row) => row.operation === 'oauth.start')).toHaveLength(1);
  expect(f.requests.filter((row) => row.operation === 'oauth.complete')).toEqual([]);
  expect(f.fallback).not.toHaveBeenCalled();
});

it('retains the click-captured token through form refresh, metadata and explicit sign-out', async () => {
  const f = fixture();
  const form = await f.load();
  const selected = {
    runtimeId: 'claude' as const,
    providerId: 'anthropic',
    projectPath: '/TEST/project',
    connectionContextToken: form.setupForm!.connectionContextToken!,
  };
  expect((await f.port.loadSetupForm(selected)).setupForm?.connectionContextToken).toBe(
    selected.connectionContextToken
  );
  expect((await f.port.loadView(selected)).view?.runtime.localAuth).toBe('missing');
  expect((await f.port.forgetCredential(selected)).provider?.state).toBe('not-connected');
  expect(f.capture).toHaveBeenCalledTimes(1);
  expect(f.requests.filter((row) => row.operation === 'credential')).toHaveLength(1);
  expect(
    (await f.port.forgetCredential({ ...selected, connectionContextToken: undefined })).error
  ).toBeDefined();
  f.revoke();
  expect((await f.port.loadView(selected)).error).toBeDefined();
  expect((await f.port.forgetCredential(selected)).error).toBeDefined();
  expect(f.capture).toHaveBeenCalledTimes(1);
  expect(f.requests.filter((row) => row.operation === 'credential')).toHaveLength(1);
});

it('expires the original account token without a new capture or native command', async () => {
  const f = fixture();
  const form = await f.load();
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 18 * 60_000);
  try {
    expect(
      (await f.port.connectProvider(f.input(form.setupForm!.connectionContextToken!))).error
    ).toBeDefined();
    expect(f.capture).toHaveBeenCalledTimes(1);
    expect(f.requests.map((row) => row.operation)).toEqual(['claude.auth']);
  } finally {
    clock.mockRestore();
  }
});

it('retains finite original auth outcomes and context/decoding failures without private response text', async () => {
  const secret = 'TEST-private-account-error-and-path';
  const entries: unknown[] = [];
  const stop = addLogSink(entry => {
    if (entry.namespace === 'RuntimeProvider:ClaudeAuthentication') entries.push(entry.args[1]);
  });
  const value = { profileId: secret, configRevision: secret, loggedIn: true,
    authMethod: 'api_key', canLogin: false, canLogout: false };
  let current = true;
  let response: JsonValue = { ok: true, value };
  let failure: Error | undefined;
  const target: CapturedProviderManagement = { targetId: secret, profileId: secret, configRevision: secret,
    isCurrent: () => current, async request() { if (failure) throw failure; return response; } };
  try {
    await expect(readCapturedClaudeAuthentication(target)).resolves.toMatchObject({ loggedIn: true, authMethod: 'api_key', canLogin: false });
    response = { ok: true, value: { ...value, loggedIn: false, authMethod: 'none' } };
    await expect(readCapturedClaudeAuthentication(target)).resolves.toMatchObject({ loggedIn: false });
    response = { ok: false, code: 'held', error: secret };
    await expect(readCapturedClaudeAuthentication(target)).rejects.toThrow('Provider management outcome unavailable');
    response = { ok: false, code: secret };
    await expect(readCapturedClaudeAuthentication(target)).rejects.toThrow('Provider management outcome unavailable');
    response = { ok: true, value: { ...value, profileId: 'TEST-wrong-profile' } };
    await expect(readCapturedClaudeAuthentication(target)).rejects.toThrow('Claude auth state unavailable');
    response = { ok: true, value };
    current = false;
    await expect(readCapturedClaudeAuthentication(target)).rejects.toThrow('Claude auth state unavailable');
    current = true;
    failure = new Error(secret);
    await expect(readCapturedClaudeAuthentication(target)).rejects.toBe(failure);
    expect(entries).toEqual([
      { profileHash: expect.stringMatching(/^[a-f0-9]{64}$/), stage: 'result', code: 'logged-in', authMethod: 'api_key' },
      { profileHash: expect.any(String), stage: 'result', code: 'logged-out', authMethod: 'none' },
      { profileHash: expect.any(String), stage: 'outcome', code: 'host.held' },
      { profileHash: expect.any(String), stage: 'outcome', code: 'invalid-response' },
      { profileHash: expect.any(String), stage: 'decode', code: 'invalid-response' },
      { profileHash: expect.any(String), stage: 'current', code: 'changed' },
      { profileHash: expect.any(String), stage: 'request', code: 'unavailable' },
    ]);
    expect(JSON.stringify(entries)).not.toContain(secret);
  } finally { stop(); }
});
