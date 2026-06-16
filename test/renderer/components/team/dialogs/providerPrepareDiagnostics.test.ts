import {
  buildReusableProviderPrepareModelResults,
  mergeReusableProviderPrepareModelResults,
  runProviderPrepareDiagnostics,
} from '@renderer/components/team/dialogs/providerPrepareDiagnostics';
import { OPENCODE_WINDOWS_NODE_MODULES_SYMLINK_PERMISSION_MESSAGE } from '@shared/utils/openCodeWindowsAccessDenied';
import { DEFAULT_PROVIDER_MODEL_SELECTION } from '@shared/utils/providerModelSelection';
import { describe, expect, it, vi } from 'vitest';

import type { TeamProviderId, TeamProvisioningPrepareResult } from '@shared/types';

const OPENCODE_RAW_MCP_UNREACHABLE =
  'OpenCode /experimental/tool/ids unavailable - Unable to connect. Is the computer able to access the url?';
const OPENCODE_NORMALIZED_MCP_UNREACHABLE =
  'OpenCode app MCP is unreachable. Retry launch to refresh the app MCP bridge. Details: Unable to connect. Is the computer able to access the url?';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('runProviderPrepareDiagnostics', () => {
  it('does not keep transient note results in the reusable cache', () => {
    expect(
      buildReusableProviderPrepareModelResults({
        'gpt-5.4': {
          status: 'ready',
          line: '5.4 - verified',
          warningLine: null,
        },
        'gpt-5.3-codex': {
          status: 'notes',
          line: '5.3 Codex - check failed - Model verification timed out',
          warningLine: '5.3 Codex - check failed - Model verification timed out',
        },
        'gpt-5.2-codex': {
          status: 'failed',
          line: '5.2 Codex - unavailable - Not available on this Codex native runtime',
          warningLine: null,
        },
      })
    ).toEqual({
      'gpt-5.4': {
        status: 'ready',
        line: '5.4 - verified',
        warningLine: null,
      },
      'gpt-5.2-codex': {
        status: 'failed',
        line: '5.2 Codex - unavailable - Not available on this Codex native runtime',
        warningLine: null,
      },
    });
  });

  it('merges reusable model results without dropping earlier cache entries', () => {
    expect(
      mergeReusableProviderPrepareModelResults(
        {
          'gpt-5.4': {
            status: 'ready',
            line: '5.4 - verified',
            warningLine: null,
          },
        },
        {
          'gpt-5.4-mini': {
            status: 'ready',
            line: '5.4 Mini - verified',
            warningLine: null,
          },
          'gpt-5.3-codex': {
            status: 'notes',
            line: '5.3 Codex - check failed - Model verification timed out',
            warningLine: '5.3 Codex - check failed - Model verification timed out',
          },
        }
      )
    ).toEqual({
      'gpt-5.4': {
        status: 'ready',
        line: '5.4 - verified',
        warningLine: null,
      },
      'gpt-5.4-mini': {
        status: 'ready',
        line: '5.4 Mini - verified',
        warningLine: null,
      },
    });
  });

  it('passes selected model effort checks through compatibility preflight', async () => {
    const prepareProvisioning = vi.fn(async (): Promise<TeamProvisioningPrepareResult> => ({
      ready: true,
      message: 'ready',
      details: ['Selected model claude-opus-4-6[1m] is available for launch.'],
    }));

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'anthropic',
      selectedModelIds: ['claude-opus-4-6[1m]'],
      selectedModelChecks: [
        {
          providerId: 'anthropic',
          model: 'claude-opus-4-6[1m]',
          effort: 'medium',
        },
      ],
      prepareProvisioning,
      limitContext: false,
    });

    expect(result.status).toBe('ready');
    expect(prepareProvisioning).toHaveBeenNthCalledWith(
      1,
      '/tmp/project',
      'anthropic',
      ['anthropic'],
      ['claude-opus-4-6[1m]'],
      false,
      'compatibility',
      [
        {
          providerId: 'anthropic',
          model: 'claude-opus-4-6[1m]',
          effort: 'medium',
        },
      ]
    );
  });

  it('removes a stale reusable model result when the latest result is advisory', () => {
    expect(
      mergeReusableProviderPrepareModelResults(
        {
          'gpt-5.4': {
            status: 'ready',
            line: '5.4 - verified',
            warningLine: null,
          },
          'gpt-5.2-codex': {
            status: 'failed',
            line: '5.2 Codex - unavailable - Not available on this Codex native runtime',
            warningLine: null,
          },
        },
        {
          'gpt-5.2-codex': {
            status: 'notes',
            line: '5.2 Codex - check failed - Model verification timed out',
            warningLine: '5.2 Codex - check failed - Model verification timed out',
          },
        }
      )
    ).toEqual({
      'gpt-5.4': {
        status: 'ready',
        line: '5.4 - verified',
        warningLine: null,
      },
    });
  });

  it('returns a failed provider result immediately when runtime preflight fails', async () => {
    const prepareProvisioning = vi
      .fn<
        (
          cwd?: string,
          providerId?: TeamProviderId,
          providerIds?: TeamProviderId[],
          selectedModels?: string[],
          limitContext?: boolean,
          modelVerificationMode?: 'compatibility' | 'deep'
        ) => Promise<TeamProvisioningPrepareResult>
      >()
      .mockResolvedValue({
        ready: false,
        message: 'Codex runtime is not authenticated.',
      });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'codex',
      selectedModelIds: ['gpt-5.4'],
      prepareProvisioning,
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual(['Codex runtime is not authenticated.']);
    expect(prepareProvisioning).toHaveBeenCalledTimes(1);
  });

  it('batches uncached model probes per provider and keeps failures scoped to the affected model', async () => {
    const deferredBatch = createDeferred<TeamProvisioningPrepareResult>();
    const progressUpdates: Array<{
      status: 'checking' | 'ready' | 'notes' | 'failed';
      details: string[];
      completedCount: number;
      totalCount: number;
    }> = [];

    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[]
      ) => Promise<TeamProvisioningPrepareResult>
    >((_, __, ___, selectedModels) => {
      expect(selectedModels).toEqual(['gpt-5.4', 'gpt-5.2-codex']);
      return deferredBatch.promise;
    });

    const resultPromise = runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'codex',
      selectedModelIds: ['gpt-5.4', 'gpt-5.2-codex'],
      prepareProvisioning,
      onModelProgress: (progress) => progressUpdates.push(progress),
    });

    await Promise.resolve();
    expect(progressUpdates[0]).toEqual({
      status: 'checking',
      completedCount: 0,
      totalCount: 2,
      details: ['5.4 - checking...', '5.2 Codex - checking...'],
    });

    deferredBatch.resolve({
      ready: false,
      message: 'Some provider runtimes are not ready',
      details: ['Selected model gpt-5.4 verified for launch.'],
      warnings: [
        "Selected model gpt-5.2-codex is unavailable. The 'gpt-5.2-codex' model is not supported when using Codex with a ChatGPT account.",
      ],
    });
    const result = await resultPromise;

    expect(result.status).toBe('failed');
    expect(result.details).toEqual([
      '5.4 - verified',
      '5.2 Codex - unavailable - Not available on this Codex native runtime',
    ]);
    expect(progressUpdates.at(-1)).toEqual({
      status: 'failed',
      completedCount: 2,
      totalCount: 2,
      details: [
        '5.4 - verified',
        '5.2 Codex - unavailable - Not available on this Codex native runtime',
      ],
    });
    expect(prepareProvisioning).toHaveBeenCalledTimes(1);
  });

  it('runs OpenCode uncached selected models through compatibility first and deep verification second', async () => {
    const deferredCompatibility = createDeferred<TeamProvisioningPrepareResult>();
    const deferredDeep = createDeferred<TeamProvisioningPrepareResult>();
    const progressUpdates: Array<{
      status: 'checking' | 'ready' | 'notes' | 'failed';
      details: string[];
      completedCount: number;
      totalCount: number;
    }> = [];

    const prepareProvisioning = vi.fn(
      (
        _cwd?: string,
        _providerId?: TeamProviderId,
        _providerIds?: TeamProviderId[],
        selectedModels?: string[],
        _limitContext?: boolean,
        modelVerificationMode?: 'compatibility' | 'deep'
      ) => {
        if (modelVerificationMode === 'compatibility') {
          expect(selectedModels).toEqual([
            'opencode/minimax-m2.5-free',
            'opencode/nemotron-3-super-free',
          ]);
          return deferredCompatibility.promise;
        }
        expect(modelVerificationMode).toBe('deep');
        expect(selectedModels).toEqual([
          'opencode/minimax-m2.5-free',
          'opencode/nemotron-3-super-free',
        ]);
        return deferredDeep.promise;
      }
    );

    const resultPromise = runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'opencode',
      selectedModelIds: ['opencode/minimax-m2.5-free', 'opencode/nemotron-3-super-free'],
      prepareProvisioning,
      onModelProgress: (progress) => progressUpdates.push(progress),
    });

    await Promise.resolve();
    expect(progressUpdates[0]).toEqual({
      status: 'checking',
      completedCount: 0,
      totalCount: 2,
      details: ['minimax-m2.5-free - checking...', 'nemotron-3-super-free - checking...'],
    });

    deferredCompatibility.resolve({
      ready: true,
      message: 'CLI is ready to launch',
      details: [
        'Selected model opencode/minimax-m2.5-free is compatible. Deep verification pending.',
        'Selected model opencode/nemotron-3-super-free is compatible. Deep verification pending.',
      ],
      warnings: [],
    });

    await vi.waitFor(() =>
      expect(progressUpdates.at(-1)).toEqual({
        status: 'checking',
        completedCount: 0,
        totalCount: 2,
        details: [
          'minimax-m2.5-free - compatible, deep verification pending...',
          'nemotron-3-super-free - compatible, deep verification pending...',
        ],
      })
    );

    deferredDeep.resolve({
      ready: true,
      message: 'CLI is ready to launch',
      details: [
        'Selected model opencode/minimax-m2.5-free verified for launch.',
        'Selected model opencode/nemotron-3-super-free verified for launch.',
      ],
      warnings: [],
    });

    const result = await resultPromise;

    expect(result.status).toBe('ready');
    expect(result.details).toEqual([
      'minimax-m2.5-free - verified',
      'nemotron-3-super-free - verified',
    ]);
    expect(prepareProvisioning).toHaveBeenNthCalledWith(
      1,
      '/tmp/project',
      'opencode',
      ['opencode'],
      ['opencode/minimax-m2.5-free', 'opencode/nemotron-3-super-free'],
      undefined,
      'compatibility'
    );
    expect(prepareProvisioning).toHaveBeenNthCalledWith(
      2,
      '/tmp/project',
      'opencode',
      ['opencode'],
      ['opencode/minimax-m2.5-free', 'opencode/nemotron-3-super-free'],
      undefined,
      'deep'
    );
  });

  it('does not mislabel OpenCode runtime connectivity failures as model unavailable', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[],
        limitContext?: boolean,
        modelVerificationMode?: 'compatibility' | 'deep'
      ) => Promise<TeamProvisioningPrepareResult>
    >(() =>
      Promise.resolve({
        ready: false,
        message: 'OpenCode: mcp_unavailable',
        details: [OPENCODE_RAW_MCP_UNREACHABLE],
      })
    );

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'opencode',
      selectedModelIds: ['opencode/big-pickle'],
      prepareProvisioning,
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual([
      OPENCODE_NORMALIZED_MCP_UNREACHABLE,
      'OpenCode: mcp_unavailable',
    ]);
    expect(result.modelResultsById).toEqual({});
    expect(result.details.join('\n')).not.toContain('big-pickle - unavailable');
    expect(prepareProvisioning).toHaveBeenCalledTimes(1);
    expect(prepareProvisioning).toHaveBeenCalledWith(
      '/tmp/project',
      'opencode',
      ['opencode'],
      ['opencode/big-pickle'],
      undefined,
      'compatibility'
    );
  });

  it('uses structured provider-scoped issues before OpenCode runtime text heuristics', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[],
        limitContext?: boolean,
        modelVerificationMode?: 'compatibility' | 'deep'
      ) => Promise<TeamProvisioningPrepareResult>
    >(() =>
      Promise.resolve({
        ready: false,
        message: 'OpenCode runtime failed with a future diagnostic shape',
        details: ['Future OpenCode health check failed without known marker words'],
        issues: [
          {
            providerId: 'opencode',
            scope: 'provider',
            severity: 'blocking',
            code: 'future_runtime_failure',
            message: 'Future OpenCode health check failed without known marker words',
          },
        ],
      })
    );

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'opencode',
      selectedModelIds: ['opencode/big-pickle'],
      prepareProvisioning,
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual([
      'Future OpenCode health check failed without known marker words',
    ]);
    expect(result.modelResultsById).toEqual({});
    expect(result.details.join('\n')).not.toContain('big-pickle - unavailable');
  });

  it('deduplicates repeated OpenCode provider runtime failure details', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[],
        limitContext?: boolean,
        modelVerificationMode?: 'compatibility' | 'deep'
      ) => Promise<TeamProvisioningPrepareResult>
    >(() =>
      Promise.resolve({
        ready: false,
        message: OPENCODE_RAW_MCP_UNREACHABLE,
        details: [OPENCODE_RAW_MCP_UNREACHABLE],
        warnings: [OPENCODE_RAW_MCP_UNREACHABLE],
      })
    );

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'opencode',
      selectedModelIds: ['opencode/big-pickle'],
      prepareProvisioning,
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual([OPENCODE_NORMALIZED_MCP_UNREACHABLE]);
    expect(result.warnings).toEqual([OPENCODE_NORMALIZED_MCP_UNREACHABLE]);
    expect(result.modelResultsById).toEqual({});
  });

  it('keeps the OpenCode node_modules symlink EPERM failure on the administrator hint path', async () => {
    const symlinkError = [
      'Runtime provider management command failed unexpectedly:',
      "EPERM: operation not permitted, symlink 'C:\\Users\\ben\\AppData\\Local\\claude-multimodel-nodejs\\Cache\\opencode\\shared-cache\\config-node_modules'",
      "-> 'C:\\Users\\ben\\AppData\\Local\\claude-multimodel-nodejs\\Data\\opencode\\profiles\\abc123\\config\\opencode\\node_modules'",
    ].join(' ');
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[],
        limitContext?: boolean,
        modelVerificationMode?: 'compatibility' | 'deep'
      ) => Promise<TeamProvisioningPrepareResult>
    >(() =>
      Promise.resolve({
        ready: false,
        message: symlinkError,
        details: [symlinkError],
        warnings: [symlinkError],
      })
    );

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'opencode',
      selectedModelIds: ['opencode/big-pickle'],
      prepareProvisioning,
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual([OPENCODE_WINDOWS_NODE_MODULES_SYMLINK_PERMISSION_MESSAGE]);
    expect(result.warnings).toEqual([OPENCODE_WINDOWS_NODE_MODULES_SYMLINK_PERMISSION_MESSAGE]);
    expect(result.modelResultsById).toEqual({});
  });

  it('treats OpenCode compatibility verification warnings as blocking when the batch failed', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[],
        limitContext?: boolean,
        modelVerificationMode?: 'compatibility' | 'deep'
      ) => Promise<TeamProvisioningPrepareResult>
    >(() =>
      Promise.resolve({
        ready: false,
        message:
          'Selected model opencode/big-pickle could not be verified. OpenCode provider authentication failed',
        warnings: [
          'Selected model opencode/big-pickle could not be verified. OpenCode provider authentication failed',
        ],
      })
    );

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'opencode',
      selectedModelIds: ['opencode/big-pickle'],
      prepareProvisioning,
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual([
      'big-pickle - check failed - OpenCode provider authentication failed',
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.modelResultsById).toEqual({
      'opencode/big-pickle': {
        status: 'failed',
        line: 'big-pickle - check failed - OpenCode provider authentication failed',
        warningLine: null,
      },
    });
  });

  it('treats OpenCode busy model verification as deferred notes', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[],
        limitContext?: boolean,
        modelVerificationMode?: 'compatibility' | 'deep'
      ) => Promise<TeamProvisioningPrepareResult>
    >((_cwd, _providerId, _providerIds, _selectedModels, _limitContext, modelVerificationMode) =>
      Promise.resolve(
        modelVerificationMode === 'compatibility'
          ? {
              ready: true,
              message: 'CLI is ready to launch',
              details: [
                'Selected model opencode/big-pickle is compatible. Deep verification pending.',
              ],
              warnings: [],
            }
          : {
              ready: true,
              message: 'CLI is ready to launch',
              warnings: [
                'Selected model opencode/big-pickle verification deferred. OpenCode session is busy; retry when idle.',
              ],
            }
      )
    );

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'opencode',
      selectedModelIds: ['opencode/big-pickle'],
      prepareProvisioning,
    });

    expect(result.status).toBe('notes');
    expect(result.details).toEqual([
      'big-pickle - verification deferred - OpenCode session is busy; retry when idle.',
    ]);
    expect(result.warnings).toEqual([
      'big-pickle - verification deferred - OpenCode session is busy; retry when idle.',
    ]);
    expect(result.modelResultsById).toEqual({
      'opencode/big-pickle': {
        status: 'notes',
        line: 'big-pickle - verification deferred - OpenCode session is busy; retry when idle.',
        warningLine:
          'big-pickle - verification deferred - OpenCode session is busy; retry when idle.',
      },
    });
    expect(prepareProvisioning).toHaveBeenCalledTimes(2);
  });

  it('treats provider-level OpenCode busy after compatibility as launch-ready', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[],
        limitContext?: boolean,
        modelVerificationMode?: 'compatibility' | 'deep'
      ) => Promise<TeamProvisioningPrepareResult>
    >((_cwd, _providerId, _providerIds, selectedModels, _limitContext, modelVerificationMode) =>
      Promise.resolve(
        modelVerificationMode === 'compatibility'
          ? {
              ready: true,
              message: 'CLI is ready to launch',
              details: (selectedModels ?? []).map(
                (modelId) => `Selected model ${modelId} is compatible. Deep verification pending.`
              ),
              warnings: [],
            }
          : {
              ready: true,
              message: 'CLI is ready to launch',
              warnings: [
                'OpenCode is currently busy with another session. Deep model verification will retry when OpenCode is idle.',
              ],
            }
      )
    );

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'opencode',
      selectedModelIds: ['opencode/kimi-k2.6', 'openrouter/google/gemma-4-26b-a4b-it'],
      prepareProvisioning,
    });

    expect(result.status).toBe('ready');
    expect(result.details).toEqual([
      'kimi-k2.6 - available for launch',
      'google/gemma-4-26b-a4b-it - available for launch',
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.details.join('\n')).not.toContain('verification deferred - OpenCode session is busy');
    expect(prepareProvisioning).toHaveBeenCalledTimes(2);
  });

  it('treats provider-level OpenCode busy after compatibility as launch-ready for one selected model', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[],
        limitContext?: boolean,
        modelVerificationMode?: 'compatibility' | 'deep'
      ) => Promise<TeamProvisioningPrepareResult>
    >((_cwd, _providerId, _providerIds, selectedModels, _limitContext, modelVerificationMode) =>
      Promise.resolve(
        modelVerificationMode === 'compatibility'
          ? {
              ready: true,
              message: 'CLI is ready to launch',
              details: (selectedModels ?? []).map(
                (modelId) => `Selected model ${modelId} is compatible. Deep verification pending.`
              ),
              warnings: [],
            }
          : {
              ready: true,
              message: 'CLI is ready to launch',
              warnings: [
                'OpenCode is currently busy with another session. Deep model verification will retry when OpenCode is idle.',
              ],
            }
      )
    );

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'opencode',
      selectedModelIds: ['opencode/kimi-k2.6'],
      prepareProvisioning,
    });

    expect(result.status).toBe('ready');
    expect(result.details).toEqual([
      'kimi-k2.6 - available for launch',
    ]);
    expect(result.warnings).toEqual([]);
    expect(prepareProvisioning).toHaveBeenCalledTimes(2);
  });

  it('keeps stale OpenCode model-scoped runtime failures provider-scoped', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[],
        limitContext?: boolean,
        modelVerificationMode?: 'compatibility' | 'deep'
      ) => Promise<TeamProvisioningPrepareResult>
    >(() =>
      Promise.resolve({
        ready: false,
        message: `Selected model opencode/big-pickle could not be verified. ${OPENCODE_RAW_MCP_UNREACHABLE}`,
        warnings: [
          `Selected model opencode/big-pickle could not be verified. ${OPENCODE_RAW_MCP_UNREACHABLE}`,
        ],
      })
    );

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'opencode',
      selectedModelIds: ['opencode/big-pickle'],
      prepareProvisioning,
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual([OPENCODE_NORMALIZED_MCP_UNREACHABLE]);
    expect(result.warnings).toEqual([]);
    expect(result.modelResultsById).toEqual({});
  });

  it('does not mislabel OpenCode endpoint authorization failures as model unavailable', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[],
        limitContext?: boolean,
        modelVerificationMode?: 'compatibility' | 'deep'
      ) => Promise<TeamProvisioningPrepareResult>
    >(() =>
      Promise.resolve({
        ready: false,
        message: 'OpenCode: mcp_unavailable',
        details: ['OpenCode /experimental/tool/ids unavailable - HTTP 403 Forbidden'],
      })
    );

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'opencode',
      selectedModelIds: ['opencode/big-pickle'],
      prepareProvisioning,
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual([
      'OpenCode /experimental/tool/ids unavailable - HTTP 403 Forbidden',
      'OpenCode: mcp_unavailable',
    ]);
    expect(result.modelResultsById).toEqual({});
    expect(result.details.join('\n')).not.toContain('big-pickle - unavailable');
  });

  it('keeps OpenCode selected-model compatibility failures scoped to the selected model', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[],
        limitContext?: boolean,
        modelVerificationMode?: 'compatibility' | 'deep'
      ) => Promise<TeamProvisioningPrepareResult>
    >(() =>
      Promise.resolve({
        ready: false,
        message:
          'Selected model opencode/not-real is unavailable. Selected model opencode/not-real is not available',
      })
    );

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'opencode',
      selectedModelIds: ['opencode/not-real'],
      prepareProvisioning,
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual([
      'not-real - unavailable - Selected model opencode/not-real is not available',
    ]);
    expect(result.modelResultsById).toEqual({
      'opencode/not-real': {
        status: 'failed',
        line: 'not-real - unavailable - Selected model opencode/not-real is not available',
        warningLine: null,
      },
    });
  });

  it('does not mislabel OpenCode deep runtime failures as model unavailable', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[],
        limitContext?: boolean,
        modelVerificationMode?: 'compatibility' | 'deep'
      ) => Promise<TeamProvisioningPrepareResult>
    >((_cwd, _providerId, _providerIds, selectedModels, _limitContext, modelVerificationMode) => {
      if (modelVerificationMode === 'compatibility') {
        expect(selectedModels).toEqual(['opencode/big-pickle']);
        return Promise.resolve({
          ready: true,
          message: 'CLI is ready to launch',
          details: ['Selected model opencode/big-pickle is compatible. Deep verification pending.'],
        });
      }

      expect(modelVerificationMode).toBe('deep');
      expect(selectedModels).toEqual(['opencode/big-pickle']);
      return Promise.resolve({
        ready: false,
        message: 'OpenCode: mcp_unavailable',
        details: [OPENCODE_RAW_MCP_UNREACHABLE],
      });
    });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'opencode',
      selectedModelIds: ['opencode/big-pickle'],
      prepareProvisioning,
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual([
      OPENCODE_NORMALIZED_MCP_UNREACHABLE,
      'OpenCode: mcp_unavailable',
    ]);
    expect(result.modelResultsById).toEqual({});
    expect(result.details.join('\n')).not.toContain('big-pickle - unavailable');
    expect(prepareProvisioning).toHaveBeenCalledTimes(2);
  });

  it('uses structured provider-scoped issues from OpenCode deep verification', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[],
        limitContext?: boolean,
        modelVerificationMode?: 'compatibility' | 'deep'
      ) => Promise<TeamProvisioningPrepareResult>
    >((_cwd, _providerId, _providerIds, selectedModels, _limitContext, modelVerificationMode) => {
      if (modelVerificationMode === 'compatibility') {
        expect(selectedModels).toEqual(['opencode/big-pickle']);
        return Promise.resolve({
          ready: true,
          message: 'CLI is ready to launch',
          details: ['Selected model opencode/big-pickle is compatible. Deep verification pending.'],
        });
      }

      expect(modelVerificationMode).toBe('deep');
      expect(selectedModels).toEqual(['opencode/big-pickle']);
      return Promise.resolve({
        ready: false,
        message: 'Future OpenCode runtime health failed',
        details: ['Future OpenCode runtime health failed'],
        issues: [
          {
            providerId: 'opencode',
            scope: 'provider',
            severity: 'blocking',
            code: 'future_runtime_failure',
            message: 'Future OpenCode runtime health failed',
          },
        ],
      });
    });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'opencode',
      selectedModelIds: ['opencode/big-pickle'],
      prepareProvisioning,
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual(['Future OpenCode runtime health failed']);
    expect(result.modelResultsById).toEqual({});
    expect(result.details.join('\n')).not.toContain('big-pickle - unavailable');
    expect(prepareProvisioning).toHaveBeenCalledTimes(2);
  });

  it('keeps transient OpenCode deep ping failures advisory after compatibility passed', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[],
        limitContext?: boolean,
        modelVerificationMode?: 'compatibility' | 'deep'
      ) => Promise<TeamProvisioningPrepareResult>
    >((_cwd, _providerId, _providerIds, selectedModels, _limitContext, modelVerificationMode) => {
      if (modelVerificationMode === 'compatibility') {
        expect(selectedModels).toEqual(['opencode/big-pickle']);
        return Promise.resolve({
          ready: true,
          message: 'CLI is ready to launch',
          details: ['Selected model opencode/big-pickle is compatible. Deep verification pending.'],
        });
      }

      expect(modelVerificationMode).toBe('deep');
      expect(selectedModels).toEqual(['opencode/big-pickle']);
      return Promise.resolve({
        ready: false,
        message: 'Unable to connect. Is the computer able to access the url?',
        details: ['Unable to connect. Is the computer able to access the url?'],
        issues: [
          {
            providerId: 'opencode',
            scope: 'provider',
            severity: 'blocking',
            code: 'unknown_error',
            message: 'Unable to connect. Is the computer able to access the url?',
          },
        ],
      });
    });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'opencode',
      selectedModelIds: ['opencode/big-pickle'],
      prepareProvisioning,
    });

    expect(result.status).toBe('notes');
    expect(result.details).toEqual(['big-pickle - ping not confirmed']);
    expect(result.warnings).toEqual([
      'OpenCode model ping was not confirmed. Unable to connect. Is the computer able to access the url?',
      'big-pickle - ping not confirmed',
    ]);
    expect(result.modelResultsById).toEqual({
      'opencode/big-pickle': {
        status: 'notes',
        line: 'big-pickle - ping not confirmed',
        warningLine: 'big-pickle - ping not confirmed',
      },
    });
    expect(prepareProvisioning).toHaveBeenCalledTimes(2);
  });

  it('keeps hard OpenCode deep provider issues blocking after compatibility passed', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[],
        limitContext?: boolean,
        modelVerificationMode?: 'compatibility' | 'deep'
      ) => Promise<TeamProvisioningPrepareResult>
    >((_cwd, _providerId, _providerIds, selectedModels, _limitContext, modelVerificationMode) => {
      if (modelVerificationMode === 'compatibility') {
        expect(selectedModels).toEqual(['opencode/big-pickle']);
        return Promise.resolve({
          ready: true,
          message: 'CLI is ready to launch',
          details: ['Selected model opencode/big-pickle is compatible. Deep verification pending.'],
        });
      }

      expect(modelVerificationMode).toBe('deep');
      expect(selectedModels).toEqual(['opencode/big-pickle']);
      return Promise.resolve({
        ready: false,
        message: 'OpenCode: mcp_unavailable',
        issues: [
          {
            providerId: 'opencode',
            scope: 'provider',
            severity: 'blocking',
            code: 'mcp_unavailable',
            message: 'OpenCode: mcp_unavailable',
          },
        ],
      });
    });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'opencode',
      selectedModelIds: ['opencode/big-pickle'],
      prepareProvisioning,
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual(['OpenCode: mcp_unavailable']);
    expect(result.modelResultsById).toEqual({});
    expect(prepareProvisioning).toHaveBeenCalledTimes(2);
  });

  it('uses structured mcp_unavailable code to explain plain OpenCode connect failures', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[],
        limitContext?: boolean,
        modelVerificationMode?: 'compatibility' | 'deep'
      ) => Promise<TeamProvisioningPrepareResult>
    >((_cwd, _providerId, _providerIds, selectedModels, _limitContext, modelVerificationMode) => {
      if (modelVerificationMode === 'compatibility') {
        expect(selectedModels).toEqual(['opencode/big-pickle']);
        return Promise.resolve({
          ready: false,
          message: 'Unable to connect. Is the computer able to access the url?',
          issues: [
            {
              providerId: 'opencode',
              scope: 'provider',
              severity: 'blocking',
              code: 'mcp_unavailable',
              message: 'Unable to connect. Is the computer able to access the url?',
            },
          ],
        });
      }

      throw new Error('deep verification should not run');
    });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'opencode',
      selectedModelIds: ['opencode/big-pickle'],
      prepareProvisioning,
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual([
      'OpenCode app MCP is unreachable. Retry launch to refresh the app MCP bridge.',
    ]);
    expect(result.modelResultsById).toEqual({});
    expect(prepareProvisioning).toHaveBeenCalledTimes(1);
  });

  it('keeps OpenCode deep selected-model failures scoped to the selected model', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[],
        limitContext?: boolean,
        modelVerificationMode?: 'compatibility' | 'deep'
      ) => Promise<TeamProvisioningPrepareResult>
    >((_cwd, _providerId, _providerIds, selectedModels, _limitContext, modelVerificationMode) => {
      if (modelVerificationMode === 'compatibility') {
        expect(selectedModels).toEqual(['openrouter/example/not-available']);
        return Promise.resolve({
          ready: true,
          message: 'CLI is ready to launch',
          details: [
            'Selected model openrouter/example/not-available is compatible. Deep verification pending.',
          ],
        });
      }

      expect(modelVerificationMode).toBe('deep');
      expect(selectedModels).toEqual(['openrouter/example/not-available']);
      return Promise.resolve({
        ready: false,
        message:
          'API Error: 400 {"detail":"The requested model is not available for your account."}',
      });
    });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'opencode',
      selectedModelIds: ['openrouter/example/not-available'],
      prepareProvisioning,
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual([
      'example/not-available - unavailable - Not available for this account',
    ]);
    expect(result.modelResultsById).toEqual({
      'openrouter/example/not-available': {
        status: 'failed',
        line: 'example/not-available - unavailable - Not available for this account',
        warningLine: null,
      },
    });
  });

  it('normalizes raw Codex API error envelopes into a clean model reason', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[]
      ) => Promise<TeamProvisioningPrepareResult>
    >((_, __, ___, selectedModels) => {
      return Promise.resolve({
        ready: false,
        message: `API Error: 400 {"type":"error","error":{"type":"api_error","message":"Codex API error (400): {\\"detail\\":\\"The 'gpt-5.1-codex-max' model is not supported when using Codex with a ChatGPT account.\\"}"}}`,
      });
    });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'codex',
      selectedModelIds: ['gpt-5.1-codex-max'],
      prepareProvisioning,
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual([
      '5.1 Codex Max - unavailable - Not available on this Codex native runtime',
    ]);
  });

  it('normalizes raw timeout probe errors into a provider-agnostic reason', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[]
      ) => Promise<TeamProvisioningPrepareResult>
    >((_, __, ___, selectedModels) => {
      return Promise.resolve({
        ready: true,
        message: 'CLI is warmed up and ready to launch',
        warnings: [
          'Selected model gpt-5.3-codex could not be verified. Timeout running: orchestrator-cli -p Output only the single word PONG. --output-format text --model gpt-5.3-codex --max-turns 1 --no-session-persistence',
        ],
      });
    });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'codex',
      selectedModelIds: ['gpt-5.3-codex'],
      prepareProvisioning,
    });

    expect(result.status).toBe('notes');
    expect(result.details).toEqual(['5.3 Codex - check failed - Model verification timed out']);
  });

  it('renders the provider default model as a dedicated Default check line', async () => {
    const progressUpdates: Array<{
      status: 'checking' | 'ready' | 'notes' | 'failed';
      details: string[];
      completedCount: number;
      totalCount: number;
    }> = [];
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[]
      ) => Promise<TeamProvisioningPrepareResult>
    >((_, __, ___, selectedModels) => {
      return Promise.resolve({
        ready: true,
        message: 'CLI is warmed up and ready to launch',
        details: [`Selected model ${DEFAULT_PROVIDER_MODEL_SELECTION} verified for launch.`],
      });
    });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'codex',
      selectedModelIds: [DEFAULT_PROVIDER_MODEL_SELECTION],
      prepareProvisioning,
      onModelProgress: (progress) => progressUpdates.push(progress),
    });

    expect(progressUpdates[0]).toEqual({
      status: 'checking',
      completedCount: 0,
      totalCount: 1,
      details: ['Default - checking...'],
    });
    expect(result.status).toBe('ready');
    expect(result.details).toEqual(['Default - verified']);
  });

  it('forwards limitContext through model diagnostics for Anthropic default checks', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[],
        limitContext?: boolean
      ) => Promise<TeamProvisioningPrepareResult>
    >((_, __, ___, selectedModels) => {
      return Promise.resolve({
        ready: true,
        message: 'CLI is warmed up and ready to launch',
        details: [`Selected model ${DEFAULT_PROVIDER_MODEL_SELECTION} verified for launch.`],
      });
    });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'anthropic',
      selectedModelIds: [DEFAULT_PROVIDER_MODEL_SELECTION],
      limitContext: true,
      prepareProvisioning,
    });

    expect(result.details).toEqual(['Default - verified']);
    expect(prepareProvisioning).toHaveBeenNthCalledWith(
      1,
      '/tmp/project',
      'anthropic',
      ['anthropic'],
      [DEFAULT_PROVIDER_MODEL_SELECTION],
      true,
      'compatibility'
    );
  });

  it('checks multiple Anthropic selected models without OpenCode compatibility-pending progress', async () => {
    const progressUpdates: Array<{
      status: 'checking' | 'ready' | 'notes' | 'failed';
      details: string[];
      completedCount: number;
      totalCount: number;
    }> = [];
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[],
        limitContext?: boolean,
        modelVerificationMode?: 'compatibility' | 'deep'
      ) => Promise<TeamProvisioningPrepareResult>
    >((_, __, ___, selectedModels, ____, modelVerificationMode) => {
      if (selectedModels) {
        expect(modelVerificationMode).toBe('compatibility');
        expect(selectedModels).toEqual(['claude-test-a', 'claude-test-b']);
        return Promise.resolve({
          ready: true,
          message: 'CLI is warmed up and ready to launch',
          details: [
            'Selected model claude-test-a verified for launch.',
            'Selected model claude-test-b verified for launch.',
          ],
        });
      }

      expect(modelVerificationMode).toBe('deep');
      return Promise.resolve({
        ready: true,
        message: 'CLI is warmed up and ready to launch',
        details: [],
      });
    });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'anthropic',
      selectedModelIds: ['claude-test-a', 'claude-test-b'],
      prepareProvisioning,
      onModelProgress: (progress) => progressUpdates.push(progress),
    });

    expect(result.status).toBe('ready');
    expect(result.details).toEqual(['claude-test-a - verified', 'claude-test-b - verified']);
    expect(progressUpdates[0]).toEqual({
      status: 'checking',
      completedCount: 0,
      totalCount: 2,
      details: ['claude-test-a - checking...', 'claude-test-b - checking...'],
    });
    expect(
      progressUpdates
        .flatMap((progress) => progress.details)
        .some((line) => line.includes('compatible'))
    ).toBe(false);
    expect(prepareProvisioning).toHaveBeenCalledTimes(2);
    expect(prepareProvisioning).toHaveBeenNthCalledWith(
      1,
      '/tmp/project',
      'anthropic',
      ['anthropic'],
      ['claude-test-a', 'claude-test-b'],
      undefined,
      'compatibility'
    );
    expect(prepareProvisioning).toHaveBeenNthCalledWith(
      2,
      '/tmp/project',
      'anthropic',
      ['anthropic'],
      undefined,
      undefined,
      'deep'
    );
  });

  it('reuses cached model results and probes only newly selected models', async () => {
    const progressUpdates: Array<{
      status: 'checking' | 'ready' | 'notes' | 'failed';
      details: string[];
      completedCount: number;
      totalCount: number;
    }> = [];
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[]
      ) => Promise<TeamProvisioningPrepareResult>
    >((_, __, ___, selectedModels) => {
      expect(selectedModels).toEqual(['gpt-5.2-codex']);
      return Promise.resolve({
        ready: false,
        message:
          "Selected model gpt-5.2-codex is unavailable. The 'gpt-5.2-codex' model is not supported when using Codex with a ChatGPT account.",
      });
    });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'codex',
      selectedModelIds: ['gpt-5.2', 'gpt-5.4-mini', 'gpt-5.2-codex'],
      prepareProvisioning,
      cachedModelResultsById: {
        'gpt-5.2': {
          status: 'ready',
          line: '5.2 - verified',
          warningLine: null,
        },
        'gpt-5.4-mini': {
          status: 'ready',
          line: '5.4 Mini - verified',
          warningLine: null,
        },
      },
      onModelProgress: (progress) => progressUpdates.push(progress),
    });

    expect(progressUpdates[0]).toEqual({
      status: 'checking',
      completedCount: 2,
      totalCount: 3,
      details: ['5.2 - verified', '5.4 Mini - verified', '5.2 Codex - checking...'],
    });
    expect(result.details).toEqual([
      '5.2 - verified',
      '5.4 Mini - verified',
      '5.2 Codex - unavailable - Not available on this Codex native runtime',
    ]);
    expect(prepareProvisioning).toHaveBeenCalledTimes(1);
    expect(prepareProvisioning).toHaveBeenNthCalledWith(
      1,
      '/tmp/project',
      'codex',
      ['codex'],
      ['gpt-5.2-codex'],
      undefined,
      'compatibility'
    );
  });

  it('suppresses a timed out runtime preflight note when that same model later verifies', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[]
      ) => Promise<TeamProvisioningPrepareResult>
    >((_, __, ___, selectedModels) => {
      return Promise.resolve({
        ready: true,
        message: 'CLI is ready to launch (see notes)',
        details: [
          'Selected model gpt-5.4-mini verified for launch.',
          'Selected model gpt-5.4 verified for launch.',
        ],
        warnings: [
          'Preflight check for `orchestrator-cli -p` did not complete. Proceeding anyway. Details: Timeout running: orchestrator-cli -p Output only the single word PONG. --output-format text --model gpt-5.4-mini --max-turns 1 --no-session-persistence',
        ],
      });
    });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'codex',
      selectedModelIds: ['gpt-5.4-mini', 'gpt-5.4'],
      prepareProvisioning,
    });

    expect(result.status).toBe('ready');
    expect(result.warnings).toEqual([]);
    expect(result.details).toEqual(['5.4 Mini - verified', '5.4 - verified']);
  });

  it('treats launchable Codex compatibility as ready and suppresses generic preflight notes', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[]
      ) => Promise<TeamProvisioningPrepareResult>
    >((_, __, ___, selectedModels) => {
      return Promise.resolve({
        ready: true,
        message: 'CLI is ready to launch (see notes)',
        warnings: ['orchestrator-cli preflight check failed (exit code 1).'],
      });
    });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'codex',
      selectedModelIds: ['gpt-5.4'],
      prepareProvisioning,
    });

    expect(result.status).toBe('ready');
    expect(result.warnings).toEqual([]);
    expect(result.details).toEqual(['5.4 - available for launch']);
    expect(result.modelResultsById).toEqual({
      'gpt-5.4': {
        status: 'ready',
        line: '5.4 - available for launch',
        warningLine: null,
      },
    });
  });

  it('keeps concrete Codex runtime-missing warnings visible after model compatibility succeeds', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[],
        limitContext?: boolean,
        modelVerificationMode?: 'compatibility' | 'deep'
      ) => Promise<TeamProvisioningPrepareResult>
    >((_, __, ___, selectedModels, ____, modelVerificationMode) => {
      if (selectedModels?.length === 1 && modelVerificationMode === 'compatibility') {
        return Promise.resolve({
          ready: true,
          message: 'CLI is ready to launch',
          details: ['Selected model gpt-5.4 is available for launch.'],
        });
      }

      return Promise.resolve({
        ready: true,
        message: 'CLI is ready to launch (see notes)',
        warnings: ['Codex CLI not found. Install Codex to use native account management.'],
      });
    });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'codex',
      selectedModelIds: ['gpt-5.4'],
      prepareProvisioning,
    });

    expect(result.status).toBe('notes');
    expect(result.details).toEqual([
      'Codex CLI not found. Install Codex to use native account management.',
      '5.4 - available for launch',
    ]);
    expect(result.warnings).toEqual([
      'Codex CLI not found. Install Codex to use native account management.',
    ]);
  });

  it('suppresses a generic runtime preflight failure when selected models later verify', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[]
      ) => Promise<TeamProvisioningPrepareResult>
    >((_, __, ___, selectedModels) => {
      return Promise.resolve({
        ready: true,
        message: 'CLI is ready to launch (see notes)',
        details: ['Selected model gpt-5.4 verified for launch.'],
        warnings: [
          'orchestrator-cli preflight check failed (exit code 1). Details: upstream unavailable',
        ],
      });
    });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'codex',
      selectedModelIds: ['gpt-5.4'],
      prepareProvisioning,
    });

    expect(result.status).toBe('ready');
    expect(result.warnings).toEqual([]);
    expect(result.details).toEqual(['5.4 - verified']);
    expect(result.modelResultsById).toEqual({
      'gpt-5.4': {
        status: 'ready',
        line: '5.4 - verified',
        warningLine: null,
      },
    });
  });

  it('suppresses a generic runtime preflight note during progress when cached selected models are already verified', async () => {
    const progressUpdates: Array<{
      status: 'checking' | 'ready' | 'notes' | 'failed';
      details: string[];
      completedCount: number;
      totalCount: number;
    }> = [];
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[]
      ) => Promise<TeamProvisioningPrepareResult>
    >((_, __, ___, selectedModels) => {
      if (!selectedModels || selectedModels.length === 0) {
        return Promise.resolve({
          ready: true,
          message: 'CLI is ready to launch (see notes)',
          warnings: ['orchestrator-cli preflight check failed (exit code 1).'],
        });
      }

      return Promise.resolve({
        ready: true,
        message: 'CLI is ready to launch (see notes)',
        warnings: ['orchestrator-cli preflight check failed (exit code 1).'],
      });
    });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'codex',
      selectedModelIds: [DEFAULT_PROVIDER_MODEL_SELECTION, 'gpt-5.4'],
      prepareProvisioning,
      onModelProgress: (progress) => progressUpdates.push(progress),
      cachedModelResultsById: {
        [DEFAULT_PROVIDER_MODEL_SELECTION]: {
          status: 'ready',
          line: 'Default - verified',
          warningLine: null,
        },
        'gpt-5.4': {
          status: 'ready',
          line: '5.4 - verified',
          warningLine: null,
        },
      },
    });

    expect(prepareProvisioning).toHaveBeenCalledTimes(1);
    expect(progressUpdates).toEqual([
      {
        status: 'ready',
        completedCount: 2,
        totalCount: 2,
        details: ['Default - verified', '5.4 - verified'],
      },
    ]);
    expect(result.status).toBe('ready');
    expect(result.warnings).toEqual([]);
    expect(result.details).toEqual(['Default - verified', '5.4 - verified']);
  });

  it('uses structured OpenCode auth diagnostics as provider-scoped failures', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[]
      ) => Promise<TeamProvisioningPrepareResult>
    >((_, __, ___, selectedModels) => {
      return Promise.resolve({
        ready: false,
        message: 'OpenCode: not_authenticated',
        details: ['Token refresh failed: 401'],
        issues: [
          {
            providerId: 'opencode',
            scope: 'provider',
            severity: 'blocking',
            code: 'not_authenticated',
            message: 'Token refresh failed: 401',
          },
        ],
      });
    });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'opencode',
      selectedModelIds: ['openai/gpt-5.2-codex'],
      prepareProvisioning,
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual(['Token refresh failed: 401']);
    expect(result.modelResultsById).toEqual({});
  });
});
