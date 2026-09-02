// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execCliMock } = vi.hoisted(() => ({ execCliMock: vi.fn() }));

vi.mock('@main/utils/childProcess', () => ({
  execCli: execCliMock,
  killProcessTree: vi.fn(),
  spawnCli: vi.fn(),
}));
vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: {
    resolve: vi.fn(async () => '/test/agent-teams-cli'),
    clearCache: vi.fn(),
  },
}));
vi.mock('@main/utils/shellEnv', () => ({
  resolveInteractiveShellEnvBestEffort: vi.fn(async () => ({})),
}));
vi.mock('@main/services/runtime/providerAwareCliEnv', () => ({
  buildProviderAwareCliEnv: vi.fn(async () => ({ env: {} })),
}));

import {
  AgentTeamsRuntimeProviderManagementCliClient,
} from './AgentTeamsRuntimeProviderManagementCliClient';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function modelResponse(diagnostic: string) {
  return JSON.stringify({
    schemaVersion: 1,
    runtimeId: 'opencode',
    models: {
      runtimeId: 'opencode',
      providerId: 'openrouter',
      models: [],
      defaultModelId: null,
      diagnostics: [diagnostic],
      catalogState: 'fresh',
    },
  });
}

describe('AgentTeamsRuntimeProviderManagementCliClient model refresh generations', () => {
  beforeEach(() => {
    execCliMock.mockReset();
  });

  it('does not join a pre-refresh in-flight request or cache its response as fresh', async () => {
    const oldRequest = deferred<{ stdout: string; stderr: string }>();
    const refreshRequest = deferred<{ stdout: string; stderr: string }>();
    execCliMock
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(refreshRequest.promise);
    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const input = {
      runtimeId: 'opencode' as const,
      providerId: 'openrouter',
      projectPath: '/test/project',
    };

    const oldLoad = client.loadModels(input);
    await vi.waitFor(() => expect(execCliMock).toHaveBeenCalledTimes(1));
    const refreshedLoad = client.loadModels({ ...input, refresh: true });
    await vi.waitFor(() => expect(execCliMock).toHaveBeenCalledTimes(2));
    const duplicateRefresh = client.loadModels({ ...input, refresh: true });
    expect(execCliMock).toHaveBeenCalledTimes(2);

    refreshRequest.resolve({ stdout: modelResponse('fresh'), stderr: '' });
    await expect(Promise.all([refreshedLoad, duplicateRefresh])).resolves.toEqual([
      expect.objectContaining({
        models: expect.objectContaining({ diagnostics: ['fresh'], catalogState: 'fresh' }),
      }),
      expect.objectContaining({
        models: expect.objectContaining({ diagnostics: ['fresh'], catalogState: 'fresh' }),
      }),
    ]);
    oldRequest.resolve({ stdout: modelResponse('old'), stderr: '' });
    await expect(oldLoad).resolves.toMatchObject({
      models: { diagnostics: ['old'], catalogState: 'stale' },
    });

    await expect(client.loadModels(input)).resolves.toMatchObject({
      models: { diagnostics: ['fresh'], catalogState: 'fresh' },
    });
    expect(execCliMock).toHaveBeenCalledTimes(2);
  });

  it('fences recovered model JSON from a superseded generation', async () => {
    const oldRequest = deferred<{ stdout: string; stderr: string }>();
    const refreshRequest = deferred<{ stdout: string; stderr: string }>();
    execCliMock
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(refreshRequest.promise);
    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const input = {
      runtimeId: 'opencode' as const,
      providerId: 'openrouter',
      projectPath: '/test/project',
    };

    const oldLoad = client.loadModels(input);
    await vi.waitFor(() => expect(execCliMock).toHaveBeenCalledTimes(1));
    const refreshedLoad = client.loadModels({ ...input, refresh: true });
    await vi.waitFor(() => expect(execCliMock).toHaveBeenCalledTimes(2));

    refreshRequest.reject(
      Object.assign(new Error('Command exited after printing JSON'), {
        stdout: modelResponse('fresh'),
      })
    );
    await expect(refreshedLoad).resolves.toMatchObject({
      models: { diagnostics: ['fresh'], catalogState: 'fresh' },
    });

    const abortError = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
      stdout: modelResponse('recovered-old'),
    });
    oldRequest.reject(abortError);
    await expect(oldLoad).resolves.toMatchObject({
      models: { diagnostics: ['recovered-old'], catalogState: 'stale' },
    });

    await expect(client.loadModels(input)).resolves.toMatchObject({
      models: { diagnostics: ['fresh'], catalogState: 'fresh' },
    });
    expect(execCliMock).toHaveBeenCalledTimes(2);
  });
});
