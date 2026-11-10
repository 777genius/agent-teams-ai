import { createDefaultProviderStatus } from '@main/services/runtime/providerStatusCheckContract';

import { readCapturedClaudeAuthentication } from './capturedClaudeAuthentication';
import { captureNativeExtensionSelection } from './captureNativeExtensionSelection';

import type { ClaudeMetadataSnapshot } from '@agent-teams/legacy-agent-host/management/contracts';
import type { CapturedProviderManagement } from '@features/agent-backend/main';
import type { CliProviderStatus } from '@shared/types';

const unavailable = (): never => {
  throw new Error('Native Claude metadata is unavailable');
};
function object(raw: unknown, keys: string[]): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => !keys.includes(key))
  )
    return unavailable();
  return raw as Record<string, unknown>;
}
function text(raw: unknown, max = 4096, empty = false): string {
  if (typeof raw !== 'string' || (!empty && !raw.length) || raw.length > max || raw.includes('\0'))
    return unavailable();
  return raw;
}
const optionalText = (raw: unknown): string | null => (raw === null ? null : text(raw, 256));
function decode(raw: unknown): ClaudeMetadataSnapshot {
  const reply = object(raw, ['ok', 'value']);
  if (reply.ok !== true) return unavailable();
  const value = object(reply.value, ['profileId', 'configRevision', 'account', 'models']);
  const account = object(value.account, [
    'apiProvider',
    'tokenSource',
    'apiKeySource',
    'subscriptionType',
  ]);
  if (!Array.isArray(value.models) || value.models.length > 256) return unavailable();
  const models = value.models.map((entry): ClaudeMetadataSnapshot['models'][number] => {
    const row = object(entry, [
      'modelId',
      'resolvedModel',
      'displayName',
      'description',
      'supportedEffortLevels',
      'supportsFastMode',
    ]);
    if (
      !Array.isArray(row.supportedEffortLevels) ||
      row.supportedEffortLevels.length > 5 ||
      !(row.supportsFastMode === null || typeof row.supportsFastMode === 'boolean')
    )
      return unavailable();
    const supportedEffortLevels = row.supportedEffortLevels.map((effort) => {
      const found = (['low', 'medium', 'high', 'xhigh', 'max'] as const).find(
        (item) => item === effort
      );
      return found ?? unavailable();
    });
    if (new Set(supportedEffortLevels).size !== supportedEffortLevels.length) return unavailable();
    return {
      modelId: text(row.modelId, 256),
      resolvedModel: optionalText(row.resolvedModel),
      displayName: text(row.displayName),
      description: text(row.description, 4096, true),
      supportedEffortLevels,
      supportsFastMode: row.supportsFastMode,
    };
  });
  return {
    profileId: text(value.profileId, 256),
    configRevision: text(value.configRevision, 256),
    models,
    account: {
      apiProvider: optionalText(account.apiProvider),
      tokenSource: optionalText(account.tokenSource),
      apiKeySource: optionalText(account.apiKeySource),
      subscriptionType: optionalText(account.subscriptionType),
    },
  };
}
export type CaptureClaudeMetadata = (
  projectPath: string | null
) => Promise<CapturedProviderManagement>;

/** SDK source is kept distinct from vendor API discovery and actual model execution. */
export async function readCapturedClaudeStatus(
  capture: CaptureClaudeMetadata,
  projectPath: string | null,
  now: number
) {
  const target = await capture(projectPath);
  const raw = await target.request('claude.metadata', {});
  if (Buffer.byteLength(JSON.stringify(raw)) > 256 * 1024 || !Number.isFinite(now))
    throw new Error('Native Claude metadata is unavailable');
  const value = decode(raw);
  if (
    !target.isCurrent() ||
    value.profileId !== target.profileId ||
    value.configRevision !== target.configRevision ||
    new Set(value.models.map((row) => row.modelId)).size !== value.models.length
  )
    throw new Error('Native Claude metadata is unavailable');
  // Native aliases can resolve to the same model (notably default/opus). One launch
  // value gets one option; prefer a named alias to the redundant default label.
  const rows = new Map<string, ClaudeMetadataSnapshot['models'][number]>();
  for (const row of value.models) {
    const key = row.resolvedModel ?? row.modelId;
    if (!rows.has(key) || rows.get(key)?.modelId === 'default') rows.set(key, row);
  }
  const models = [...rows.values()].map((row) => ({
    id: row.modelId,
    launchModel: row.resolvedModel ?? row.modelId,
    displayName: row.displayName,
    hidden: false,
    supportedReasoningEfforts: row.supportedEffortLevels,
    defaultReasoningEffort: null,
    ...(row.supportsFastMode === null ? {} : { supportsFastMode: row.supportsFastMode }),
    // Initialization reports no modality or default-model authority.
    inputModalities: [],
    supportsPersonality: false,
    isDefault: false,
    upgrade: false,
    source: 'claude-sdk' as const,
  }));
  const extension = {
    status: 'unsupported' as const,
    ownership: 'provider-scoped' as const,
    reason: 'Native extension management is not integrated in this status source yet.',
  };
  const authentication = await readCapturedClaudeAuthentication(target).catch(() => null);
  const nativeCapability = async (panel: 'plugins' | 'mcp') => {
    try {
      await captureNativeExtensionSelection(target, {
        panel,
        scope: projectPath ? 'project' : 'user',
      });
      return { status: 'supported' as const, ownership: 'provider-scoped' as const, reason: null };
    } catch {
      return extension;
    }
  };
  const [plugins, mcp] = await Promise.all([nativeCapability('plugins'), nativeCapability('mcp')]);
  const status: CliProviderStatus = {
    ...createDefaultProviderStatus('anthropic'),
    supported: true,
    nativeAuthManagement: 'claude',
    canLoginFromUi: authentication?.canLogin ?? false,
    authenticated: authentication?.loggedIn ?? false,
    authMethod: authentication?.loggedIn ? authentication.authMethod : null,
    // The independent native auth read can replace auth truth without proving model execution.
    verificationState: authentication === null ? 'unknown' : 'verified',
    statusCheckOutcome: authentication === null ? 'model_only' : 'authoritative',
    statusCheckErrorCode: authentication === null ? 'partial_response' : undefined,
    capabilities: {
      teamLaunch: false,
      oneShot: false,
      extensions: {
        plugins,
        mcp,
        skills: extension,
        apiKeys: { status: 'supported', ownership: 'shared', reason: null },
      },
    },
    models: models.map((row) => row.launchModel),
    modelCatalogRefreshState: 'ready',
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'anthropic',
      source: 'claude-sdk',
      status: models.length ? 'ready' : 'unavailable',
      fetchedAt: new Date(now).toISOString(),
      staleAt: new Date(now + 30000).toISOString(),
      defaultModelId: null,
      defaultLaunchModel: null,
      models,
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    },
    runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'claude-sdk' } },
    statusMessage:
      'Native Claude SDK catalog loaded. Model execution and authentication are separate checks.',
  };
  if (!target.isCurrent()) throw new Error('Native Claude status context changed');
  return { target, status };
}
