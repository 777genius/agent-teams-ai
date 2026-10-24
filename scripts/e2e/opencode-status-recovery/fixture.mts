// Read-only CLI fixture, executed only with a disposable HOME and project.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { OpenCodeTeamLaunchReadiness } from '../../../src/main/services/team/opencode/readiness/OpenCodeTeamLaunchReadiness.ts';
import type { CliProviderId, CliProviderStatus } from '../../../src/shared/types/cliInstaller.ts';

const root = process.env.OPENCODE_RECOVERY_FIXTURE_ROOT;
assert(root && path.basename(root).startsWith('opencode-recovery-test-'));
const [role, ...args] = process.argv.slice(2);
const phase = readFileSync(path.join(root, 'phase'), 'utf8').trim();
const project = path.join(root, 'sandbox-project');
const scoped = process.cwd() === project;
const record = (event: Record<string, unknown>) =>
  appendFileSync(
    path.join(root, 'calls.ndjson'),
    JSON.stringify({ at: Date.now(), cwd: process.cwd(), role, args, phase, ...event }) + '\n'
  );
record({ event: 'start' });
const emit = (value: unknown) => console.log(JSON.stringify(value));
const sources = ['opencode', 'opencode-zen', 'agentrouter', 'openrouter'];
function status(providerId: CliProviderId): CliProviderStatus {
  const failed = providerId === 'opencode' && scoped && phase !== 'healthy';
  const capability = { status: 'supported' as const, ownership: 'shared' as const, reason: null };
  const recovered = providerId === 'opencode' && scoped && phase === 'healthy';
  const models: NonNullable<CliProviderStatus['modelCatalog']>['models'] = sources.map(
    (source) => ({
      id: `${source}/recovery-model`,
      launchModel: `${source}/recovery-model`,
      displayName: 'recovery-model',
      hidden: false,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      inputModalities: ['text'],
      supportsPersonality: false,
      isDefault: source === 'openrouter',
      upgrade: false,
      source: 'app-server',
      metadata: {
        free: true,
        opencode: {
          providerId: source,
          modelId: 'recovery-model',
          sourceLabel: source,
          accessKind: 'verified',
          routeKind: 'connected_provider',
          proofState: 'verified',
          requiresExecutionProof: false,
          reason: null,
        },
      },
    })
  );
  return {
    providerId,
    displayName: providerId,
    supported: !failed,
    authenticated: !failed,
    authMethod: failed ? null : 'api-key',
    verificationState: failed ? 'error' : 'verified',
    statusCheckOutcome: failed ? 'transient_error' : 'authoritative',
    ...(failed ? { statusCheckErrorCode: 'unavailable' as const } : {}),
    canLoginFromUi: false,
    statusMessage: failed ? 'Runtime temporarily unavailable' : 'Sandbox ready',
    detailMessage: failed ? 'Controlled transient status failure' : null,
    models: recovered ? models.map((model) => model.launchModel) : [],
    modelVerificationState: recovered ? 'verified' : 'idle',
    modelCatalog: recovered
      ? {
          schemaVersion: 1,
          providerId,
          source: 'app-server',
          status: 'ready',
          fetchedAt: new Date().toISOString(),
          staleAt: new Date(Date.now() + 60_000).toISOString(),
          defaultModelId: 'openrouter/recovery-model',
          defaultLaunchModel: 'openrouter/recovery-model',
          models,
          diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
        }
      : null,
    modelCatalogRefreshState: recovered ? 'ready' : 'idle',
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    backend: null,
    capabilities: {
      teamLaunch: !failed,
      oneShot: !failed,
      extensions: { plugins: capability, mcp: capability, skills: capability, apiKeys: capability },
    },
  };
}
if (args.join(' ') === '--version') {
  console.log(role === 'opencode' ? '1.18.29' : '2.777.777 (Claude Code)');
} else if (role === 'orchestrator' && args[0] === 'auth' && args[1] === 'status') {
  emit({ loggedIn: true, authMethod: 'api-key' });
} else if (role === 'orchestrator' && args[0] === 'runtime' && args[1] === 'status') {
  assert(
    args
      .slice(2)
      .every(
        (arg, i, flags) =>
          [
            '--json',
            '--summary',
            '--provider',
            'anthropic',
            'opencode',
            'codex',
            'gemini',
          ].includes(arg) &&
          (arg !== '--provider' || Boolean(flags[i + 1]))
      )
  );
  const providers = ['anthropic', 'opencode', 'codex', 'gemini'] as const;
  record({ event: 'status-response', scoped });
  emit({ providers: Object.fromEntries(providers.map((id) => [id, status(id)])) });
} else if (
  role === 'orchestrator' &&
  args.slice(0, 3).join(' ') === 'runtime providers directory'
) {
  emit({
    schemaVersion: 1,
    runtimeId: 'opencode',
    directory: {
      runtimeId: 'opencode',
      totalCount: sources.length,
      returnedCount: sources.length,
      query: null,
      filter: 'all',
      limit: 100,
      cursor: null,
      nextCursor: null,
      fetchedAt: new Date().toISOString(),
      diagnostics: [],
      entries: sources.map((providerId) => ({
        providerId,
        displayName: providerId === 'opencode-zen' ? 'OpenCode Zen' : providerId,
        state: 'connected',
        setupKind: 'connect-api-key',
        ownership: [],
        recommended: false,
        modelCount: 1,
        authMethods: [],
        defaultModelId: null,
        sources: ['opencode-provider'],
        sourceLabel: null,
        providerSource: null,
        detail: null,
        actions: [],
        metadata: {
          hasKnownModels: true,
          requiresManualConfig: false,
          supportedInlineAuth: true,
          configuredAuthless: false,
        },
      })),
    },
  });
} else if (role === 'orchestrator' && args.slice(0, 3).join(' ') === 'runtime providers models') {
  const source = args[args.indexOf('--provider') + 1];
  assert(source && sources.includes(source));
  const failed = phase === 'broken' && ['opencode', 'opencode-zen'].includes(source);
  record({ event: 'models-response', source, failed, scoped });
  if (failed) {
    emit({
      schemaVersion: 1,
      runtimeId: 'opencode',
      error: {
        code: 'provider-missing',
        recoverable: true,
        message: 'OpenCode provider opencode-zen was not found in the live catalog',
      },
    });
    process.exitCode = 1;
  } else {
    emit({
      schemaVersion: 1,
      runtimeId: 'opencode',
      models: {
        runtimeId: 'opencode',
        providerId: source,
        defaultModelId: null,
        diagnostics: [],
        catalogState: 'fresh',
        totalCount: 1,
        returnedCount: 1,
        cursor: null,
        nextCursor: null,
        models: [
          {
            modelId: 'recovery-model',
            providerId: source,
            displayName: `Recovery ${source} model`,
            sourceLabel: source,
            free: true,
            default: false,
            availability: 'available',
            accessKind: 'credentialed',
            routeKind: 'connected_provider',
            proofState: 'not_required',
            requiresExecutionProof: false,
            reason: null,
          },
        ],
      },
    });
  }
} else if (role === 'orchestrator' && args.slice(0, 2).join(' ') === 'runtime opencode-command') {
  const input = args[args.indexOf('--input') + 1];
  const directory = path.join(root, 'tmp/claude-team-opencode-bridge');
  assert(
    input && path.dirname(input) === directory && realpathSync(path.dirname(input)) === directory
  );
  const request = JSON.parse(readFileSync(input, 'utf8')) as {
    requestId: string;
    command: string;
    body: { projectPath: string; selectedModel: string | null };
  };
  assert.equal(request.command, 'opencode.readiness', 'Refuse state-changing bridge commands');
  assert.equal(request.body.projectPath, project, 'Only the disposable project may be checked');
  record({ event: 'readiness-response', model: request.body.selectedModel });
  const ready = phase === 'healthy';
  const data: OpenCodeTeamLaunchReadiness = {
    state: ready ? 'ready' : 'unknown_error',
    launchAllowed: ready,
    modelId: request.body.selectedModel,
    availableModels: sources.map((source) => `${source}/recovery-model`),
    opencodeVersion: '1.18.29',
    installMethod: 'manual',
    binaryPath: path.join(root, 'bin/opencode'),
    hostHealthy: ready,
    appMcpConnected: ready,
    requiredToolsPresent: ready,
    permissionBridgeReady: ready,
    runtimeStoresReady: ready,
    supportLevel: null,
    missing: ready ? [] : ['Controlled transient status failure'],
    diagnostics: [],
    evidence: {
      capabilitiesReady: ready,
      mcpToolProofRoute: null,
      observedMcpTools: [],
      runtimeStoreReadinessReason: null,
    },
  };
  const response = {
    ok: true,
    schemaVersion: 1,
    requestId: request.requestId,
    command: request.command,
    completedAt: new Date().toISOString(),
    durationMs: 1,
    runtime: {
      providerId: 'opencode',
      binaryPath: path.join(root, 'bin/opencode'),
      binaryFingerprint: 'sandbox-fixture',
      version: '1.18.29',
      capabilitySnapshotId: 'sandbox-fixture',
    },
    diagnostics: [],
    data,
  };
  if (args.includes('--output')) {
    const output = args[args.indexOf('--output') + 1];
    assert.equal(output, input + '.output.json');
    writeFileSync(output, JSON.stringify(response), { flag: 'wx' });
  }
  emit(response);
} else if (
  role === 'orchestrator' &&
  args.slice(0, 3).join(' ') === 'runtime local-providers list'
) {
  emit({ schemaVersion: 1, runtimeId: 'opencode', providers: [] });
} else if (
  role === 'orchestrator' &&
  args.slice(0, 3).join(' ') === 'runtime local-providers scan'
) {
  emit({ schemaVersion: 1, runtimeId: 'opencode', probes: [] });
} else {
  // Fail closed on provisioning, agent startup, authentication writes and model execution.
  record({ event: 'refused' });
  console.error(`Read-only fixture refused: ${role} ${args.join(' ')}`);
  process.exitCode = 64;
}
