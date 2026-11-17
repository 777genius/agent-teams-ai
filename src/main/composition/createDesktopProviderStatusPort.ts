import { getLatestQualifiedOpenCodeV2Version } from '@features/opencode-compatibility';
import { createCapturedRuntimeProviderStatusClient } from '@features/runtime-provider-management/main';
import { getOpenCodeRuntimePlatformCandidates } from '@main/services/infrastructure/OpenCodeRuntimeInstallerService';
import { resolveLatestOpenCodeVersion } from '@main/services/infrastructure/openCodeRuntimeLatestVersion';

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
    resolveLatestOpenCodeVersion: (version) =>
      resolveLatestOpenCodeVersion(version, getOpenCodeRuntimePlatformCandidates()),
    qualifiedOpenCodeV2Version: getLatestQualifiedOpenCodeV2Version(process.platform, process.arch),
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
