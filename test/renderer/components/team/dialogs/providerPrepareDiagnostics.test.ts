import { describe, expect, it, vi } from 'vitest';

import {
  buildReusableProviderPrepareModelResults,
  runProviderPrepareDiagnostics,
} from '@renderer/components/team/dialogs/providerPrepareDiagnostics';
import { DEFAULT_PROVIDER_MODEL_SELECTION } from '@shared/utils/providerModelSelection';

import type { TeamProviderId, TeamProvisioningPrepareResult } from '@shared/types';

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

  it('returns a failed provider result immediately when runtime preflight fails', async () => {
    const prepareProvisioning = vi.fn<
      (
        cwd?: string,
        providerId?: TeamProviderId,
        providerIds?: TeamProviderId[],
        selectedModels?: string[],
        limitContext?: boolean,
        modelVerificationMode?: 'compatibility' | 'deep'
      ) => Promise<TeamProvisioningPrepareResult>
    >().mockResolvedValue({
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
        message:
          `API Error: 400 {"type":"error","error":{"type":"api_error","message":"Codex API error (400): {\\"detail\\":\\"The 'gpt-5.1-codex-max' model is not supported when using Codex with a ChatGPT account.\\"}"}}`,
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
    expect(prepareProvisioning).toHaveBeenNthCalledWith(1, '/tmp/project', 'anthropic', ['anthropic'], [
      DEFAULT_PROVIDER_MODEL_SELECTION,
    ], true);
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
    expect(prepareProvisioning).toHaveBeenNthCalledWith(1, '/tmp/project', 'codex', ['codex'], [
      'gpt-5.2-codex',
    ], undefined);
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

  it('does not synthesize verified from a generic runtime preflight note alone', async () => {
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

    expect(result.status).toBe('notes');
    expect(result.warnings).toEqual([
      '5.4 - check failed - Verification did not complete after runtime preflight warning',
    ]);
    expect(result.details).toEqual([
      '5.4 - check failed - Verification did not complete after runtime preflight warning',
    ]);
    expect(result.modelResultsById).toEqual({
      'gpt-5.4': {
        status: 'notes',
        line: '5.4 - check failed - Verification did not complete after runtime preflight warning',
        warningLine:
          '5.4 - check failed - Verification did not complete after runtime preflight warning',
      },
    });
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
        warnings: ['orchestrator-cli preflight check failed (exit code 1). Details: upstream unavailable'],
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

  it('prefers detailed OpenCode auth diagnostics over a generic not_authenticated batch message', async () => {
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
      });
    });

    const result = await runProviderPrepareDiagnostics({
      cwd: '/tmp/project',
      providerId: 'opencode',
      selectedModelIds: ['openai/gpt-5.2-codex'],
      prepareProvisioning,
    });

    expect(result.status).toBe('failed');
    expect(result.details).toEqual([
      'GPT-5.2 Codex - unavailable - OpenCode provider authentication failed (token refresh 401)',
    ]);
  });
});
