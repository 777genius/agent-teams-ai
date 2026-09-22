import { useWorkspaceTrustStatus } from '@features/workspace-trust/renderer';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';

export function useWorkspaceTrustShellStatus(input: {
  enabled: boolean;
  projectPath: string | null;
  providerIds: readonly string[];
}) {
  const localReadAllowed = useStore(
    (state) =>
      (!state.activeContextId || state.activeContextId === 'local') &&
      !state.isContextSwitching &&
      state.connectionMode !== 'ssh'
  );
  const sourceKey = useStore((state) =>
    JSON.stringify([
      state.activeContextId,
      state.isContextSwitching,
      state.targetContextId,
      state.connectionMode,
      state.connectionState,
      state.connectedHost,
      state.appConfig?.general?.claudeRootPath,
    ])
  );

  return useWorkspaceTrustStatus(input, {
    localReadAllowed,
    sourceKey,
    transport: api.workspaceTrust,
  });
}
