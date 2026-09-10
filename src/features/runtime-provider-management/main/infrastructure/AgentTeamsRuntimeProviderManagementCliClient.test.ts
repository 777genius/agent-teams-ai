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

import { AgentTeamsRuntimeProviderManagementCliClient } from './AgentTeamsRuntimeProviderManagementCliClient';

import type { RuntimeProviderManagementDirectoryResponse } from '../../contracts';

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
    execCliMock.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(refreshRequest.promise);
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
    execCliMock.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(refreshRequest.promise);
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

const inventoryTimeout =
  'OpenCode inventory probe timed out after 8000ms during prepare managed OpenCode profile: reconcile managed auth stores';
const directoryInput = {
  runtimeId: 'opencode' as const,
  projectPath: '/test/project',
  summary: true,
  query: null,
  filter: 'all' as const,
  limit: 100,
  cursor: null,
};

function directoryResponse(fallback = false): RuntimeProviderManagementDirectoryResponse {
  return {
    schemaVersion: 1,
    runtimeId: 'opencode',
    directory: {
      runtimeId: 'opencode',
      totalCount: 1,
      returnedCount: 1,
      query: null,
      filter: 'all',
      limit: 100,
      cursor: null,
      nextCursor: null,
      fetchedAt: '2026-09-06T00:00:00.000Z',
      diagnostics: fallback ? [inventoryTimeout] : [],
      entries: [
        {
          providerId: 'openrouter',
          displayName: 'OpenRouter',
          state: fallback ? 'not-connected' : 'connected',
          setupKind: 'connect-api-key',
          ownership: [],
          recommended: false,
          modelCount: fallback ? null : 505,
          authMethods: [],
          defaultModelId: null,
          sources: fallback ? ['seed'] : ['opencode-provider'],
          sourceLabel: null,
          providerSource: null,
          detail: null,
          actions: [],
          metadata: {
            hasKnownModels: !fallback,
            requiresManualConfig: false,
            supportedInlineAuth: true,
            configuredAuthless: false,
          },
        },
      ],
    },
  };
}

const directoryOutput = (response: RuntimeProviderManagementDirectoryResponse) => ({
  stdout: JSON.stringify(response),
  stderr: '',
});

function expectDirectoryWarnings(count: number): void {
  const calls = vi.mocked(console.warn).mock.calls;
  expect(calls).toHaveLength(count);
  for (const call of calls) {
    expect(call).toEqual([
      '[OpenCodeCatalog]',
      expect.stringMatching(/^OpenCode catalog provider_directory failed, report oc-[a-f0-9]{32}$/),
      expect.objectContaining({
        message: expect.any(String),
        diagnostics: expect.objectContaining({
          reportId: expect.stringMatching(/^oc-[a-f0-9]{32}$/),
        }),
      }),
    ]);
    const logged = call[2] as { diagnostics: { reportId: string } };
    expect(call[1]).toBe(
      `OpenCode catalog provider_directory failed, report ${logged.diagnostics.reportId}`
    );
  }
  vi.mocked(console.warn).mockClear();
}

describe('AgentTeamsRuntimeProviderManagementCliClient passive directory timeout', () => {
  beforeEach(() => {
    execCliMock.mockReset();
  });

  it('returns a recoverable error without retrying or caching the seed-only timeout', async () => {
    execCliMock.mockResolvedValue(directoryOutput(directoryResponse(true)));
    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const response = await client.loadProviderDirectory(directoryInput);
    expect(response.directory).toBeUndefined();
    expect(response.error).toMatchObject({ code: 'runtime-unhealthy', recoverable: true });
    expect(response.error!.message).toContain(inventoryTimeout);
    expect(execCliMock).toHaveBeenCalledTimes(1);
    await client.loadProviderDirectory(directoryInput);
    expect(execCliMock).toHaveBeenCalledTimes(2);
    for (const [, args] of execCliMock.mock.calls) expect(args).toContain('--summary');
    expectDirectoryWarnings(2);
  });

  it('keeps the previous catalog on a failed refresh without caching the error', async () => {
    const good = directoryResponse();
    execCliMock
      .mockResolvedValueOnce(directoryOutput(good))
      .mockResolvedValueOnce(directoryOutput(directoryResponse(true)))
      .mockResolvedValueOnce(directoryOutput(good));
    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    await client.loadProviderDirectory(directoryInput);
    const failure = await client.loadProviderDirectory({ ...directoryInput, refresh: true });
    expect(failure.directory).toEqual(good.directory);
    expect(failure.error?.code).toBe('runtime-unhealthy');
    expect(execCliMock).toHaveBeenCalledTimes(2);
    expect((await client.loadProviderDirectory(directoryInput)).error).toBeUndefined();
    expect(execCliMock).toHaveBeenCalledTimes(3);
    expectDirectoryWarnings(1);
  });

  it('never borrows a previous directory from another project, filter or page', async () => {
    execCliMock
      .mockResolvedValueOnce(directoryOutput(directoryResponse()))
      .mockResolvedValue(directoryOutput(directoryResponse(true)));
    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    await client.loadProviderDirectory(directoryInput);
    for (const scope of [
      { projectPath: '/test/other' },
      { filter: 'connected' as const },
      { cursor: '100' },
    ]) {
      const response = await client.loadProviderDirectory({ ...directoryInput, ...scope });
      expect(response.directory).toBeUndefined();
      expect(response.error?.code).toBe('runtime-unhealthy');
    }
    expectDirectoryWarnings(3);
  });

  it('handles an empty filtered timeout result as unknown rather than no connected providers', async () => {
    const response = directoryResponse(true);
    response.directory!.entries = [];
    response.directory!.totalCount = 0;
    response.directory!.returnedCount = 0;
    execCliMock.mockResolvedValue(directoryOutput(response));
    expect(
      (
        await new AgentTeamsRuntimeProviderManagementCliClient().loadProviderDirectory({
          ...directoryInput,
          filter: 'connected',
        })
      ).error?.code
    ).toBe('runtime-unhealthy');
    expect(execCliMock).toHaveBeenCalledTimes(1);
    expectDirectoryWarnings(1);
  });

  it.each([
    { label: 'no diagnostic', diagnostics: [] },
    {
      label: 'profile-scope warning',
      diagnostics: ['OpenCode profile scope auth evidence is invalid'],
    },
    { label: 'other timeout', diagnostics: ['OpenCode host startup timed out'] },
  ])('preserves legitimate seed-only results with $label', async ({ diagnostics }) => {
    const response = directoryResponse(true);
    response.directory!.diagnostics = diagnostics;
    execCliMock.mockResolvedValue(directoryOutput(response));
    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    expect(await client.loadProviderDirectory(directoryInput)).toEqual(response);
    expect(await client.loadProviderDirectory(directoryInput)).toEqual(response);
    expect(execCliMock).toHaveBeenCalledTimes(1);
  });

  it.each(['connected', 'configured-authless', 'inventory-source'] as const)(
    'does not discard %s evidence when a timeout warning accompanies it',
    async (evidence) => {
      const response = directoryResponse(true);
      const entry = response.directory!.entries[0];
      if (evidence === 'connected') entry.state = 'connected';
      if (evidence === 'configured-authless') entry.metadata.configuredAuthless = true;
      if (evidence === 'inventory-source') entry.sources = ['seed', 'inventory'];
      execCliMock.mockResolvedValue(directoryOutput(response));
      expect(
        await new AgentTeamsRuntimeProviderManagementCliClient().loadProviderDirectory(
          directoryInput
        )
      ).toEqual(response);
      expect(execCliMock).toHaveBeenCalledTimes(1);
    }
  );

  it('leaves explicit non-summary calls unchanged', async () => {
    const response = directoryResponse(true);
    execCliMock.mockResolvedValue(directoryOutput(response));
    expect(
      await new AgentTeamsRuntimeProviderManagementCliClient().loadProviderDirectory({
        ...directoryInput,
        summary: false,
      })
    ).toEqual(response);
    expect(execCliMock).toHaveBeenCalledTimes(1);
  });

  it('shares the existing in-flight request without adding a timeout retry', async () => {
    const pending = deferred<ReturnType<typeof directoryOutput>>();
    execCliMock.mockReturnValueOnce(pending.promise);
    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const first = client.loadProviderDirectory(directoryInput);
    const joined = client.loadProviderDirectory(directoryInput);
    await vi.waitFor(() => expect(execCliMock).toHaveBeenCalledTimes(1));
    pending.resolve(directoryOutput(directoryResponse(true)));
    const [left, right] = await Promise.all([first, joined]);
    expect(left).toEqual(right);
    expect(left.error?.code).toBe('runtime-unhealthy');
    expect(execCliMock).toHaveBeenCalledTimes(1);
    expectDirectoryWarnings(1);
  });

  it('normalizes timeout JSON recovered from a failed command without caching it', async () => {
    execCliMock.mockRejectedValue(
      Object.assign(new Error('Command failed after JSON'), {
        stdout: JSON.stringify(directoryResponse(true)),
      })
    );
    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    expect((await client.loadProviderDirectory(directoryInput)).error?.code).toBe(
      'runtime-unhealthy'
    );
    await client.loadProviderDirectory(directoryInput);
    expect(execCliMock).toHaveBeenCalledTimes(2);
    expectDirectoryWarnings(2);
  });

  it('preserves the no-cache policy for successful JSON recovered from a failed command', async () => {
    execCliMock.mockRejectedValue(
      Object.assign(new Error('Command failed after JSON'), {
        stdout: JSON.stringify(directoryResponse()),
      })
    );
    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    await client.loadProviderDirectory(directoryInput);
    await client.loadProviderDirectory(directoryInput);
    expect(execCliMock).toHaveBeenCalledTimes(2);
  });

  it('does not let a late timeout overwrite a newer successful refresh', async () => {
    const stale = deferred<ReturnType<typeof directoryOutput>>();
    execCliMock
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(directoryOutput(directoryResponse()));
    const client = new AgentTeamsRuntimeProviderManagementCliClient();
    const old = client.loadProviderDirectory(directoryInput);
    await vi.waitFor(() => expect(execCliMock).toHaveBeenCalledTimes(1));
    await client.loadProviderDirectory({ ...directoryInput, refresh: true });
    stale.resolve(directoryOutput(directoryResponse(true)));
    expect((await old).error?.code).toBe('runtime-unhealthy');
    expect((await client.loadProviderDirectory(directoryInput)).directory?.entries[0].state).toBe(
      'connected'
    );
    expect(execCliMock).toHaveBeenCalledTimes(2);
    expectDirectoryWarnings(1);
  });
});
