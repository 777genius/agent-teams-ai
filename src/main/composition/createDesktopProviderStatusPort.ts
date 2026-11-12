import { createCapturedRuntimeProviderStatusClient } from '@features/runtime-provider-management/main';

import type { DesktopBackendFeature } from '@features/agent-backend/main';

/** Existing provider status composition; the shell retains sender/context authority. */
export function createDesktopProviderStatusPort(options: {
  feature: Pick<
    DesktopBackendFeature,
    'captureProviderManagement' | 'captureRuntimeSources' | 'readRuntimeHealth'
  >;
  captureSelection(): { contextId: string; isCurrent(): boolean };
  isCurrent(): boolean;
}) {
  const capture =
    (runtimeId?: 'claude' | 'codex') => (projectPath: string | null, isCurrent?: () => boolean) => {
      const context = options.captureSelection();
      return options.feature.captureProviderManagement(
        context.contextId,
        projectPath,
        { isCurrent: () => options.isCurrent() && context.isCurrent() && (isCurrent?.() ?? true) },
        runtimeId
      );
    };
  return createCapturedRuntimeProviderStatusClient({
    capture: capture(),
    captureClaude: capture('claude'),
    captureCodex: capture('codex'),
    captureSources: () => {
      const context = options.captureSelection();
      return options.feature.captureRuntimeSources(context.contextId, null, 'opencode', {
        isCurrent: () => options.isCurrent() && context.isCurrent(),
      });
    },
    captureGuard: () => {
      const context = options.captureSelection();
      return () => options.isCurrent() && context.isCurrent();
    },
    readHealth: () => {
      const context = options.captureSelection();
      return options.feature.readRuntimeHealth(context.contextId, {
        isCurrent: () => options.isCurrent() && context.isCurrent(),
      });
    },
  });
}
