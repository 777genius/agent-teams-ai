import { createHmac, randomBytes } from 'node:crypto';

import { withLatestOpenCodeVersion } from '@main/services/infrastructure/openCodeRuntimeLatestVersion';
import {
  createDefaultProviderStatus,
  createRuntimeStatusErrorProviderStatus,
} from '@main/services/runtime/providerStatusCheckContract';
import { CLI_PROVIDER_STATUS_DEFERRED_MESSAGE } from '@shared/types/cliInstaller';
import { isTeamEffortLevelForProvider } from '@shared/utils/effortLevels';

import { readCapturedClaudeStatus } from './capturedClaudeMetadata';
import { projectCapturedCodexCatalog } from './capturedCodexCatalog';
import { readCapturedCodexMetadata } from './capturedCodexMetadata';
import {
  models,
  parseManagementCatalog,
  parseManagementRuntime,
} from './capturedManagementCatalog';
import { nativeDefaultModel, selectedPreferences } from './capturedManagementPreferences';
import { createCapturedRuntimeProviderManagementClient } from './CapturedRuntimeProviderManagementClient';

import type { RuntimeProviderStatusPort } from '../../../core/application';
import type { CaptureClaudeMetadata } from './capturedClaudeMetadata';
import type { CaptureCodexMetadata } from './capturedCodexMetadata';
import type { CatalogProvider } from './capturedManagementCatalog';
import type {
  CapturedProviderManagement,
  CapturedRuntimeSources,
} from '@features/agent-backend/main';
import type {
  CliInstallationStatus,
  CliProviderId,
  CliProviderStatus,
  OpenCodeRuntimeStatus,
} from '@shared/types';

const providers: CliProviderId[] = ['anthropic', 'codex', 'opencode'];
const failure = (
  providerId: CliProviderId,
  message = 'The selected native provider status is unavailable. Refresh before retrying.'
): CliProviderStatus => ({
  ...createRuntimeStatusErrorProviderStatus(providerId, new Error(message)),
  supported: true,
});

export interface CapturedRuntimeProviderStatusDependencies {
  readHealth(): Promise<{ buildId: string }>;
  capture(
    projectPath: string | null,
    isCurrent?: () => boolean
  ): Promise<CapturedProviderManagement>;
  captureCodex?: CaptureCodexMetadata;
  captureClaude?: CaptureClaudeMetadata;
  captureSources?(): Promise<Pick<CapturedRuntimeSources, 'current'>>;
  readonly resolveLatestOpenCodeVersion?: (cliVersion: string) => Promise<string>;
  readonly qualifiedOpenCodeV2Version?: string | null;
  now?(): number;
  captureGuard?(): () => boolean;
}

const pendingExtension = () => ({
  status: 'unsupported' as const,
  ownership: 'provider-scoped' as const,
  reason: 'Native extension management is not integrated in this status source yet.',
});

function projectOpenCodeCatalog(
  rows: CatalogProvider[],
  defaultModel: string | null,
  now: number
): CliProviderStatus {
  const items = rows.flatMap((provider) =>
    models(provider).map((model, index) => ({
      id: model.modelId,
      launchModel: model.modelId,
      displayName: model.displayName,
      hidden: false,
      supportedReasoningEfforts: (provider.models[index]?.variants ?? []).filter((effort) =>
        isTeamEffortLevelForProvider(effort, 'opencode')
      ),
      defaultReasoningEffort: null,
      inputModalities: ['text'],
      supportsPersonality: false,
      isDefault: model.modelId === defaultModel,
      upgrade: false,
      source: 'app-server' as const,
      metadata: {
        context: model.catalogContextTokens,
        limits: { context: model.catalogContextTokens, output: model.catalogOutputTokens },
        free: model.free,
        opencode: {
          providerId: provider.providerId,
          modelId: model.modelId.slice(provider.providerId.length + 1),
          sourceLabel: provider.displayName,
          accessKind: provider.configuredAuthless
            ? ('configured_authless' as const)
            : provider.connected
              ? ('credentialed' as const)
              : ('not_authenticated' as const),
          routeKind: model.routeKind!,
          proofState: 'needs_probe' as const,
          requiresExecutionProof: true,
          reason: 'Native catalog metadata does not verify model execution.',
        },
      },
    }))
  );
  if (!Number.isFinite(now) || new Set(items.map((model) => model.id)).size !== items.length)
    throw new Error('Native model catalog is invalid');
  const selectedDefault = items.some((model) => model.id === defaultModel) ? defaultModel : null;
  return {
    ...createDefaultProviderStatus('opencode'),
    supported: true,
    // A connected credential or catalog row is not an authentication/execution proof.
    authenticated: false,
    capabilities: {
      teamLaunch: false,
      oneShot: false,
      extensions: {
        plugins: pendingExtension(),
        mcp: pendingExtension(),
        skills: pendingExtension(),
        apiKeys: pendingExtension(),
      },
    },
    authMethod: null,
    verificationState: 'unknown',
    statusCheckOutcome: 'model_only',
    models: items.map((model) => model.id),
    modelCatalogRefreshState: 'ready',
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'app-server',
      status: items.length ? 'ready' : 'unavailable',
      fetchedAt: new Date(now).toISOString(),
      staleAt: new Date(now + 30_000).toISOString(),
      defaultModelId: selectedDefault,
      defaultLaunchModel: selectedDefault,
      models: items,
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    },
    statusMessage: items.length
      ? 'Native model catalog loaded. Test a model to verify access.'
      : 'The selected native profile has no models.',
    detailMessage:
      'Provider authentication and model execution are separate from catalog discovery.',
    backend: { kind: 'opencode-native', label: 'OpenCode native' },
    runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
  };
}

/** Existing Desktop DTO facade over a captured native Host, with no CLI/fork fallback. */
export function createCapturedRuntimeProviderStatusClient(
  deps: CapturedRuntimeProviderStatusDependencies
): RuntimeProviderStatusPort {
  const presentationKey = randomBytes(32);
  const scopeFor = (target: CapturedProviderManagement) =>
    createHmac('sha256', presentationKey).update(target.targetId).digest('hex');
  const readOpenCode = async (projectPath: string | null) => {
    const target = await deps.capture(projectPath);
    const raw = await target.request('catalog', { includeModels: true });
    const rows = parseManagementCatalog(raw, target);
    const preferences = await selectedPreferences(target, nativeDefaultModel(raw));
    if (!target.isCurrent()) throw new Error('Native status context changed');
    return {
      target,
      status: {
        ...projectOpenCodeCatalog(
          rows,
          preferences.resolved.defaultModel,
          (deps.now ?? Date.now)()
        ),
        catalogScope: scopeFor(target),
      },
    };
  };
  const port: RuntimeProviderStatusPort = {
    async readOpenCodeRuntimeStatus() {
      const current = deps.captureGuard?.() ?? (() => true);
      const sources = await deps.captureSources?.();
      const target = await deps.capture(null);
      // The original capture may publish its first configuration before selecting the target.
      const selection = await sources?.current();
      const runtime = parseManagementRuntime(await target.request('catalog', {}), target);
      if (!target.isCurrent() || !current()) throw new Error('Native status context changed');
      if (
        selection &&
        (selection.profileId !== target.profileId ||
          selection.configRevision !== target.configRevision ||
          selection.nativeGeneration !== runtime.generation)
      )
        throw new Error('Native runtime selection changed');
      const status: OpenCodeRuntimeStatus = {
        installed: true,
        source:
          selection && selection.sourceKind !== 'captured' && selection.sourceKind !== 'bundled'
            ? selection.sourceKind
            : 'captured-host',
        state: 'ready',
        ...(selection?.cliVersion
          ? { version: selection.cliVersion }
          : runtime.generation === 'v2'
            ? { version: runtime.version }
            : {}),
        ...(runtime.generation === 'v2'
          ? {
              v2Support: 'ready' as const,
              ...(selection ? { engineVersion: runtime.version } : {}),
              ...(selection?.cliVersion && deps.qualifiedOpenCodeV2Version
                ? { compatibleV2Version: deps.qualifiedOpenCodeV2Version }
                : {}),
            }
          : {}),
        ...(selection ? { sourceRevision: selection.revision } : {}),
      };
      const cliVersion = selection?.cliVersion;
      const resolveLatest = deps.resolveLatestOpenCodeVersion;
      const result =
        cliVersion && selection?.sourceKind !== 'override' && resolveLatest
          ? await withLatestOpenCodeVersion(status, () => resolveLatest(cliVersion))
          : status;
      // Registry metadata is optional; it cannot make a replaced source current again.
      if (selection && (await sources!.current()).revision !== selection.revision)
        throw new Error('Native runtime selection changed');
      if (!target.isCurrent() || !current()) throw new Error('Native status context changed');
      return runtime.generation === 'v1' && !cliVersion ? null : result;
    },
    async getProviderStatus(providerId, options = {}) {
      const current = deps.captureGuard?.() ?? (() => true);
      if (providerId === 'anthropic' && deps.captureClaude) {
        try {
          const { target, status } = await readCapturedClaudeStatus(
            deps.captureClaude,
            options.projectPath ?? null,
            (deps.now ?? Date.now)()
          );
          if (!current()) throw new Error('Native status context changed');
          return { ...status, catalogScope: scopeFor(target) };
        } catch {
          return failure(providerId);
        }
      }
      if (providerId === 'codex' && deps.captureCodex) {
        try {
          const { target, value } = await readCapturedCodexMetadata(
            deps.captureCodex,
            options.projectPath ?? null,
            true
          );
          if (!current()) throw new Error('Native status context changed');
          const catalog = projectCapturedCodexCatalog(value, false);
          return {
            ...createDefaultProviderStatus('codex'),
            canLoginFromUi: true,
            capabilities: {
              teamLaunch: false,
              oneShot: false,
              extensions: {
                plugins: pendingExtension(),
                mcp: pendingExtension(),
                skills: pendingExtension(),
                apiKeys: pendingExtension(),
              },
            },
            runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
            supported: true,
            authenticated: false,
            statusCheckOutcome: 'model_only',
            verificationState: 'unknown',
            modelCatalogRefreshState: 'ready',
            models: catalog.models.map((model) => model.id),
            modelCatalog: catalog,
            catalogScope: scopeFor(target),
            statusMessage:
              'Native Codex catalog loaded. Account management and model execution are separate checks.',
          };
        } catch {
          return failure(providerId);
        }
      }
      if (providerId !== 'opencode')
        return failure(
          providerId,
          'This provider’s native status adapter is not integrated yet. No legacy runtime was queried.'
        );
      try {
        const result = (await readOpenCode(options.projectPath ?? null)).status;
        if (!current()) throw new Error('Native status context changed');
        return result;
      } catch {
        return failure(providerId);
      }
    },
    async getStatus(options = {}) {
      const current = deps.captureGuard?.() ?? (() => true);
      let buildId: string;
      try {
        ({ buildId } = await deps.readHealth());
      } catch {
        return installation(
          false,
          null,
          providers.map((id) => failure(id)),
          'The selected Host did not confirm readiness.'
        );
      }
      if (!current())
        return installation(
          false,
          null,
          providers.map((id) => failure(id)),
          'Native status context changed.'
        );
      const statuses =
        options.providerStatusMode === 'defer'
          ? providers.map((id) => ({
              ...createDefaultProviderStatus(id),
              statusMessage: CLI_PROVIDER_STATUS_DEFERRED_MESSAGE,
            }))
          : await Promise.all(providers.map((id) => port.getProviderStatus(id)));
      if (!current())
        return installation(
          false,
          null,
          providers.map((id) => failure(id)),
          'Native status context changed.'
        );
      return installation(true, buildId, statuses, null);
    },
    async verifyProviderModels(providerId) {
      const current = deps.captureGuard?.() ?? (() => true);
      if (providerId !== 'opencode') return port.getProviderStatus(providerId);
      try {
        const { target, status } = await readOpenCode(null);
        const modelId = status.modelCatalog?.defaultModelId;
        const model = status.modelCatalog?.models.find((item) => item.id === modelId);
        const nativeProviderId = model?.metadata?.opencode?.providerId;
        if (!modelId || !nativeProviderId)
          return {
            ...status,
            detailMessage: 'Select a default model before testing this native provider.',
          };
        const client = createCapturedRuntimeProviderManagementClient({
          capture: async () => target,
        });
        const result = await client.testModel({
          runtimeId: 'opencode',
          providerId: nativeProviderId,
          modelId,
        });
        if (!target.isCurrent() || !current()) throw new Error('Native status context changed');
        return {
          ...status,
          modelVerificationState: result.result?.ok ? 'verified' : 'idle',
          modelAvailability: [
            {
              modelId,
              status: result.result?.ok ? 'available' : 'unknown',
              reason:
                result.result?.message ??
                result.error?.message ??
                'Native model execution was not confirmed.',
            },
          ],
        };
      } catch {
        return failure(providerId);
      }
    },
  };
  return port;
}

function installation(
  installed: boolean,
  buildId: string | null,
  statuses: CliProviderStatus[],
  launchError: string | null
): CliInstallationStatus {
  return {
    // Retain the existing multi-provider UI discriminator while replacing its executor.
    flavor: 'agent_teams_orchestrator',
    displayName: 'Agent Teams Host',
    supportsSelfUpdate: false,
    showVersionDetails: false,
    showBinaryPath: false,
    installed,
    installedVersion: buildId,
    binaryPath: null,
    latestVersion: null,
    updateAvailable: false,
    launchError,
    authLoggedIn: false,
    authStatusChecking: false,
    authMethod: null,
    providers: statuses,
  };
}
