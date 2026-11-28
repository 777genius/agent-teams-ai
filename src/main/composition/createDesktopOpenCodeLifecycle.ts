import { resolveCursorAgentAttributionDirectory } from '@main/services/team/opencode/bridge/CursorAgentAttributionRecords';
import { resolveClaudeMultimodelDataDir } from '@main/services/team/opencode/bridge/OpenCodeHostStartupLockCleanup';
import { createLegacyOpenCodeMaintenanceRequirement } from '@main/services/team/opencode/bridge/OpenCodeLegacyMaintenanceCensus';
import { runOpenCodeLifecycleHostCleanup } from '@main/services/team/opencode/bridge/OpenCodeLifecycleCleanupTail';
import { buildOpenCodeAppProfileScope } from '@main/services/team/opencode/bridge/OpenCodeMcpBridgeEnv';
import { getClaudeBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';

import type { OpenCodeLifecycleCleanupTailPorts } from '@main/services/team/opencode/bridge/OpenCodeLifecycleCleanupTail';
import type { OpenCodeReadinessBridge } from '@main/services/team/opencode/bridge/OpenCodeReadinessBridge';

/** Keep the legacy census and current app ownership together around the scoped cleanup helper. */
export function createDesktopOpenCodeLifecycle(deps: {
  appStartedAtMs: number;
  managedHostInstanceId: string;
  getBridge(): Pick<OpenCodeReadinessBridge, 'cleanupOpenCodeHosts'> | null;
  getUserDataPath(): string;
  hasTrackedObligations(): boolean;
  ports: OpenCodeLifecycleCleanupTailPorts;
  logRegistryResult(message: string): void;
  releaseSharedRuntime(): Promise<void>;
}) {
  const nativeMaintenanceRequired = createLegacyOpenCodeMaintenanceRequirement(() => ({
    teamsBasePath: getTeamsBasePath(),
    multimodelDataPath: resolveClaudeMultimodelDataDir(),
    attributionPath: resolveCursorAgentAttributionDirectory(),
    hasTrackedObligations: deps.hasTrackedObligations,
  }));
  return {
    nativeMaintenanceRequired,
    async cleanup(reason: 'startup' | 'shutdown'): Promise<void> {
      const required = await nativeMaintenanceRequired();
      const bridge = required ? deps.getBridge() : null;
      await runOpenCodeLifecycleHostCleanup({
        reason,
        cleanupRegistry: bridge ? (body) => bridge.cleanupOpenCodeHosts(body) : undefined,
        registryMaintenanceSkipped: !required,
        logRegistryResult: deps.logRegistryResult,
        appStartedAtMs: deps.appStartedAtMs,
        managedHostInstanceId: deps.managedHostInstanceId,
        profileScope: buildOpenCodeAppProfileScope(deps.getUserDataPath(), getClaudeBasePath()),
        releaseSharedRuntime: deps.releaseSharedRuntime,
        ports: deps.ports,
      });
    },
  };
}
