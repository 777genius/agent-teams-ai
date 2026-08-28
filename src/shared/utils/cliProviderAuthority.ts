import type {
  CliProviderModelCatalogItem,
  CliProviderStatus,
  CliProviderStatusAuthorityScope,
} from '@shared/types/cliInstaller';

/** Cross-process, host-independent lexical key for an absolute project path. */
export function normalizeCliProviderAuthorityProjectPath(projectPath: string): string {
  const raw = projectPath.trim();
  const windowsUnc = raw.startsWith('\\\\');
  const value = raw.replace(/\\/g, '/');
  const windowsDrive = /^[a-zA-Z]:\//u.test(value);
  const posix = value.startsWith('/') && !windowsUnc;
  if (!windowsDrive && !windowsUnc && !posix) {
    throw new Error('Provider authority project path must be absolute');
  }

  let prefix: string;
  let remainder: string;
  if (windowsUnc) {
    const rootComponents = value.slice(2).split('/').filter(Boolean).slice(0, 2);
    if (
      rootComponents.length !== 2 ||
      rootComponents.some((component) => component === '.' || component === '..')
    ) {
      throw new Error('Provider authority UNC path must include a server and share');
    }
    prefix = `\\\\${rootComponents.join('\\')}`;
    remainder = value.slice(2).split('/').filter(Boolean).slice(2).join('/');
  } else if (windowsDrive) {
    prefix = `${value.slice(0, 2)}/`;
    remainder = value.slice(3);
  } else {
    prefix = '/';
    remainder = value.replace(/^\/+/u, '');
  }

  const components: string[] = [];
  for (const component of remainder.split('/')) {
    if (!component || component === '.') continue;
    if (component === '..') {
      if (components.length > 0) components.pop();
      continue;
    }
    components.push(component);
  }
  if (windowsUnc) {
    const separator = components.length > 0 ? '\\' : '';
    return `${prefix}${separator}${components.join('\\')}`.toLowerCase();
  }
  const separator = components.length > 0 && !prefix.endsWith('/') ? '/' : '';
  const normalized = `${prefix}${separator}${components.join('/')}`;
  return windowsDrive ? normalized.toLowerCase() : normalized;
}

export function isCliProviderAuthorityProjectRoot(projectPath: string): boolean {
  const normalized = normalizeCliProviderAuthorityProjectPath(projectPath);
  return (
    normalized === '/' || /^[a-z]:\/$/u.test(normalized) || /^\\\\[^\\]+\\[^\\]+$/u.test(normalized)
  );
}

function sortByJson<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
}

function normalizeCatalogModel(model: CliProviderModelCatalogItem): unknown {
  return {
    id: model.id,
    launchModel: model.launchModel,
    hidden: model.hidden,
    supportedReasoningEfforts: [...model.supportedReasoningEfforts].sort(),
    defaultReasoningEffort: model.defaultReasoningEffort,
    supportsFastMode: model.supportsFastMode ?? null,
    inputModalities: [...model.inputModalities].sort(),
    supportsPersonality: model.supportsPersonality,
    isDefault: model.isDefault,
    upgrade: model.upgrade,
    source: model.source,
    opencode: model.metadata?.opencode
      ? {
          providerId: model.metadata.opencode.providerId,
          modelId: model.metadata.opencode.modelId,
          accessKind: model.metadata.opencode.accessKind,
          routeKind: model.metadata.opencode.routeKind,
          proofState: model.metadata.opencode.proofState,
          requiresExecutionProof: model.metadata.opencode.requiresExecutionProof,
        }
      : null,
  };
}

/**
 * Global provider profile/auth/config semantics that can change whether a
 * provider may launch. Presentation, diagnostics, polling state and rate-limit
 * snapshots are intentionally excluded.
 */
export function getCliProviderProfileAuthorityFingerprint(status: CliProviderStatus): string {
  const connection = status.connection;
  return JSON.stringify({
    providerId: status.providerId,
    supported: status.supported,
    authenticated: status.authenticated,
    authMethod: status.authMethod,
    teamLaunch: status.capabilities.teamLaunch,
    selectedBackendId: status.selectedBackendId ?? null,
    resolvedBackendId: status.resolvedBackendId ?? null,
    backend: status.backend
      ? {
          kind: status.backend.kind,
          projectId: status.backend.projectId ?? null,
          authMethodDetail: status.backend.authMethodDetail ?? null,
        }
      : null,
    availableBackends: sortByJson(
      (status.availableBackends ?? []).map((backend) => ({
        id: backend.id,
        selectable: backend.selectable,
        available: backend.available,
        state: backend.state ?? null,
      }))
    ),
    connection: connection
      ? {
          configuredAuthMode: connection.configuredAuthMode,
          apiKeyConfigured: connection.apiKeyConfigured,
          apiKeySource: connection.apiKeySource,
          compatibleEndpoint: connection.compatibleEndpoint
            ? {
                enabled: connection.compatibleEndpoint.enabled,
                baseUrl: connection.compatibleEndpoint.baseUrl,
                tokenConfigured: connection.compatibleEndpoint.tokenConfigured,
                tokenSource: connection.compatibleEndpoint.tokenSource,
              }
            : null,
          codex: connection.codex
            ? {
                preferredAuthMode: connection.codex.preferredAuthMode,
                effectiveAuthMode: connection.codex.effectiveAuthMode,
                requiresOpenaiAuth: connection.codex.requiresOpenaiAuth,
                launchAllowed: connection.codex.launchAllowed,
                launchReadinessState: connection.codex.launchReadinessState,
                customProvider: connection.codex.customProvider
                  ? {
                      enabled: connection.codex.customProvider.enabled,
                      active: connection.codex.customProvider.active,
                      baseUrl: connection.codex.customProvider.baseUrl,
                      model: connection.codex.customProvider.model,
                    }
                  : null,
              }
            : null,
        }
      : null,
  });
}

/** Exact project+provider model/config semantics consumed by launch checks. */
export function getCliProviderCatalogAuthorityFingerprint(status: CliProviderStatus): string {
  return JSON.stringify({
    providerId: status.providerId,
    models: [...status.models].sort(),
    modelAvailability: sortByJson(
      (status.modelAvailability ?? []).map((availability) => ({
        modelId: availability.modelId,
        status: availability.status,
      }))
    ),
    modelCatalog: status.modelCatalog
      ? {
          schemaVersion: status.modelCatalog.schemaVersion,
          providerId: status.modelCatalog.providerId,
          source: status.modelCatalog.source,
          status: status.modelCatalog.status,
          defaultModelId: status.modelCatalog.defaultModelId,
          defaultLaunchModel: status.modelCatalog.defaultLaunchModel,
          models: sortByJson(status.modelCatalog.models.map(normalizeCatalogModel)),
        }
      : null,
    runtimeCapabilities: status.runtimeCapabilities ?? null,
  });
}

export function cliProviderAuthorityScopesEqual(
  left: CliProviderStatusAuthorityScope,
  right: CliProviderStatusAuthorityScope
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.providerId === right.providerId &&
    left.projectPath === right.projectPath &&
    left.globalGeneration === right.globalGeneration &&
    left.profileGeneration === right.profileGeneration &&
    left.catalogGeneration === right.catalogGeneration
  );
}
