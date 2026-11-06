import { getMcpProjectStateKey } from '@shared/utils/extensionNormalizers';

import type { ExtensionsSlice } from '../slices/extensionsSlice';
import type { AppState } from '../types';
import type {
  EnrichedPlugin,
  ExtensionOperationState,
  InstallScope,
} from '@shared/types/extensions';
import type { StateCreator } from 'zustand';

const pluginSuccessResetTimers = new Map<string, ReturnType<typeof setTimeout>>();
const mcpSuccessResetTimers = new Map<string, ReturnType<typeof setTimeout>>();
const SUCCESS_DISPLAY_MS = 2_000;

export function buildPluginIdSet(catalog: EnrichedPlugin[]): Set<string> {
  return new Set(catalog.map((plugin) => plugin.pluginId));
}

function isPluginOperationKeyForPlugin(operationKey: string, pluginId: string): boolean {
  return operationKey.startsWith(`plugin:${pluginId}:`);
}

export function clearPluginOperationState(
  pluginIds: Set<string>,
  pluginInstallProgress: Record<string, ExtensionOperationState>,
  installErrors: Record<string, string>
): {
  pluginInstallProgress: Record<string, ExtensionOperationState>;
  installErrors: Record<string, string>;
} {
  if (pluginIds.size === 0) {
    return { pluginInstallProgress, installErrors };
  }

  const nextPluginInstallProgress = { ...pluginInstallProgress };
  const nextInstallErrors = { ...installErrors };
  const pluginIdsList = Array.from(pluginIds);

  for (const operationKey of Object.keys(nextPluginInstallProgress)) {
    if (pluginIdsList.some((pluginId) => isPluginOperationKeyForPlugin(operationKey, pluginId))) {
      delete nextPluginInstallProgress[operationKey];
    }
  }

  for (const operationKey of Object.keys(nextInstallErrors)) {
    if (pluginIdsList.some((pluginId) => isPluginOperationKeyForPlugin(operationKey, pluginId))) {
      delete nextInstallErrors[operationKey];
    }
  }

  return {
    pluginInstallProgress: nextPluginInstallProgress,
    installErrors: nextInstallErrors,
  };
}

export function clearPluginSuccessResetTimer(operationKey: string): void {
  const timer = pluginSuccessResetTimers.get(operationKey);
  if (!timer) {
    return;
  }

  clearTimeout(timer);
  pluginSuccessResetTimers.delete(operationKey);
}

export function clearPluginSuccessResetTimers(pluginIds: Set<string>): void {
  const pluginIdsList = Array.from(pluginIds);
  for (const operationKey of Array.from(pluginSuccessResetTimers.keys())) {
    if (pluginIdsList.some((pluginId) => isPluginOperationKeyForPlugin(operationKey, pluginId))) {
      clearPluginSuccessResetTimer(operationKey);
    }
  }
}

export function schedulePluginSuccessReset(
  operationKey: string,
  set: Parameters<StateCreator<AppState, [], [], ExtensionsSlice>>[0]
): void {
  clearPluginSuccessResetTimer(operationKey);
  const timer = setTimeout(() => {
    pluginSuccessResetTimers.delete(operationKey);
    set((prev) => {
      if (prev.pluginInstallProgress[operationKey] !== 'success') {
        return {};
      }

      return {
        pluginInstallProgress: { ...prev.pluginInstallProgress, [operationKey]: 'idle' },
      };
    });
  }, SUCCESS_DISPLAY_MS);
  pluginSuccessResetTimers.set(operationKey, timer);
}

export function getCustomMcpOperationKey(
  serverName: string,
  scope: InstallScope,
  projectPath?: string | null
): string {
  if (scope === 'project' || scope === 'local') {
    return `mcp-custom:${serverName}:${scope}:${getMcpProjectStateKey(projectPath)}`;
  }
  return `mcp-custom:${serverName}:${scope}`;
}

function isProjectScopedMcpOperationKey(operationKey: string): boolean {
  return (
    operationKey.includes(':project:') ||
    operationKey.endsWith(':project') ||
    operationKey.includes(':local:') ||
    operationKey.endsWith(':local')
  );
}

export function clearMcpSuccessResetTimer(operationKey: string): void {
  const timer = mcpSuccessResetTimers.get(operationKey);
  if (!timer) {
    return;
  }

  clearTimeout(timer);
  mcpSuccessResetTimers.delete(operationKey);
}

export function scheduleMcpSuccessReset(
  operationKey: string,
  set: Parameters<StateCreator<AppState, [], [], ExtensionsSlice>>[0]
): void {
  clearMcpSuccessResetTimer(operationKey);
  const timer = setTimeout(() => {
    mcpSuccessResetTimers.delete(operationKey);
    set((prev) => {
      if (prev.mcpInstallProgress[operationKey] !== 'success') {
        return {};
      }

      return {
        mcpInstallProgress: { ...prev.mcpInstallProgress, [operationKey]: 'idle' },
      };
    });
  }, SUCCESS_DISPLAY_MS);
  mcpSuccessResetTimers.set(operationKey, timer);
}

export function clearMcpProjectScopedOperationState(
  mcpInstallProgress: Record<string, ExtensionOperationState>,
  installErrors: Record<string, string>
): {
  mcpInstallProgress: Record<string, ExtensionOperationState>;
  installErrors: Record<string, string>;
} {
  const nextMcpInstallProgress = { ...mcpInstallProgress };
  const nextInstallErrors = { ...installErrors };

  for (const operationKey of Object.keys(nextMcpInstallProgress)) {
    if (
      (operationKey.startsWith('mcp:') || operationKey.startsWith('mcp-custom:')) &&
      isProjectScopedMcpOperationKey(operationKey)
    ) {
      delete nextMcpInstallProgress[operationKey];
    }
  }

  for (const operationKey of Object.keys(nextInstallErrors)) {
    if (
      (operationKey.startsWith('mcp:') || operationKey.startsWith('mcp-custom:')) &&
      isProjectScopedMcpOperationKey(operationKey)
    ) {
      delete nextInstallErrors[operationKey];
    }
  }

  return {
    mcpInstallProgress: nextMcpInstallProgress,
    installErrors: nextInstallErrors,
  };
}

export function clearMcpProjectScopedSuccessResetTimers(): void {
  for (const operationKey of Array.from(mcpSuccessResetTimers.keys())) {
    if (isProjectScopedMcpOperationKey(operationKey)) {
      clearMcpSuccessResetTimer(operationKey);
    }
  }
}
