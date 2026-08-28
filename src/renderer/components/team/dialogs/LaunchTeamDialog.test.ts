import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { TEAM_LAUNCH_KNOWN_NO_DISPATCH_ERROR_CODE } from '@shared/types/ipc';
import { describe, expect, it, vi } from 'vitest';

import {
  areLaunchTeamProviderProofsAuthoritative,
  executeLaunchTeamDialogSubmission,
  executeLaunchTeamDialogSubmissionWithRecheck,
  LaunchTeamDialog,
  resolveLaunchTeamDialogLaunchPrepareState,
} from './LaunchTeamDialog';
import {
  buildProviderPrepareModelChecksSignature,
  buildProviderPrepareRuntimeStatusSignature,
} from './providerPrepareRequestSignature';
import {
  areProviderLaunchStatusesAuthoritative,
  isAuthoritativeProvisioningReady,
  isLaunchTeamLaunchAuthorized,
  resolveProvisioningPreparationAuthorizationState,
} from './provisioningLaunchAuthorization';
import {
  executeTeamRelaunch,
  TeamRelaunchKnownPreDispatchFailure,
  TeamRelaunchStopOutcomeUnknownError,
} from './teamRelaunchFlow';
import { useCommittedLaunchAuthorizationRef } from './useCommittedLaunchAuthorizationRef';

import type { ProvisioningLaunchAuthorizationInput } from './provisioningLaunchAuthorization';
import type { ProvisioningProviderCheck } from './provisioningProviderChecks';
import type { CliProviderStatus, TeamProviderBackendId, TeamProviderId } from '@shared/types';

const freshProofExpiry = Date.parse('2099-01-01T00:00:00.000Z');
const freshExecutionProof = {
  authorityId: 'renderer-proof',
  generation: 1,
  completedAt: '2026-08-21T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
  requestDigest: 'a'.repeat(64),
};

const authoritativeProvider = (): CliProviderStatus => ({
  providerId: 'opencode',
  displayName: 'OpenCode',
  supported: true,
  authenticated: true,
  authMethod: 'oauth',
  verificationState: 'verified',
  statusCheckOutcome: 'authoritative',
  models: ['openai/gpt-test'],
  modelCatalog: {
    schemaVersion: 1,
    providerId: 'opencode',
    source: 'app-server',
    status: 'ready',
    fetchedAt: '2026-08-19T00:00:00.000Z',
    staleAt: '2099-08-19T00:05:00.000Z',
    defaultModelId: 'openai/gpt-test',
    defaultLaunchModel: 'openai/gpt-test',
    models: [
      {
        id: 'openai/gpt-test',
        launchModel: 'openai/gpt-test',
        displayName: 'OpenAI GPT Test',
        hidden: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        inputModalities: ['text'],
        supportsPersonality: false,
        isDefault: true,
        upgrade: false,
        source: 'app-server',
        metadata: {
          free: false,
          opencode: {
            providerId: 'openai',
            modelId: 'gpt-test',
            sourceLabel: 'OpenAI',
            accessKind: 'credentialed',
            routeKind: 'connected_provider',
            proofState: 'not_required',
            requiresExecutionProof: false,
            reason: null,
          },
        },
      },
    ],
    diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
  },
  modelCatalogRefreshState: 'ready',
  canLoginFromUi: true,
  capabilities: {
    teamLaunch: true,
    oneShot: true,
    extensions: {
      plugins: { status: 'supported', ownership: 'provider-scoped' },
      mcp: { status: 'supported', ownership: 'provider-scoped' },
      skills: { status: 'supported', ownership: 'provider-scoped' },
      apiKeys: { status: 'supported', ownership: 'provider-scoped' },
    },
  },
});

describe('LaunchTeamDialog provisioning authorization', () => {
  it('submits an eligible model-preflight failure when the experimental override is selected', async () => {
    let submissions = 0;
    const prepareState = resolveLaunchTeamDialogLaunchPrepareState(
      'failed',
      [
        {
          providerId: 'opencode',
          status: 'failed',
          details: ['Local model verification failed'],
          experimentalOverrideAvailable: true,
        },
      ],
      [],
      true
    );

    expect(
      await executeLaunchTeamDialogSubmission(
        {
          prepareState,
          providerStatusesAuthoritative: true,
          preparedRequestSignature: 'project:opencode:local-model',
          currentRequestSignature: 'project:opencode:local-model',
          preparedGeneration: 9,
          currentGeneration: 9,
          providerProofExpiresAtMs: freshProofExpiry,
          executionProof: freshExecutionProof,
        },
        () => {
          submissions += 1;
        }
      )
    ).toBe(true);
    expect(submissions).toBe(1);
  });

  it('imports the real dialog policy and treats successful preparation notes as advisory', () => {
    const ready: ProvisioningProviderCheck[] = [
      { providerId: 'opencode', status: 'ready', details: [] },
    ];
    const notes: ProvisioningProviderCheck[] = [
      { providerId: 'opencode', status: 'notes', details: [] },
    ];

    expect(LaunchTeamDialog).toBeTypeOf('function');
    expect(resolveProvisioningPreparationAuthorizationState(ready, [])).toBe('ready');
    expect(resolveProvisioningPreparationAuthorizationState(notes, [])).toBe('ready');
    expect(
      resolveProvisioningPreparationAuthorizationState(ready, ['compatibility exception'])
    ).toBe('ready');
  });

  it('allows advisory notes only with fresh exact provider proof and request generation', () => {
    const prepareState = resolveProvisioningPreparationAuthorizationState(
      [{ providerId: 'opencode', status: 'notes', details: ['Optional setup skipped.'] }],
      ['Optional setup skipped.']
    );
    const exactAuthorization = {
      prepareState,
      providerStatusesAuthoritative: true,
      providerProofExpiresAtMs: Date.parse('2099-01-01T00:00:00.000Z'),
      executionProof: freshExecutionProof,
      preparedRequestSignature: 'project-a:opencode:model-a',
      currentRequestSignature: 'project-a:opencode:model-a',
      preparedGeneration: 4,
      currentGeneration: 4,
    };

    expect(isLaunchTeamLaunchAuthorized(exactAuthorization)).toBe(true);
    expect(
      isLaunchTeamLaunchAuthorized({
        ...exactAuthorization,
        currentRequestSignature: 'project-b:opencode:model-a',
      })
    ).toBe(false);
    expect(
      isLaunchTeamLaunchAuthorized({ ...exactAuthorization, providerProofExpiresAtMs: 0 })
    ).toBe(false);
  });

  it('rejects note checks with error diagnostics and preserves only explicit model overrides', () => {
    const errorDiagnostic = {
      id: 'prepare-error',
      providerId: 'opencode' as const,
      kind: 'runtime',
      severity: 'error' as const,
      title: 'Runtime error',
      summary: 'Runtime verification failed.',
      copyText: 'Runtime verification failed.',
      createdAt: '2026-08-20T00:00:00.000Z',
    };
    expect(
      resolveProvisioningPreparationAuthorizationState(
        [
          {
            providerId: 'opencode',
            status: 'notes',
            details: [],
            supportDiagnostics: [errorDiagnostic],
          },
        ],
        []
      )
    ).toBe('failed');
    expect(
      resolveProvisioningPreparationAuthorizationState(
        [{ providerId: 'opencode', status: 'failed', details: [] }],
        [],
        { experimentalOverrideEnabled: true }
      )
    ).toBe('failed');
    expect(
      resolveProvisioningPreparationAuthorizationState(
        [
          {
            providerId: 'opencode',
            status: 'failed',
            details: [],
            experimentalOverrideAvailable: true,
          },
        ],
        [],
        { experimentalOverrideEnabled: true }
      )
    ).toBe('ready');
  });

  it('treats stale and static catalogs as display-only launch evidence', () => {
    const provider = authoritativeProvider();
    const canAuthorize = (providerStatus: CliProviderStatus) =>
      areLaunchTeamProviderProofsAuthoritative(
        ['opencode'],
        new Map<TeamProviderId, CliProviderStatus>([['opencode', providerStatus]]),
        new Map<TeamProviderId, boolean>([['opencode', false]])
      );

    expect(
      canAuthorize({
        ...provider,
        modelCatalog: {
          ...provider.modelCatalog!,
          staleAt: '2000-01-01T00:00:00.000Z',
        },
      })
    ).toBe(false);
    expect(
      canAuthorize({
        ...provider,
        modelCatalog: {
          ...provider.modelCatalog!,
          source: 'static-fallback',
          staleAt: '2099-08-19T00:05:00.000Z',
        },
      })
    ).toBe(false);
    expect(
      canAuthorize({
        ...provider,
        modelCatalog: {
          ...provider.modelCatalog!,
          staleAt: '2099-08-19T00:05:00.000Z',
        },
      })
    ).toBe(true);
  });

  it('does not authorize OpenCode from a static/model-only route without a fresh catalog', () => {
    const provider = authoritativeProvider();
    expect(
      areLaunchTeamProviderProofsAuthoritative(
        ['opencode'],
        new Map<TeamProviderId, CliProviderStatus>([
          [
            'opencode',
            {
              ...provider,
              models: ['openai/gpt-test'],
              modelCatalog: null,
              modelCatalogRefreshState: 'ready' as const,
            },
          ],
        ]),
        new Map<TeamProviderId, boolean>([['opencode', false]])
      )
    ).toBe(false);
  });

  it('requires the exact selected OpenCode model to be present in the fresh catalog proof', () => {
    const provider = authoritativeProvider();
    const statuses = new Map<TeamProviderId, CliProviderStatus>([['opencode', provider]]);
    const loading = new Map<TeamProviderId, boolean>([['opencode', false]]);

    expect(
      areLaunchTeamProviderProofsAuthoritative(
        ['opencode'],
        statuses,
        loading,
        new Map<TeamProviderId, { model: string; providerBackendId: 'opencode-cli' }[]>([
          [
            'opencode',
            [{ model: 'openai/not-in-project-catalog', providerBackendId: 'opencode-cli' }],
          ],
        ])
      )
    ).toBe(false);
    expect(
      areLaunchTeamProviderProofsAuthoritative(
        ['opencode'],
        statuses,
        loading,
        new Map<TeamProviderId, { model: string; providerBackendId: 'opencode-cli' }[]>([
          ['opencode', [{ model: 'openai/gpt-test', providerBackendId: 'opencode-cli' }]],
        ])
      )
    ).toBe(true);
  });

  it('submits an exact authoritative builtin-free OpenCode route without authentication', async () => {
    const provider = authoritativeProvider();
    const catalogModel = provider.modelCatalog!.models[0];
    const freeProvider: CliProviderStatus = {
      ...provider,
      authenticated: false,
      authMethod: null,
      models: ['opencode/big-pickle'],
      modelCatalog: {
        ...provider.modelCatalog!,
        defaultModelId: 'opencode/big-pickle',
        defaultLaunchModel: 'opencode/big-pickle',
        models: [
          {
            ...catalogModel,
            id: 'opencode/big-pickle',
            launchModel: 'opencode/big-pickle',
            metadata: {
              ...catalogModel.metadata,
              free: true,
              opencode: {
                ...catalogModel.metadata!.opencode!,
                providerId: 'opencode',
                modelId: 'big-pickle',
                routeKind: 'builtin_free',
                accessKind: 'builtin_free',
              },
            },
          },
        ],
      },
    };

    const providerStatusesAuthoritative = areLaunchTeamProviderProofsAuthoritative(
      ['opencode'],
      new Map<TeamProviderId, CliProviderStatus>([['opencode', freeProvider]]),
      new Map<TeamProviderId, boolean>([['opencode', false]]),
      new Map<TeamProviderId, { model: string; providerBackendId: 'opencode-cli' }[]>([
        ['opencode', [{ model: 'opencode/big-pickle', providerBackendId: 'opencode-cli' }]],
      ])
    );
    let submissions = 0;

    expect(providerStatusesAuthoritative).toBe(true);
    expect(
      await executeLaunchTeamDialogSubmission(
        {
          prepareState: 'ready',
          providerStatusesAuthoritative,
          preparedRequestSignature: 'current',
          currentRequestSignature: 'current',
          preparedGeneration: 7,
          currentGeneration: 7,
          providerProofExpiresAtMs: freshProofExpiry,
          executionProof: freshExecutionProof,
        },
        () => {
          submissions += 1;
        }
      )
    ).toBe(true);
    expect(submissions).toBe(1);
  });

  it.each([
    ['forged display readiness', { prepareState: 'ready', providerStatusesAuthoritative: false }],
    ['preparation notes', { prepareState: 'failed', providerStatusesAuthoritative: true }],
    ['loading retained catalog', { prepareState: 'loading', providerStatusesAuthoritative: false }],
    ['expired exact proof', { providerProofExpiresAtMs: 0 }],
    [
      'overlapping project completion',
      {
        prepareState: 'ready',
        providerStatusesAuthoritative: true,
        currentRequestSignature: 'project-b',
      },
    ],
    [
      'mismatched generation',
      { prepareState: 'ready', providerStatusesAuthoritative: true, currentGeneration: 10 },
    ],
  ])('does not invoke the real launch submit boundary for %s', async (_label, patch) => {
    let submissions = 0;
    expect(
      await executeLaunchTeamDialogSubmission(
        {
          prepareState: 'ready',
          providerStatusesAuthoritative: true,
          preparedRequestSignature: 'project-a',
          currentRequestSignature: 'project-a',
          preparedGeneration: 9,
          currentGeneration: 9,
          providerProofExpiresAtMs: freshProofExpiry,
          ...patch,
        },
        () => {
          submissions += 1;
        }
      )
    ).toBe(false);
    expect(submissions).toBe(0);
  });

  it('invokes the real launch submit boundary only for exact fresh proof', async () => {
    let submissions = 0;
    expect(
      await executeLaunchTeamDialogSubmission(
        {
          prepareState: 'ready',
          providerStatusesAuthoritative: true,
          preparedRequestSignature: 'project-a:opencode:fresh',
          currentRequestSignature: 'project-a:opencode:fresh',
          preparedGeneration: 9,
          currentGeneration: 9,
          providerProofExpiresAtMs: freshProofExpiry,
          executionProof: freshExecutionProof,
        },
        () => {
          submissions += 1;
        }
      )
    ).toBe(true);
    expect(submissions).toBe(1);
  });

  it.each([
    {
      label: 'provider status becomes non-authoritative',
      transition: (authorization: ProvisioningLaunchAuthorizationInput) => ({
        ...authorization,
        providerStatusesAuthoritative: false,
      }),
    },
    {
      label: 'provider/model request signature changes',
      transition: (authorization: ProvisioningLaunchAuthorizationInput) => ({
        ...authorization,
        preparedRequestSignature: 'project-b:codex:model-b',
        currentRequestSignature: 'project-b:codex:model-b',
      }),
    },
    {
      label: 'authorization generation changes',
      transition: (authorization: ProvisioningLaunchAuthorizationInput) => ({
        ...authorization,
        preparedGeneration: 10,
        currentGeneration: 10,
      }),
    },
    {
      label: 'execution proof changes',
      transition: (authorization: ProvisioningLaunchAuthorizationInput) => ({
        ...authorization,
        executionProof: {
          ...freshExecutionProof,
          authorityId: 'replacement-proof',
          generation: 2,
          requestDigest: 'b'.repeat(64),
        },
      }),
    },
  ])('rolls back without launch when $label before submit', async ({ transition }) => {
    const readyAuthorization: ProvisioningLaunchAuthorizationInput = {
      prepareState: 'ready',
      providerStatusesAuthoritative: true,
      preparedRequestSignature: 'project-a:opencode:fresh',
      currentRequestSignature: 'project-a:opencode:fresh',
      preparedGeneration: 9,
      currentGeneration: 9,
      providerProofExpiresAtMs: freshProofExpiry,
      executionProof: freshExecutionProof,
    };
    let currentAuthorization: ProvisioningLaunchAuthorizationInput = readyAuthorization;
    let releasePersistence!: () => void;
    const persistenceDeferred = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const begin = vi.fn(async () => {
      await persistenceDeferred;
      return { transactionId: 'tx', status: 'applied' as const };
    });
    const getOutcome = vi.fn(async () => ({ transactionId: 'tx', status: 'applied' as const }));
    const launch = vi.fn(async () => undefined);
    const rollback = vi.fn(async () => ({
      transactionId: 'tx',
      status: 'rolled-back' as const,
    }));
    const getAuthorization = vi.fn(() => currentAuthorization);

    const submission = executeLaunchTeamDialogSubmissionWithRecheck(
      getAuthorization,
      'tx',
      begin,
      getOutcome,
      launch,
      rollback
    );
    currentAuthorization = transition(readyAuthorization);
    releasePersistence();

    await expect(submission).resolves.toBe(false);
    expect(getAuthorization).toHaveBeenCalledTimes(2);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(getOutcome).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(0);
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('rolls back without launch when the live authorization read fails before submit', async () => {
    const authorization = {
      prepareState: 'ready',
      providerStatusesAuthoritative: true,
      preparedRequestSignature: 'project-a:opencode:fresh',
      currentRequestSignature: 'project-a:opencode:fresh',
      preparedGeneration: 9,
      currentGeneration: 9,
      providerProofExpiresAtMs: freshProofExpiry,
      executionProof: freshExecutionProof,
    };
    const getAuthorization = vi
      .fn<() => ProvisioningLaunchAuthorizationInput>()
      .mockReturnValueOnce(authorization)
      .mockImplementationOnce(() => {
        throw new Error('authorization ref unavailable');
      });
    const begin = vi.fn(async () => ({ transactionId: 'tx', status: 'applied' as const }));
    const getOutcome = vi.fn(async () => ({ transactionId: 'tx', status: 'applied' as const }));
    const launch = vi.fn(async () => undefined);
    const rollback = vi.fn(async () => ({
      transactionId: 'tx',
      status: 'rolled-back' as const,
    }));

    await expect(
      executeLaunchTeamDialogSubmissionWithRecheck(
        getAuthorization,
        'tx',
        begin,
        getOutcome,
        launch,
        rollback
      )
    ).rejects.toThrow('could not be refreshed immediately before submit');
    expect(getAuthorization).toHaveBeenCalledTimes(2);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(getOutcome).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(0);
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('restores the exact original roster when proof expires while persistence is deferred', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const readyAuthorization = {
      prepareState: 'ready',
      providerStatusesAuthoritative: true,
      preparedRequestSignature: 'project-a',
      currentRequestSignature: 'project-a',
      preparedGeneration: 1,
      currentGeneration: 1,
      providerProofExpiresAtMs: 1_001,
      executionProof: freshExecutionProof,
    };
    let authorization = readyAuthorization;
    const originalRoster = [{ name: 'alice', role: 'Reviewer' }];
    const editedRoster = [{ name: 'bob', role: 'Implementer' }];
    let persistedRoster = originalRoster;
    let finishPersistence!: () => void;
    const persistenceDeferred = new Promise<void>((resolve) => {
      finishPersistence = resolve;
    });
    const persist = vi.fn(async () => {
      await persistenceDeferred;
      persistedRoster = editedRoster;
      return { transactionId: 'tx', status: 'applied' as const };
    });
    const getOutcome = vi.fn(async () => ({ transactionId: 'tx', status: 'applied' as const }));
    const launch = vi.fn(async () => undefined);
    const rollback = vi.fn(async () => {
      persistedRoster = originalRoster;
      return { transactionId: 'tx', status: 'rolled-back' as const };
    });

    const submission = executeLaunchTeamDialogSubmissionWithRecheck(
      () => authorization,
      'tx',
      persist,
      getOutcome,
      launch,
      rollback
    );
    authorization = {
      ...readyAuthorization,
      preparedRequestSignature: 'project-b',
      currentRequestSignature: 'project-b',
      preparedGeneration: 2,
      currentGeneration: 2,
      providerProofExpiresAtMs: freshProofExpiry,
      executionProof: freshExecutionProof,
    };
    vi.setSystemTime(1_002);
    finishPersistence();

    await expect(submission).resolves.toBe(false);
    expect(persistedRoster).toBe(originalRoster);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('applies the roster once and launches once while authorization remains current', async () => {
    const authorization = {
      prepareState: 'ready',
      providerStatusesAuthoritative: true,
      preparedRequestSignature: 'project-a',
      currentRequestSignature: 'project-a',
      preparedGeneration: 1,
      currentGeneration: 1,
      providerProofExpiresAtMs: freshProofExpiry,
      executionProof: freshExecutionProof,
    };
    const persist = vi.fn(async () => ({ transactionId: 'tx', status: 'applied' as const }));
    const getOutcome = vi
      .fn()
      .mockResolvedValueOnce({ transactionId: 'tx', status: 'applied' as const })
      .mockResolvedValueOnce({ transactionId: 'tx', status: 'committed' as const });
    const launch = vi.fn(async () => undefined);
    const rollback = vi.fn(async () => ({ transactionId: 'tx', status: 'rolled-back' as const }));
    const getAuthorization = vi.fn(() => authorization);

    await expect(
      executeLaunchTeamDialogSubmissionWithRecheck(
        getAuthorization,
        'tx',
        persist,
        getOutcome,
        launch,
        rollback
      )
    ).resolves.toBe(true);
    expect(getAuthorization).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(getOutcome).toHaveBeenCalledTimes(2);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledTimes(0);
  });

  it('does one read-only lookup and rolls back when a lost begin response was applied', async () => {
    const authorization = {
      prepareState: 'ready',
      providerStatusesAuthoritative: true,
      preparedRequestSignature: 'project-a',
      currentRequestSignature: 'project-a',
      preparedGeneration: 1,
      currentGeneration: 1,
      providerProofExpiresAtMs: freshProofExpiry,
      executionProof: freshExecutionProof,
    };
    const persist = vi.fn(async () => {
      throw new Error('transport disconnected');
    });
    const getOutcome = vi.fn(async () => ({ transactionId: 'tx', status: 'applied' as const }));
    const launch = vi.fn(async () => undefined);
    const rollback = vi.fn(async () => ({ transactionId: 'tx', status: 'rolled-back' as const }));

    await expect(
      executeLaunchTeamDialogSubmissionWithRecheck(
        () => authorization,
        'tx',
        persist,
        getOutcome,
        launch,
        rollback
      )
    ).rejects.toThrow('exact prior roster was restored');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(getOutcome).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('does not launch or clobber a concurrent roster edit after begin applied', async () => {
    const authorization = {
      prepareState: 'ready',
      providerStatusesAuthoritative: true,
      preparedRequestSignature: 'project-a',
      currentRequestSignature: 'project-a',
      preparedGeneration: 1,
      currentGeneration: 1,
      providerProofExpiresAtMs: freshProofExpiry,
      executionProof: freshExecutionProof,
    };
    const begin = vi.fn(async () => ({ transactionId: 'tx', status: 'applied' as const }));
    const getOutcome = vi.fn(async () => ({ transactionId: 'tx', status: 'conflict' as const }));
    const launch = vi.fn(async () => undefined);
    const rollback = vi.fn(async () => ({ transactionId: 'tx', status: 'conflict' as const }));

    await expect(
      executeLaunchTeamDialogSubmissionWithRecheck(
        () => authorization,
        'tx',
        begin,
        getOutcome,
        launch,
        rollback
      )
    ).rejects.toThrow('applied roster could not be confirmed (conflict)');
    expect(begin).toHaveBeenCalledTimes(1);
    expect(getOutcome).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it.each(['pending', 'unknown'] as const)(
    'does not launch, replay, or guess rollback when a lost response is %s',
    async (status) => {
      const authorization = {
        prepareState: 'ready',
        providerStatusesAuthoritative: true,
        preparedRequestSignature: 'project-a',
        currentRequestSignature: 'project-a',
        preparedGeneration: 1,
        currentGeneration: 1,
        providerProofExpiresAtMs: freshProofExpiry,
        executionProof: freshExecutionProof,
      };
      const persist = vi.fn(async () => Promise.reject(new Error('transport disconnected')));
      const getOutcome = vi.fn(async () => ({ transactionId: 'tx', status }));
      const launch = vi.fn(async () => undefined);
      const rollback = vi.fn(async () => ({ transactionId: 'tx', status: 'rolled-back' as const }));

      await expect(
        executeLaunchTeamDialogSubmissionWithRecheck(
          () => authorization,
          'tx',
          persist,
          getOutcome,
          launch,
          rollback
        )
      ).rejects.toThrow(`outcome is ${status}`);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(getOutcome).toHaveBeenCalledTimes(1);
      expect(launch).not.toHaveBeenCalled();
      expect(rollback).not.toHaveBeenCalled();
    }
  );

  it('accepts a durable commit after the launch response is lost without retrying', async () => {
    const authorization = {
      prepareState: 'ready',
      providerStatusesAuthoritative: true,
      preparedRequestSignature: 'project-a',
      currentRequestSignature: 'project-a',
      preparedGeneration: 1,
      currentGeneration: 1,
      providerProofExpiresAtMs: freshProofExpiry,
      executionProof: freshExecutionProof,
    };
    const persist = vi.fn(async () => ({ transactionId: 'tx', status: 'applied' as const }));
    const getOutcome = vi
      .fn()
      .mockResolvedValueOnce({ transactionId: 'tx', status: 'applied' as const })
      .mockResolvedValueOnce({ transactionId: 'tx', status: 'committed' as const });
    const launch = vi.fn(async () => {
      throw new Error('launch response lost');
    });
    const rollback = vi.fn(async () => ({ transactionId: 'tx', status: 'rolled-back' as const }));
    const refresh = vi.fn();

    await expect(
      executeLaunchTeamDialogSubmissionWithRecheck(
        () => authorization,
        'tx',
        persist,
        getOutcome,
        launch,
        rollback,
        undefined,
        refresh
      )
    ).resolves.toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(getOutcome).toHaveBeenCalledTimes(2);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(['rolled-back', 'not-started'] as const)(
    'refreshes the consumed proof after exact durable %s reconciliation',
    async (status) => {
      const authorization = {
        prepareState: 'ready' as const,
        providerStatusesAuthoritative: true,
        preparedRequestSignature: 'project-a',
        currentRequestSignature: 'project-a',
        preparedGeneration: 1,
        currentGeneration: 1,
        providerProofExpiresAtMs: freshProofExpiry,
        executionProof: freshExecutionProof,
      };
      const getOutcome = vi
        .fn()
        .mockResolvedValueOnce({ transactionId: 'tx', status: 'applied' as const })
        .mockResolvedValueOnce({ transactionId: 'tx', status });
      const rollback = vi.fn(async () => ({ transactionId: 'tx', status: 'rolled-back' as const }));
      const refresh = vi.fn();
      const transportError = Object.assign(new Error('authoritative no-dispatch'), {
        code: TEAM_LAUNCH_KNOWN_NO_DISPATCH_ERROR_CODE,
      });
      const storeError = Object.assign(new Error('launch failed'), { causeError: transportError });

      await expect(
        executeLaunchTeamDialogSubmissionWithRecheck(
          () => authorization,
          'tx',
          async () => ({ transactionId: 'tx', status: 'applied' as const }),
          getOutcome,
          async () => Promise.reject(storeError),
          rollback,
          undefined,
          refresh
        )
      ).resolves.toBe(false);
      expect(getOutcome).toHaveBeenCalledTimes(2);
      expect(rollback).not.toHaveBeenCalled();
      expect(refresh).toHaveBeenCalledOnce();
    }
  );

  it.each(['rolled-back', 'not-started'] as const)(
    'rejects a foreign %s reconciliation without refreshing authorization',
    async (status) => {
      const authorization = {
        prepareState: 'ready' as const,
        providerStatusesAuthoritative: true,
        preparedRequestSignature: 'project-a',
        currentRequestSignature: 'project-a',
        preparedGeneration: 1,
        currentGeneration: 1,
        providerProofExpiresAtMs: freshProofExpiry,
        executionProof: freshExecutionProof,
      };
      const failure = new Error('launch response lost');
      const getOutcome = vi
        .fn()
        .mockResolvedValueOnce({ transactionId: 'tx', status: 'applied' as const })
        .mockResolvedValueOnce({ transactionId: 'foreign-tx', status });
      const refresh = vi.fn();
      const launch = vi.fn(async () => Promise.reject(failure));

      await expect(
        executeLaunchTeamDialogSubmissionWithRecheck(
          () => authorization,
          'tx',
          async () => ({ transactionId: 'tx', status: 'applied' as const }),
          getOutcome,
          launch,
          vi.fn(),
          undefined,
          refresh
        )
      ).rejects.toBe(failure);
      expect(launch).toHaveBeenCalledOnce();
      expect(refresh).not.toHaveBeenCalled();
    }
  );

  it.each(['prepared', 'launch-unknown', 'unknown'] as const)(
    'preserves the launch rejection when reconciliation finds %s',
    async (status) => {
      const authorization = {
        prepareState: 'ready',
        providerStatusesAuthoritative: true,
        preparedRequestSignature: 'project-a',
        currentRequestSignature: 'project-a',
        preparedGeneration: 1,
        currentGeneration: 1,
        providerProofExpiresAtMs: freshProofExpiry,
        executionProof: freshExecutionProof,
      };
      const persist = vi.fn(async () => ({ transactionId: 'tx', status: 'applied' as const }));
      const getOutcome = vi
        .fn()
        .mockResolvedValueOnce({ transactionId: 'tx', status: 'applied' as const })
        .mockResolvedValueOnce({ transactionId: 'tx', status });
      const failure = new Error('launch response lost');
      const launch = vi.fn(async () => Promise.reject(failure));
      const rollback = vi.fn(async () => ({
        transactionId: 'tx',
        status: 'rolled-back' as const,
      }));
      const refresh = vi.fn();

      await expect(
        executeLaunchTeamDialogSubmissionWithRecheck(
          () => authorization,
          'tx',
          persist,
          getOutcome,
          launch,
          rollback,
          undefined,
          refresh
        )
      ).rejects.toBe(failure);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(getOutcome).toHaveBeenCalledTimes(2);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(rollback).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    }
  );

  it.each(['stop-rejected', 'aborted-before-stop'] as const)(
    'rolls back exactly once for a known %s relaunch failure',
    async (kind) => {
      const authorization = {
        prepareState: 'ready' as const,
        providerStatusesAuthoritative: true,
        preparedRequestSignature: 'project-a',
        currentRequestSignature: 'project-a',
        preparedGeneration: 1,
        currentGeneration: 1,
        providerProofExpiresAtMs: freshProofExpiry,
        executionProof: freshExecutionProof,
      };
      const getOutcome = vi.fn(async () => ({ transactionId: 'tx', status: 'applied' as const }));
      const rollback = vi.fn(async () => ({
        transactionId: 'tx',
        status: 'rolled-back' as const,
      }));
      const failure = new TeamRelaunchKnownPreDispatchFailure(
        kind,
        'relaunch failed before stop dispatch'
      );

      await expect(
        executeLaunchTeamDialogSubmissionWithRecheck(
          () => authorization,
          'tx',
          async () => ({ transactionId: 'tx', status: 'applied' as const }),
          getOutcome,
          async () => {
            throw failure;
          },
          rollback
        )
      ).rejects.toBe(failure);
      expect(getOutcome).toHaveBeenCalledTimes(1);
      expect(rollback).toHaveBeenCalledTimes(1);
    }
  );

  it('rolls back stale relaunch A after deferred stop when dialog B reopens', async () => {
    const authorization = {
      prepareState: 'ready' as const,
      providerStatusesAuthoritative: true,
      preparedRequestSignature: 'project-a',
      currentRequestSignature: 'project-a',
      preparedGeneration: 1,
      currentGeneration: 1,
      providerProofExpiresAtMs: freshProofExpiry,
      executionProof: freshExecutionProof,
    };
    let resolveStop!: (outcome: { status: 'stopped' }) => void;
    const deferredStop = new Promise<{ status: 'stopped' }>((resolve) => {
      resolveStop = resolve;
    });
    let dialogGeneration = 1;
    const submissionGeneration = dialogGeneration;
    const isCurrent = (): boolean => dialogGeneration === submissionGeneration;
    const launch = vi.fn(async () => undefined);
    const stopTeam = vi.fn(() => deferredStop);
    const rollback = vi.fn(async () => ({ transactionId: 'tx-a', status: 'rolled-back' as const }));

    const staleSubmission = executeLaunchTeamDialogSubmissionWithRecheck(
      () => authorization,
      'tx-a',
      async () => ({ transactionId: 'tx-a', status: 'applied' as const }),
      async () => ({ transactionId: 'tx-a', status: 'applied' as const }),
      () =>
        executeTeamRelaunch({
          teamName: 'team-a',
          isTeamAlive: true,
          request: { teamName: 'team-a', cwd: '/sandbox', rosterTransactionId: 'tx-a' },
          members: [{ name: 'builder' }],
          stopTeam,
          replaceMembers: vi.fn(),
          launchTeam: launch,
          isCurrent,
        }),
      rollback,
      isCurrent
    );

    await vi.waitFor(() => expect(stopTeam).toHaveBeenCalledTimes(1));
    dialogGeneration += 1; // close A
    dialogGeneration += 1; // reopen B
    resolveStop({ status: 'stopped' });

    await expect(staleSubmission).rejects.toMatchObject({
      name: 'TeamRelaunchKnownPreDispatchFailure',
      kind: 'aborted-after-stop',
    });
    expect(launch).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('does not roll back an unknown relaunch stop transport outcome', async () => {
    const authorization = {
      prepareState: 'ready' as const,
      providerStatusesAuthoritative: true,
      preparedRequestSignature: 'project-a',
      currentRequestSignature: 'project-a',
      preparedGeneration: 1,
      currentGeneration: 1,
      providerProofExpiresAtMs: freshProofExpiry,
      executionProof: freshExecutionProof,
    };
    const unknown = new TeamRelaunchStopOutcomeUnknownError('stop response lost');
    const rollback = vi.fn();

    await expect(
      executeLaunchTeamDialogSubmissionWithRecheck(
        () => authorization,
        'tx',
        async () => ({ transactionId: 'tx', status: 'applied' as const }),
        async () => ({ transactionId: 'tx', status: 'applied' as const }),
        async () => {
          throw unknown;
        },
        rollback
      )
    ).rejects.toBe(unknown);
    expect(rollback).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'rollback transport failure',
      rollback: async () => {
        throw new Error('rollback transport unavailable');
      },
      diagnostic: 'rollback transport unavailable',
    },
    {
      label: 'stale competing transaction generation',
      rollback: async () => ({
        transactionId: 'tx',
        status: 'conflict' as const,
        message: 'A newer roster generation owns the reservation.',
      }),
      diagnostic:
        'The roster authorization transaction could not be safely rolled back (conflict). A newer roster generation owns the reservation.',
    },
  ])('preserves known stop and $label diagnostics', async ({ rollback, diagnostic }) => {
    const authorization = {
      prepareState: 'ready' as const,
      providerStatusesAuthoritative: true,
      preparedRequestSignature: 'project-a',
      currentRequestSignature: 'project-a',
      preparedGeneration: 1,
      currentGeneration: 1,
      providerProofExpiresAtMs: freshProofExpiry,
      executionProof: freshExecutionProof,
    };

    await expect(
      executeLaunchTeamDialogSubmissionWithRecheck(
        () => authorization,
        'tx',
        async () => ({ transactionId: 'tx', status: 'applied' as const }),
        async () => ({ transactionId: 'tx', status: 'applied' as const }),
        async () => {
          throw new TeamRelaunchKnownPreDispatchFailure(
            'stop-rejected',
            'stop rejected before relaunch dispatch'
          );
        },
        vi.fn(rollback)
      )
    ).rejects.toThrow(
      `stop rejected before relaunch dispatch; immediate roster rollback failed: ${diagnostic}`
    );
  });

  it('surfaces an exact-roster rollback failure without launching or retrying', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const readyAuthorization = {
      prepareState: 'ready',
      providerStatusesAuthoritative: true,
      preparedRequestSignature: 'project-a',
      currentRequestSignature: 'project-a',
      preparedGeneration: 1,
      currentGeneration: 1,
      providerProofExpiresAtMs: 1_001,
      executionProof: freshExecutionProof,
    };
    let authorization = readyAuthorization;
    const persist = vi.fn(async () => {
      authorization = { ...readyAuthorization, providerProofExpiresAtMs: 0 };
      vi.setSystemTime(1_002);
      return { transactionId: 'tx', status: 'applied' as const };
    });
    const getOutcome = vi.fn(async () => ({ transactionId: 'tx', status: 'applied' as const }));
    const launch = vi.fn(async () => undefined);
    const rollback = vi.fn(async () => {
      throw new Error('disk remained read-only');
    });

    await expect(
      executeLaunchTeamDialogSubmissionWithRecheck(
        () => authorization,
        'tx',
        persist,
        getOutcome,
        launch,
        rollback
      )
    ).rejects.toThrow('disk remained read-only');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('leaves the submit authorization ref unchanged during render until commit', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const committedAuthorization: ProvisioningLaunchAuthorizationInput = {
      prepareState: 'ready',
      providerStatusesAuthoritative: true,
      preparedRequestSignature: 'project-a',
      currentRequestSignature: 'project-a',
      preparedGeneration: 1,
      currentGeneration: 1,
      providerProofExpiresAtMs: freshProofExpiry,
      executionProof: freshExecutionProof,
    };
    const nextAuthorization: ProvisioningLaunchAuthorizationInput = {
      ...committedAuthorization,
      currentRequestSignature: 'discarded-project',
    };
    const authorizationObservedBeforeLayoutCommit = vi.fn();
    let committedValue: ProvisioningLaunchAuthorizationInput | null = null;
    const Probe = ({
      authorization,
    }: {
      authorization: ProvisioningLaunchAuthorizationInput;
    }): React.JSX.Element | null => {
      const authorizationRef = useCommittedLaunchAuthorizationRef(authorization);
      useEffect(() => {
        committedValue = authorizationRef.current;
      }, [authorization, authorizationRef]);
      return React.createElement('span', {
        ref: () => authorizationObservedBeforeLayoutCommit(authorizationRef.current),
      });
    };
    const container = document.createElement('div');
    const root = createRoot(container);

    try {
      act(() => {
        root.render(React.createElement(Probe, { authorization: committedAuthorization }));
      });
      expect(committedValue).toBe(committedAuthorization);

      act(() => {
        root.render(React.createElement(Probe, { authorization: nextAuthorization }));
      });
      expect(authorizationObservedBeforeLayoutCommit).toHaveBeenLastCalledWith(
        committedAuthorization
      );
      expect(committedValue).toBe(nextAuthorization);
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it('does not let a discarded Create or Launch render authorize submission', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const deniedAuthorization: ProvisioningLaunchAuthorizationInput = {
      prepareState: 'failed',
      providerStatusesAuthoritative: false,
      preparedRequestSignature: null,
      currentRequestSignature: 'project-a',
      preparedGeneration: null,
      currentGeneration: 1,
      providerProofExpiresAtMs: null,
    };
    const discardedReadyAuthorization: ProvisioningLaunchAuthorizationInput = {
      prepareState: 'ready',
      providerStatusesAuthoritative: true,
      preparedRequestSignature: 'project-a',
      currentRequestSignature: 'project-a',
      preparedGeneration: 1,
      currentGeneration: 1,
      providerProofExpiresAtMs: freshProofExpiry,
      executionProof: freshExecutionProof,
    };
    let authorizationRef: React.RefObject<ProvisioningLaunchAuthorizationInput> | null = null;
    const neverCommits = new Promise<never>(() => undefined);
    const Suspend = React.lazy(() => neverCommits);
    const Probe = ({
      authorization,
      discard,
      onCommit,
    }: {
      authorization: ProvisioningLaunchAuthorizationInput;
      discard: boolean;
      onCommit(ref: React.RefObject<ProvisioningLaunchAuthorizationInput>): void;
    }): React.JSX.Element | null => {
      const committedAuthorizationRef = useCommittedLaunchAuthorizationRef(authorization);
      useEffect(() => onCommit(committedAuthorizationRef), [committedAuthorizationRef, onCommit]);
      return discard ? React.createElement(Suspend) : null;
    };
    const captureCommittedAuthorizationRef = (
      ref: React.RefObject<ProvisioningLaunchAuthorizationInput>
    ): void => {
      authorizationRef = ref;
    };
    const container = document.createElement('div');
    const root = createRoot(container);

    try {
      act(() => {
        root.render(
          React.createElement(
            React.Suspense,
            { fallback: null },
            React.createElement(Probe, {
              authorization: deniedAuthorization,
              discard: false,
              onCommit: captureCommittedAuthorizationRef,
            })
          )
        );
      });
      act(() => {
        root.render(
          React.createElement(
            React.Suspense,
            { fallback: null },
            React.createElement(Probe, {
              authorization: discardedReadyAuthorization,
              discard: true,
              onCommit: captureCommittedAuthorizationRef,
            })
          )
        );
      });
      let submissions = 0;
      expect(
        await executeLaunchTeamDialogSubmission(authorizationRef!.current, () => {
          submissions += 1;
        })
      ).toBe(false);
      expect(authorizationRef!.current).toBe(deniedAuthorization);
      expect(submissions).toBe(0);
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it.each(['idle', 'loading', 'failed', 'stale', 'degraded', 'unknown', null, undefined])(
    'fails closed for %s preparation',
    async (state) => {
      let submissions = 0;
      expect(isAuthoritativeProvisioningReady(state)).toBe(false);
      expect(
        await executeLaunchTeamDialogSubmission(
          {
            prepareState: state,
            providerStatusesAuthoritative: true,
            preparedRequestSignature: 'current-request',
            currentRequestSignature: 'current-request',
            preparedGeneration: 3,
            currentGeneration: 3,
            providerProofExpiresAtMs: freshProofExpiry,
          },
          () => {
            submissions += 1;
          }
        )
      ).toBe(false);
      expect(submissions).toBe(0);
    }
  );

  it('allows submission only for explicit ready preparation', () => {
    expect(isAuthoritativeProvisioningReady('ready')).toBe(true);
    expect(
      isLaunchTeamLaunchAuthorized({
        prepareState: 'ready',
        providerStatusesAuthoritative: true,
        preparedRequestSignature: 'current-request',
        currentRequestSignature: 'current-request',
        preparedGeneration: 3,
        currentGeneration: 3,
        providerProofExpiresAtMs: freshProofExpiry,
        executionProof: freshExecutionProof,
      })
    ).toBe(true);
  });

  it('invalidates ready preparation immediately when project or request scope changes', () => {
    const authorization = {
      prepareState: 'ready',
      preparedRequestSignature: 'project-a:providers-a:members-a:models-a:config-a',
      preparedGeneration: 7,
      providerProofExpiresAtMs: freshProofExpiry,
      executionProof: freshExecutionProof,
    };

    expect(
      isLaunchTeamLaunchAuthorized({
        ...authorization,
        providerStatusesAuthoritative: true,
        currentRequestSignature: authorization.preparedRequestSignature,
        currentGeneration: 7,
      })
    ).toBe(true);
    expect(
      isLaunchTeamLaunchAuthorized({
        ...authorization,
        providerStatusesAuthoritative: true,
        currentRequestSignature: 'project-b:providers-a:members-a:models-a:config-a',
        currentGeneration: 7,
      })
    ).toBe(false);
    expect(
      isLaunchTeamLaunchAuthorized({
        ...authorization,
        providerStatusesAuthoritative: true,
        currentRequestSignature: authorization.preparedRequestSignature,
        currentGeneration: 8,
      })
    ).toBe(false);
  });

  it('changes the preparation scope for transient, stale, degraded, and loading provider state', () => {
    const ready = authoritativeProvider();
    const readyMap = new Map<TeamProviderId, CliProviderStatus>([['opencode', ready]]);
    const signature = buildProviderPrepareRuntimeStatusSignature(
      ['opencode'],
      readyMap,
      new Map<TeamProviderId, boolean>([['opencode', false]])
    );
    const changedStatuses: CliProviderStatus[] = [
      {
        ...ready,
        authenticated: false,
        verificationState: 'error',
        statusCheckOutcome: 'transient_error',
        capabilities: { ...ready.capabilities, teamLaunch: false },
      },
      { ...ready, modelCatalog: { ...ready.modelCatalog!, status: 'stale' } },
      {
        ...ready,
        modelCatalog: { ...ready.modelCatalog!, status: 'degraded' },
      },
      {
        ...ready,
        modelCatalog: { ...ready.modelCatalog!, status: 'unavailable' },
      },
    ];

    for (const changed of changedStatuses) {
      expect(
        buildProviderPrepareRuntimeStatusSignature(
          ['opencode'],
          new Map<TeamProviderId, CliProviderStatus>([['opencode', changed]]),
          new Map<TeamProviderId, boolean>([['opencode', false]])
        )
      ).not.toBe(signature);
    }
    expect(
      buildProviderPrepareRuntimeStatusSignature(
        ['opencode'],
        readyMap,
        new Map<TeamProviderId, boolean>([['opencode', true]])
      )
    ).not.toBe(signature);
  });

  it('blocks cached ready during a transient refresh and its replacement preflight', () => {
    const ready = authoritativeProvider();
    const readySignature = buildProviderPrepareRuntimeStatusSignature(
      ['opencode'],
      new Map<TeamProviderId, CliProviderStatus>([['opencode', ready]]),
      new Map<TeamProviderId, boolean>([['opencode', false]])
    );
    const transientSignature = buildProviderPrepareRuntimeStatusSignature(
      ['opencode'],
      new Map<TeamProviderId, CliProviderStatus>([
        [
          'opencode',
          {
            ...ready,
            authenticated: false,
            verificationState: 'error' as const,
            statusCheckOutcome: 'transient_error' as const,
            capabilities: { ...ready.capabilities, teamLaunch: false },
          },
        ],
      ]),
      new Map<TeamProviderId, boolean>([['opencode', false]])
    );

    for (const prepareState of ['ready', 'loading']) {
      expect(
        isLaunchTeamLaunchAuthorized({
          prepareState,
          providerStatusesAuthoritative: true,
          preparedRequestSignature: readySignature,
          currentRequestSignature: transientSignature,
          preparedGeneration: 8,
          currentGeneration: 9,
          providerProofExpiresAtMs: freshProofExpiry,
        })
      ).toBe(false);
    }
  });

  it('changes the preparation signature for a new exact-scope proof generation', () => {
    const statuses = new Map<TeamProviderId, CliProviderStatus>([
      ['opencode', authoritativeProvider()],
    ]);
    const first = buildProviderPrepareRuntimeStatusSignature(
      ['opencode'],
      statuses,
      undefined,
      new Map<TeamProviderId, string>([['opencode', '4:11']])
    );
    const second = buildProviderPrepareRuntimeStatusSignature(
      ['opencode'],
      statuses,
      undefined,
      new Map<TeamProviderId, string>([['opencode', '4:12']])
    );

    expect(second).not.toBe(first);
  });

  it.each([
    ['backend', { providerBackendId: 'adapter', model: 'openai/model-a' }],
    ['model', { providerBackendId: 'opencode-cli', model: 'openai/model-b' }],
  ] as const)('rejects a prepared proof after an exact %s selection change', (_label, next) => {
    const buildSignature = (providerBackendId: TeamProviderBackendId, model: string): string =>
      buildProviderPrepareModelChecksSignature(
        new Map<TeamProviderId, { providerBackendId: TeamProviderBackendId; model: string }[]>([
          ['opencode', [{ providerBackendId, model }]],
        ])
      );
    const preparedRequestSignature = buildSignature('opencode-cli', 'openai/model-a');
    const currentRequestSignature = buildSignature(next.providerBackendId, next.model);

    expect(currentRequestSignature).not.toBe(preparedRequestSignature);
    expect(
      isLaunchTeamLaunchAuthorized({
        prepareState: 'ready',
        providerStatusesAuthoritative: true,
        preparedRequestSignature,
        currentRequestSignature,
        preparedGeneration: 12,
        currentGeneration: 12,
        providerProofExpiresAtMs: freshProofExpiry,
        executionProof: freshExecutionProof,
      })
    ).toBe(false);
  });

  it('requires every current provider status to be fresh and authoritative', () => {
    const ready = authoritativeProvider();
    const statuses = new Map<TeamProviderId, CliProviderStatus>([['opencode', ready]]);
    const loading = new Map<TeamProviderId, boolean>([['opencode', false]]);

    expect(areLaunchTeamProviderProofsAuthoritative(['opencode'], statuses, loading)).toBe(true);
    expect(
      areProviderLaunchStatusesAuthoritative(
        ['opencode'],
        new Map([['opencode', { ...ready, statusCheckOutcome: 'model_only' as const }]]),
        loading
      )
    ).toBe(false);
    expect(
      areProviderLaunchStatusesAuthoritative(
        ['opencode'],
        new Map([
          [
            'opencode',
            {
              ...ready,
              modelCatalog: {
                ...ready.modelCatalog!,
                status: 'stale' as const,
              },
            },
          ],
        ]),
        loading
      )
    ).toBe(false);
    expect(
      areProviderLaunchStatusesAuthoritative(['opencode'], statuses, new Map([['opencode', true]]))
    ).toBe(false);
  });
});
