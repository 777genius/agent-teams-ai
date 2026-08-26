import { describe, expect, it } from 'vitest';

import {
  areCreateTeamProviderProofsAuthoritative,
  CreateTeamDialog,
  executeCreateTeamDialogLaunchSubmission,
  resolveCreateTeamDialogLaunchPrepareState,
} from './CreateTeamDialog';
import {
  cancelScheduledProviderPrepareIdle,
  isCreateTeamLaunchAuthorized,
  type ProviderPrepareIdleScheduler,
  resolveProvisioningPreparationAuthorizationState,
  type ScheduledProviderPrepareIdleHandle,
  scheduleGuardedProviderPrepareIdle,
} from './provisioningLaunchAuthorization';

import type { ProvisioningProviderCheck } from './provisioningProviderChecks';
import type { CliProviderStatus, TeamProviderId } from '@shared/types';

const freshProofExpiry = Date.parse('2099-01-01T00:00:00.000Z');
const freshExecutionProof = {
  authorityId: 'renderer-proof',
  generation: 1,
  completedAt: '2026-08-21T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
  requestDigest: 'a'.repeat(64),
};

function authoritativeOpenCodeProvider(): CliProviderStatus {
  return {
    providerId: 'opencode',
    displayName: 'OpenCode',
    supported: true,
    authenticated: true,
    authMethod: 'opencode_configured_local',
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    models: ['openai/gpt-test'],
    modelCatalogRefreshState: 'ready',
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
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: {
        plugins: { status: 'unsupported', ownership: 'provider-scoped' },
        mcp: { status: 'supported', ownership: 'provider-scoped' },
        skills: { status: 'supported', ownership: 'provider-scoped' },
        apiKeys: { status: 'supported', ownership: 'provider-scoped' },
      },
    },
  };
}

describe('CreateTeamDialog launch preparation authorization', () => {
  it('submits an eligible model-preflight failure when the experimental override is selected', async () => {
    let submissions = 0;
    const prepareState = resolveCreateTeamDialogLaunchPrepareState(
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
      await executeCreateTeamDialogLaunchSubmission(
        {
          prepareState,
          providerStatusesAuthoritative: true,
          preparedRequestSignature: 'project:opencode:local-model',
          currentRequestSignature: 'project:opencode:local-model',
          preparedGeneration: 4,
          currentGeneration: 4,
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

  it('allows advisory warnings and notes only with exact current launch authorization', () => {
    const advisoryChecks: ProvisioningProviderCheck[] = [
      { providerId: 'opencode', status: 'notes', details: ['Optional plugin was skipped.'] },
    ];
    const prepareState = resolveProvisioningPreparationAuthorizationState(advisoryChecks, [
      'OpenCode: Optional plugin was skipped.',
    ]);

    expect(prepareState).toBe('ready');
    expect(
      isCreateTeamLaunchAuthorized({
        prepareState,
        providerStatusesAuthoritative: true,
        providerProofExpiresAtMs: Date.parse('2099-01-01T00:00:00.000Z'),
        executionProof: freshExecutionProof,
        preparedRequestSignature: 'project-a:opencode:model-a',
        currentRequestSignature: 'project-a:opencode:model-a',
        preparedGeneration: 3,
        currentGeneration: 3,
      })
    ).toBe(true);
    expect(
      isCreateTeamLaunchAuthorized({
        prepareState,
        providerStatusesAuthoritative: false,
        providerProofExpiresAtMs: Date.parse('2099-01-01T00:00:00.000Z'),
        preparedRequestSignature: 'project-a:opencode:model-a',
        currentRequestSignature: 'project-a:opencode:model-a',
        preparedGeneration: 3,
        currentGeneration: 3,
      })
    ).toBe(false);
  });

  it('does not promote notes containing errors or accompanying failed checks', () => {
    const errorDiagnostic = {
      id: 'prepare-error',
      providerId: 'opencode' as const,
      kind: 'runtime',
      severity: 'error' as const,
      title: 'Runtime error',
      summary: 'Credential verification failed.',
      copyText: 'Credential verification failed.',
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
        [
          { providerId: 'opencode', status: 'notes', details: [] },
          { providerId: 'codex', status: 'failed', details: ['Authentication failed.'] },
        ],
        ['advisory']
      )
    ).toBe('failed');
  });

  it('requires fresh exact OpenCode catalog proof for the selected provider and model', () => {
    const provider = authoritativeOpenCodeProvider();
    const loading = new Map<TeamProviderId, boolean>([['opencode', false]]);
    const selectedModels = new Map<
      TeamProviderId,
      { model: string; providerBackendId: 'opencode-cli' }[]
    >([['opencode', [{ model: 'openai/gpt-test', providerBackendId: 'opencode-cli' }]]]);
    const authorize = (
      candidate: CliProviderStatus,
      models: ReadonlyMap<
        TeamProviderId,
        readonly { model: string; providerBackendId?: 'opencode-cli' }[]
      > = selectedModels
    ) =>
      areCreateTeamProviderProofsAuthoritative(
        ['opencode'],
        new Map<TeamProviderId, CliProviderStatus>([['opencode', candidate]]),
        loading,
        models
      );

    expect(authorize(provider)).toBe(true);
    expect(authorize({ ...provider, modelCatalog: null })).toBe(false);
    expect(authorize({ ...provider, statusCheckOutcome: 'model_only' })).toBe(false);
    expect(
      authorize({
        ...provider,
        modelCatalog: { ...provider.modelCatalog!, source: 'static-fallback' },
      })
    ).toBe(false);
    expect(
      authorize({
        ...provider,
        modelCatalog: { ...provider.modelCatalog!, status: 'stale' },
      })
    ).toBe(false);
    expect(
      authorize({
        ...provider,
        modelCatalog: { ...provider.modelCatalog!, status: 'degraded' },
      })
    ).toBe(false);
    expect(authorize({ ...provider, modelCatalogRefreshState: 'loading' })).toBe(false);
    expect(authorize({ ...provider, verificationState: 'unknown' })).toBe(false);
    expect(
      authorize(
        provider,
        new Map<TeamProviderId, { model: string }[]>([
          ['opencode', [{ model: 'openai/not-in-current-catalog' }]],
        ])
      )
    ).toBe(false);
    expect(
      areCreateTeamProviderProofsAuthoritative(
        ['opencode'],
        new Map<TeamProviderId, CliProviderStatus>([
          ['opencode', { ...provider, providerId: 'codex' }],
        ]),
        loading,
        selectedModels
      )
    ).toBe(false);
  });

  it('submits an exact authoritative builtin-free OpenCode route without authentication', async () => {
    const provider = authoritativeOpenCodeProvider();
    const loading = new Map<TeamProviderId, boolean>([['opencode', false]]);
    const selectedModels = new Map<
      TeamProviderId,
      { model: string; providerBackendId: 'opencode-cli' }[]
    >([
      ['opencode', [{ model: 'opencode/big-pickle', providerBackendId: 'opencode-cli' }]],
    ]);
    let submissions = 0;
    const catalogModel = provider.modelCatalog!.models[0];
    const candidate: CliProviderStatus = {
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
    const providerStatusesAuthoritative = areCreateTeamProviderProofsAuthoritative(
      ['opencode'],
      new Map<TeamProviderId, CliProviderStatus>([['opencode', candidate]]),
      loading,
      selectedModels
    );

    expect(providerStatusesAuthoritative).toBe(true);
    expect(
      await executeCreateTeamDialogLaunchSubmission(
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
      'mismatched project signature',
      {
        prepareState: 'ready',
        providerStatusesAuthoritative: true,
        currentRequestSignature: 'project-b',
      },
    ],
    [
      'mismatched generation',
      { prepareState: 'ready', providerStatusesAuthoritative: true, currentGeneration: 5 },
    ],
  ])('does not invoke the real create-and-launch submit boundary for %s', async (_label, patch) => {
    expect(CreateTeamDialog).toBeTypeOf('function');
    let submissions = 0;
    const submitted = await executeCreateTeamDialogLaunchSubmission(
      {
        prepareState: 'ready',
        providerStatusesAuthoritative: true,
        preparedRequestSignature: 'project-a',
        currentRequestSignature: 'project-a',
        preparedGeneration: 4,
        currentGeneration: 4,
        providerProofExpiresAtMs: freshProofExpiry,
        ...patch,
      },
      () => {
        submissions += 1;
      }
    );
    expect(submitted).toBe(false);
    expect(submissions).toBe(0);
  });

  it('invokes the real create-and-launch submit boundary for exact fresh proof', async () => {
    let submissions = 0;
    expect(
      await executeCreateTeamDialogLaunchSubmission(
        {
          prepareState: 'ready',
          providerStatusesAuthoritative: true,
          preparedRequestSignature: 'project-a:opencode:fresh',
          currentRequestSignature: 'project-a:opencode:fresh',
          preparedGeneration: 4,
          currentGeneration: 4,
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

  it.each(['idle', 'loading', 'failed', 'stale', 'degraded', 'unknown', null, undefined])(
    'blocks create-and-launch while preparation is %s',
    (state) => {
      expect(
        isCreateTeamLaunchAuthorized({
          prepareState: state,
          providerStatusesAuthoritative: true,
          preparedRequestSignature: 'current-request',
          currentRequestSignature: 'current-request',
          preparedGeneration: 4,
          currentGeneration: 4,
          providerProofExpiresAtMs: freshProofExpiry,
        })
      ).toBe(false);
    }
  );

  it('rejects authoritative readiness from a stale request signature or generation', () => {
    const prepared = {
      prepareState: 'ready',
      preparedRequestSignature: 'project-a:provider-a:members-a:models-a:config-a',
      preparedGeneration: 4,
      providerProofExpiresAtMs: freshProofExpiry,
      executionProof: freshExecutionProof,
    };

    expect(
      isCreateTeamLaunchAuthorized({
        ...prepared,
        providerStatusesAuthoritative: true,
        currentRequestSignature: 'project-a:provider-a:members-a:models-a:config-a',
        currentGeneration: 4,
      })
    ).toBe(true);
    expect(
      isCreateTeamLaunchAuthorized({
        ...prepared,
        providerStatusesAuthoritative: true,
        currentRequestSignature: 'project-b:provider-a:members-a:models-a:config-a',
        currentGeneration: 4,
      })
    ).toBe(false);
    expect(
      isCreateTeamLaunchAuthorized({
        ...prepared,
        providerStatusesAuthoritative: true,
        currentRequestSignature: prepared.preparedRequestSignature,
        currentGeneration: 5,
      })
    ).toBe(false);
  });

  it.each([
    ['teamName', 'team-b'],
    ['selectedFastMode', 'fast'],
    ['worktreeName', 'feature-b'],
    ['customArgs', '--new-value'],
  ])('does not let an older idle callback consume newer %s work', (changedField, changedValue) => {
    const callbacks = new Map<number, () => void>();
    const cancelled: number[] = [];
    let nextId = 0;
    const scheduler: ProviderPrepareIdleScheduler = {
      requestIdleCallback: (callback) => {
        const id = ++nextId;
        callbacks.set(id, callback);
        return id;
      },
      cancelIdleCallback: (id) => cancelled.push(id),
      setTimeout: () => -1,
      clearTimeout: () => undefined,
    };
    const handles = new Set<ScheduledProviderPrepareIdleHandle>();
    const baseRequest = {
      teamName: 'team-a',
      selectedFastMode: 'standard',
      worktreeName: 'feature-a',
      customArgs: '--old-value',
    };
    let generation = 1;
    let currentSignature = JSON.stringify(baseRequest);
    let pendingSignature: string | null = currentSignature;
    let authorizedSignature: string | null = null;
    const scheduleCurrent = (): void => {
      const capturedSignature = currentSignature;
      scheduleGuardedProviderPrepareIdle({
        scheduler,
        handles,
        generation,
        requestSignature: capturedSignature,
        getCurrentGeneration: () => generation,
        getCurrentRequestSignature: () => currentSignature,
        run: () => {
          if (pendingSignature === capturedSignature) {
            pendingSignature = null;
            authorizedSignature = capturedSignature;
          }
        },
      });
    };

    scheduleCurrent();
    cancelScheduledProviderPrepareIdle(scheduler, handles);
    generation += 1;
    currentSignature = JSON.stringify({
      ...baseRequest,
      [changedField]: changedValue,
    });
    pendingSignature = currentSignature;
    authorizedSignature = null;
    scheduleCurrent();

    callbacks.get(1)?.();
    expect(pendingSignature).toBe(currentSignature);
    expect(authorizedSignature).toBeNull();
    callbacks.get(2)?.();
    expect(cancelled).toEqual([1]);
    expect(pendingSignature).toBeNull();
    expect(authorizedSignature).toBe(currentSignature);
    expect(
      isCreateTeamLaunchAuthorized({
        prepareState: 'ready',
        providerStatusesAuthoritative: true,
        preparedRequestSignature: authorizedSignature,
        currentRequestSignature: currentSignature,
        preparedGeneration: generation,
        currentGeneration: generation,
        providerProofExpiresAtMs: freshProofExpiry,
        executionProof: freshExecutionProof,
      })
    ).toBe(true);
  });
});
