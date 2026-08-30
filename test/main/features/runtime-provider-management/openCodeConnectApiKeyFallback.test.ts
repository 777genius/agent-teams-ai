import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recoverOpenCodeConnectApiKeyVerifyFailure } from '../../../../src/features/runtime-provider-management/main/infrastructure/openCodeConnectApiKeyFallback';

import type {
  RuntimeProviderConnectionDto,
  RuntimeProviderManagementProviderResponse,
  RuntimeProviderManagementViewResponse,
} from '../../../../src/features/runtime-provider-management/contracts';

const VERIFY_FAILURE_MESSAGE =
  'OpenCode could not verify provider anthropic with 3 model candidates: ' +
  'anthropic/claude-sonnet-4-5: Not Found; anthropic/claude-haiku-4-5: Not Found; ' +
  'anthropic/claude-opus-4-1: Not Found';
const API_KEY = 'sk-ant-test-key-1234567890';

function createVerifyFailureResponse(): RuntimeProviderManagementProviderResponse {
  return {
    schemaVersion: 1,
    runtimeId: 'opencode',
    error: {
      code: 'auth-failed',
      message: VERIFY_FAILURE_MESSAGE,
      recoverable: true,
      diagnostics: {
        summary: 'OpenCode could not verify provider anthropic',
        likelyCause: null,
        binaryPath: null,
        command: null,
        projectPath: null,
        exitCode: 1,
        stderrPreview: null,
        stdoutPreview: null,
        hints: [],
      },
    },
  };
}

function createProviderConnection(
  providerId: string,
  state: RuntimeProviderConnectionDto['state']
): RuntimeProviderConnectionDto {
  return {
    providerId,
    displayName: providerId,
    state,
    ownership: ['managed'],
    recommended: false,
    modelCount: state === 'connected' ? 3 : 0,
    defaultModelId: null,
    authMethods: ['api'],
    actions: [],
    detail: null,
  };
}

function createViewResponse(
  providers: readonly RuntimeProviderConnectionDto[]
): RuntimeProviderManagementViewResponse {
  return {
    schemaVersion: 1,
    runtimeId: 'opencode',
    view: {
      runtimeId: 'opencode',
      title: 'OpenCode',
      runtime: {
        state: 'ready',
        cliPath: '/opt/homebrew/bin/opencode',
        version: '1.0.0',
        managedProfile: 'active',
        localAuth: 'synced',
      },
      providers,
      defaultModel: null,
      fallbackModel: null,
      diagnostics: [],
    },
  };
}

function readStore(authStorePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(authStorePath, 'utf8')) as Record<string, unknown>;
}

describe('recoverOpenCodeConnectApiKeyVerifyFailure', () => {
  let tempDir: string;
  let authStorePath: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let host: {
    loadView: ReturnType<typeof vi.fn>;
    invalidateProviderCaches: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-opencode-auth-store-'));
    authStorePath = path.join(tempDir, 'auth.json');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    host = {
      loadView: vi.fn(),
      invalidateProviderCaches: vi.fn(),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function recover(
    response: RuntimeProviderManagementProviderResponse,
    providerId = 'anthropic'
  ): Promise<RuntimeProviderManagementProviderResponse> {
    return recoverOpenCodeConnectApiKeyVerifyFailure(
      { runtimeId: 'opencode', providerId, apiKey: API_KEY },
      response,
      host,
      { authStorePath }
    );
  }

  it('commits a directly verified key, re-reads provider status, and reports the connected provider', async () => {
    fs.writeFileSync(
      authStorePath,
      JSON.stringify({ cursor: { type: 'oauth', refresh: 'cursor-refresh' } })
    );
    fetchMock.mockResolvedValue(new Response('{"data": []}', { status: 200 }));
    let storeAtViewTime: Record<string, unknown> | null = null;
    host.loadView.mockImplementation(() => {
      storeAtViewTime = readStore(authStorePath);
      return Promise.resolve(createViewResponse([createProviderConnection('anthropic', 'connected')]));
    });

    const response = await recover(createVerifyFailureResponse());

    expect(response.error).toBeUndefined();
    expect(response.provider?.providerId).toBe('anthropic');
    expect(response.provider?.state).toBe('connected');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-api-key': API_KEY }),
      })
    );
    // The credential must be active in the store before the status re-read.
    expect(storeAtViewTime).toEqual({
      cursor: { type: 'oauth', refresh: 'cursor-refresh' },
      anthropic: { type: 'api', key: API_KEY },
    });
    expect(readStore(authStorePath)).toEqual({
      cursor: { type: 'oauth', refresh: 'cursor-refresh' },
      anthropic: { type: 'api', key: API_KEY },
    });
    expect(host.invalidateProviderCaches).toHaveBeenCalled();
    expect(host.invalidateProviderCaches.mock.invocationCallOrder[0]).toBeLessThan(
      host.loadView.mock.invocationCallOrder[0]
    );
    expect(fs.readdirSync(tempDir)).toEqual(['auth.json']);
  });

  it('writes nothing when the provider API rejects the key', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"error": {"type": "authentication_error", "message": "invalid x-api-key"}}', {
        status: 401,
      })
    );

    const original = createVerifyFailureResponse();
    const response = await recover(original);

    expect(response).toBe(original);
    expect(fs.existsSync(authStorePath)).toBe(false);
    expect(host.loadView).not.toHaveBeenCalled();
  });

  it('writes nothing when direct verification is inconclusive', async () => {
    fetchMock.mockRejectedValue(new Error('network unreachable'));

    const original = createVerifyFailureResponse();
    const response = await recover(original);

    expect(response).toBe(original);
    expect(fs.existsSync(authStorePath)).toBe(false);
  });

  it('rolls the committed credential back when the provider still does not report connected', async () => {
    fs.writeFileSync(authStorePath, JSON.stringify({ cursor: { type: 'oauth' } }));
    fetchMock.mockResolvedValue(new Response('{"data": []}', { status: 200 }));
    let storeAtViewTime: Record<string, unknown> | null = null;
    host.loadView.mockImplementation(() => {
      storeAtViewTime = readStore(authStorePath);
      return Promise.resolve(createViewResponse([createProviderConnection('anthropic', 'not-connected')]));
    });

    const original = createVerifyFailureResponse();
    const response = await recover(original);

    expect(storeAtViewTime).toEqual({
      cursor: { type: 'oauth' },
      anthropic: { type: 'api', key: API_KEY },
    });
    expect(readStore(authStorePath)).toEqual({ cursor: { type: 'oauth' } });
    expect(response.provider).toBeUndefined();
    expect(response.error?.message).toContain(VERIFY_FAILURE_MESSAGE);
    expect(response.error?.message).toContain('rolled back');
    expect(response.error?.message).not.toContain(API_KEY);
    expect(response.error?.diagnostics?.hints).toContainEqual(
      expect.stringContaining('verified it directly')
    );
  });

  it('restores the previous credential when rolling back over an older entry', async () => {
    fs.writeFileSync(
      authStorePath,
      JSON.stringify({ anthropic: { type: 'oauth', access: 'older-token' } })
    );
    fetchMock.mockResolvedValue(new Response('{"data": []}', { status: 200 }));
    host.loadView.mockResolvedValue(createViewResponse([]));

    await recover(createVerifyFailureResponse());

    expect(readStore(authStorePath)).toEqual({
      anthropic: { type: 'oauth', access: 'older-token' },
    });
  });

  it('rolls back when the status re-read itself fails', async () => {
    fetchMock.mockResolvedValue(new Response('{"data": []}', { status: 200 }));
    host.loadView.mockResolvedValue({
      schemaVersion: 1,
      runtimeId: 'opencode',
      error: {
        code: 'runtime-unhealthy',
        message: 'view failed',
        recoverable: true,
        diagnostics: null,
      },
    } satisfies RuntimeProviderManagementViewResponse);

    const response = await recover(createVerifyFailureResponse());

    expect(readStore(authStorePath)).toEqual({});
    expect(response.error?.message).toContain(VERIFY_FAILURE_MESSAGE);
  });

  it('rolls back and reports the original failure when the status re-read throws', async () => {
    fs.writeFileSync(authStorePath, JSON.stringify({ cursor: { type: 'oauth' } }));
    fetchMock.mockResolvedValue(new Response('{"data": []}', { status: 200 }));
    host.loadView.mockRejectedValue(new Error('runtime host crashed'));

    const original = createVerifyFailureResponse();
    const response = await recover(original);

    expect(response).toBe(original);
    expect(readStore(authStorePath)).toEqual({ cursor: { type: 'oauth' } });
    expect(fs.readdirSync(tempDir)).toEqual(['auth.json']);
  });

  it('rolls back when invalidating the provider caches throws after the commit', async () => {
    fetchMock.mockResolvedValue(new Response('{"data": []}', { status: 200 }));
    host.invalidateProviderCaches.mockImplementationOnce(() => {
      throw new Error('cache invalidation failed');
    });

    const original = createVerifyFailureResponse();
    const response = await recover(original);

    expect(response).toBe(original);
    expect(readStore(authStorePath)).toEqual({});
    expect(host.loadView).not.toHaveBeenCalled();
  });

  it('does not activate for providers without an app-side verifier', async () => {
    const original: RuntimeProviderManagementProviderResponse = {
      ...createVerifyFailureResponse(),
      error: {
        code: 'auth-failed',
        message: 'OpenCode could not verify provider openrouter with 3 model candidates',
        recoverable: true,
        diagnostics: null,
      },
    };

    const response = await recover(original, 'openrouter');

    expect(response).toBe(original);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(authStorePath)).toBe(false);
  });

  it('does not activate for failures without the verify-probe signature', async () => {
    const original: RuntimeProviderManagementProviderResponse = {
      schemaVersion: 1,
      runtimeId: 'opencode',
      error: {
        code: 'auth-failed',
        message: 'Invalid API key',
        recoverable: true,
        diagnostics: null,
      },
    };

    const response = await recover(original);

    expect(response).toBe(original);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not activate when the probe signature comes with a credential rejection', async () => {
    const original: RuntimeProviderManagementProviderResponse = {
      schemaVersion: 1,
      runtimeId: 'opencode',
      error: {
        code: 'auth-failed',
        message:
          'OpenCode could not verify provider anthropic with 3 model candidates: ' +
          'anthropic/claude-sonnet-4-5: 401 authentication_error: invalid x-api-key',
        recoverable: true,
        diagnostics: null,
      },
    };

    const response = await recover(original);

    expect(response).toBe(original);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.loadView).not.toHaveBeenCalled();
    expect(fs.existsSync(authStorePath)).toBe(false);
  });

  it('aborts without writing when the auth store is not valid JSON', async () => {
    fs.writeFileSync(authStorePath, 'not-json{{');
    fetchMock.mockResolvedValue(new Response('{"data": []}', { status: 200 }));

    const original = createVerifyFailureResponse();
    const response = await recover(original);

    expect(response).toBe(original);
    expect(fs.readFileSync(authStorePath, 'utf8')).toBe('not-json{{');
    expect(host.loadView).not.toHaveBeenCalled();
  });

  it('keeps a concurrent writer that lands between the store read and the publish', async () => {
    fs.writeFileSync(authStorePath, JSON.stringify({ cursor: { type: 'oauth' } }));
    fetchMock.mockResolvedValue(new Response('{"data": []}', { status: 200 }));
    host.loadView.mockResolvedValue(
      createViewResponse([createProviderConnection('anthropic', 'connected')])
    );

    const realReadFile: (target: string, encoding: 'utf8') => Promise<string> =
      fs.promises.readFile.bind(fs.promises);
    let injected = false;
    const readFileSpy = vi
      .spyOn(fs.promises, 'readFile')
      .mockImplementation(async (target: unknown, encoding: unknown) => {
        if (typeof target !== 'string' || encoding !== 'utf8') {
          throw new Error('unexpected readFile call in this test');
        }
        const content = await realReadFile(target, encoding);
        if (!injected && target === authStorePath) {
          injected = true;
          // Another writer commits an unrelated provider after our read and
          // before the replacement file is published.
          fs.writeFileSync(
            authStorePath,
            JSON.stringify({
              cursor: { type: 'oauth' },
              openrouter: { type: 'api', key: 'sk-or-concurrent-000000' },
            })
          );
        }
        return content;
      });

    try {
      const response = await recover(createVerifyFailureResponse());

      expect(response.provider?.state).toBe('connected');
      expect(readStore(authStorePath)).toEqual({
        cursor: { type: 'oauth' },
        openrouter: { type: 'api', key: 'sk-or-concurrent-000000' },
        anthropic: { type: 'api', key: API_KEY },
      });
      expect(fs.readdirSync(tempDir)).toEqual(['auth.json']);
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it('leaves a concurrently replaced credential alone instead of rolling it back', async () => {
    fetchMock.mockResolvedValue(new Response('{"data": []}', { status: 200 }));
    host.loadView.mockImplementation(() => {
      // Another writer replaces the entry between the commit and the rollback.
      fs.writeFileSync(
        authStorePath,
        JSON.stringify({ anthropic: { type: 'api', key: 'sk-ant-other-key-000000' } })
      );
      return Promise.resolve(createViewResponse([]));
    });

    await recover(createVerifyFailureResponse());

    expect(readStore(authStorePath)).toEqual({
      anthropic: { type: 'api', key: 'sk-ant-other-key-000000' },
    });
  });
});
