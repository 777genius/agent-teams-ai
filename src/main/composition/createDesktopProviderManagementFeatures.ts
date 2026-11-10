import { createOpenCodeInputDeclarationResolver } from '@features/runtime-provider-management';
import {
  RUNTIME_PROVIDER_COMPANION_PROGRESS,
  RUNTIME_PROVIDER_MANAGEMENT_OAUTH_PROGRESS,
  type RuntimeProviderOAuthProgressDto,
} from '@features/runtime-provider-management/contracts';
import { createRuntimeProviderManagementFeature } from '@features/runtime-provider-management/main';
import { composeGatewayProviderRuntime } from '@main/services/gateway/composeGatewayProviderRuntime';
import { getOpenCodeRuntimeResolverCacheGeneration } from '@main/services/infrastructure/openCodeRuntimeResolverCache';
import { safeSendToRenderer } from '@main/utils/safeWebContentsSend';
import { type BrowserWindow, shell } from 'electron';

import { getDesktopProviderManagementPort } from '../ipc/agentBackend';

/** Compose gateway and captured provider ports once before provisioning resolves model declarations. */
export function createDesktopProviderManagementFeatures(
  deps: Parameters<typeof composeGatewayProviderRuntime>[0] & {
    getMainWindow(): BrowserWindow | null;
    readOpenCodeDiagnosticStatus?: NonNullable<
      Parameters<typeof createRuntimeProviderManagementFeature>[0]
    >['readOpenCodeDiagnosticStatus'];
  }
) {
  const { gatewayProviderRuntime, gatewayProviderConnector, gatewayLaunchRuntime } =
    composeGatewayProviderRuntime(deps);
  const oauth = {
    openExternal: async (url: string) => {
      await shell.openExternal(url);
    },
    emitOAuthProgress: (event: RuntimeProviderOAuthProgressDto) => {
      safeSendToRenderer(deps.getMainWindow(), RUNTIME_PROVIDER_MANAGEMENT_OAUTH_PROGRESS, event);
    },
  };
  const runtimeProviderManagementFeature = createRuntimeProviderManagementFeature({
    ...oauth,
    readOpenCodeDiagnosticStatus: deps.readOpenCodeDiagnosticStatus,
    getOpenCodeRuntimeGeneration: getOpenCodeRuntimeResolverCacheGeneration,
    localProviderConnector: gatewayProviderConnector,
    port: getDesktopProviderManagementPort({
      openExternal: oauth.openExternal,
      emitProgress: oauth.emitOAuthProgress,
    }),
    emitProgress: (event) => {
      safeSendToRenderer(deps.getMainWindow(), RUNTIME_PROVIDER_COMPANION_PROGRESS, event);
    },
  });
  return {
    gatewayProviderRuntime,
    gatewayLaunchRuntime,
    runtimeProviderManagementFeature,
    resolveOpenCodeInputDeclaration: createOpenCodeInputDeclarationResolver(
      runtimeProviderManagementFeature.loadModels
    ),
  };
}
