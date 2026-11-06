import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from './contextScopedRequestEpoch';

import type { AppState } from '../types';

type ExtensionSet = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;

/** One original store action; stale completions cannot write or start follow-up reads in a new context. */
export function captureExtensionsContext(setStore: ExtensionSet, getStore: () => AppState) {
  const epoch = captureContextScopedRequestEpoch();
  const current = () => isContextScopedRequestEpochCurrent(epoch) && !getStore().isContextSwitching;
  if (!current()) throw new Error('Extensions context changed');
  return {
    isCurrent: current,
    set: (partial: Parameters<ExtensionSet>[0]) => {
      if (current()) setStore(partial);
    },
    get: () => {
      if (!current()) throw new Error('Extensions context changed');
      return getStore();
    },
  };
}

/** Extension inventories are owner/context data, never restored from another context snapshot. */
export function extensionInitialState(): Pick<
  AppState,
  | 'pluginCatalog'
  | 'pluginCatalogLoading'
  | 'pluginCatalogError'
  | 'pluginCatalogProjectPath'
  | 'pluginReadmes'
  | 'pluginReadmeLoading'
  | 'mcpBrowseCatalog'
  | 'mcpBrowseNextCursor'
  | 'mcpBrowseLoading'
  | 'mcpBrowseError'
  | 'mcpInstalledServers'
  | 'mcpInstalledServersByProjectPath'
  | 'mcpInstalledProjectPath'
  | 'mcpDiagnostics'
  | 'mcpDiagnosticsByProjectPath'
  | 'mcpDiagnosticsLoading'
  | 'mcpDiagnosticsLoadingByProjectPath'
  | 'mcpDiagnosticsError'
  | 'mcpDiagnosticsErrorByProjectPath'
  | 'mcpDiagnosticsLastCheckedAt'
  | 'mcpDiagnosticsLastCheckedAtByProjectPath'
  | 'pluginInstallProgress'
  | 'mcpInstallProgress'
  | 'installErrors'
  | 'apiKeys'
  | 'apiKeysLoading'
  | 'apiKeysError'
  | 'apiKeySaving'
  | 'apiKeyStorageStatus'
  | 'skillsUserCatalog'
  | 'skillsProjectCatalogByProjectPath'
  | 'skillsCatalogLoadingByProjectPath'
  | 'skillsCatalogErrorByProjectPath'
  | 'skillsLoading'
  | 'skillsError'
  | 'skillsDetailsById'
  | 'skillsDetailLoadingById'
  | 'skillsDetailErrorById'
  | 'skillsMutationLoading'
  | 'skillsMutationError'
  | 'mcpGitHubStars'
> {
  return {
    pluginCatalog: [],
    pluginCatalogLoading: false,
    pluginCatalogError: null,
    pluginCatalogProjectPath: null,
    pluginReadmes: {},
    pluginReadmeLoading: {},

    mcpBrowseCatalog: [],
    mcpBrowseNextCursor: undefined,
    mcpBrowseLoading: false,
    mcpBrowseError: null,
    mcpInstalledServers: [],
    mcpInstalledServersByProjectPath: {},
    mcpInstalledProjectPath: null,
    mcpDiagnostics: {},
    mcpDiagnosticsByProjectPath: {},
    mcpDiagnosticsLoading: false,
    mcpDiagnosticsLoadingByProjectPath: {},
    mcpDiagnosticsError: null,
    mcpDiagnosticsErrorByProjectPath: {},
    mcpDiagnosticsLastCheckedAt: null,
    mcpDiagnosticsLastCheckedAtByProjectPath: {},

    pluginInstallProgress: {},
    mcpInstallProgress: {},
    installErrors: {},

    apiKeys: [],
    apiKeysLoading: false,
    apiKeysError: null,
    apiKeySaving: false,
    apiKeyStorageStatus: null,

    skillsUserCatalog: [],
    skillsProjectCatalogByProjectPath: {},
    skillsCatalogLoadingByProjectPath: {},
    skillsCatalogErrorByProjectPath: {},
    skillsLoading: false,
    skillsError: null,
    skillsDetailsById: {},
    skillsDetailLoadingById: {},
    skillsDetailErrorById: {},
    skillsMutationLoading: false,
    skillsMutationError: null,

    mcpGitHubStars: {},
  };
}

export function getPluginCatalogKey(projectPath?: string): string {
  return `${captureContextScopedRequestEpoch()}:${projectPath ?? '__user__'}`;
}

export function getSkillsCatalogKey(projectPath?: string): string {
  return projectPath ?? '__user__';
}
