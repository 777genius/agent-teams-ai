import { RuntimeProviderCompanionCoordinator } from '../application/RuntimeProviderCompanionCoordinator';
import {
  AgentTeamsRuntimeProviderManagementCliClient,
  type RuntimeProviderOAuthClientDependencies,
} from '../infrastructure/AgentTeamsRuntimeProviderManagementCliClient';
import { createRuntimeProviderCompanionRegistry } from '../infrastructure/cli-companion/createRuntimeProviderCompanionRegistry';
import {
  KiroCliCompanionService,
  type KiroCliCompanionServiceDependencies,
} from '../infrastructure/KiroCliCompanionService';
import { OpenCodeLocalProviderConnector } from '../infrastructure/OpenCodeLocalProviderConnector';

import type {
  RuntimeLocalProviderConnectorPort,
  RuntimeProviderManagementPort,
} from '../../core/application';
import type { RuntimeProviderCompanionRegistry } from '../infrastructure/cli-companion/types';
import type {
  RuntimeLocalProviderConfigureInput,
  RuntimeLocalProviderConfigureResponse,
  RuntimeLocalProviderListInput,
  RuntimeLocalProviderListResponse,
  RuntimeLocalProviderProbeInput,
  RuntimeLocalProviderProbeResponse,
  RuntimeLocalProviderScanInput,
  RuntimeLocalProviderScanResponse,
  RuntimeProviderCompanionInput,
  RuntimeProviderCompanionStatusDto,
  RuntimeProviderManagementApi,
  RuntimeProviderManagementCancelOAuthInput,
  RuntimeProviderManagementConfigureModelLimitsInput,
  RuntimeProviderManagementConnectApiKeyInput,
  RuntimeProviderManagementConnectInput,
  RuntimeProviderManagementDirectoryResponse,
  RuntimeProviderManagementForgetInput,
  RuntimeProviderManagementLoadDirectoryInput,
  RuntimeProviderManagementLoadModelsInput,
  RuntimeProviderManagementLoadSetupFormInput,
  RuntimeProviderManagementLoadViewInput,
  RuntimeProviderManagementModelLimitsResponse,
  RuntimeProviderManagementModelsResponse,
  RuntimeProviderManagementModelTestResponse,
  RuntimeProviderManagementOAuthControlResponse,
  RuntimeProviderManagementProviderResponse,
  RuntimeProviderManagementSetDefaultModelInput,
  RuntimeProviderManagementSetupFormResponse,
  RuntimeProviderManagementSubmitOAuthCodeInput,
  RuntimeProviderManagementTestModelInput,
  RuntimeProviderManagementViewResponse,
  RuntimeProviderOAuthProgressDto,
} from '@features/runtime-provider-management/contracts';

export type RuntimeProviderManagementFeatureFacade = RuntimeProviderManagementApi;

export function createRuntimeProviderManagementFeature(
  deps: {
    port?: RuntimeProviderManagementPort;
    localProviderConnector?: RuntimeLocalProviderConnectorPort;
    companionRegistry?: RuntimeProviderCompanionRegistry;
    /** @deprecated Use companionRegistry. Kept for focused tests and packaged integrations. */
    companionService?: KiroCliCompanionService;
  } & RuntimeProviderOAuthClientDependencies &
    Pick<KiroCliCompanionServiceDependencies, 'emitProgress'> = {}
): RuntimeProviderManagementFeatureFacade {
  const port = deps.port ?? new AgentTeamsRuntimeProviderManagementCliClient(deps);
  const localProviderConnector =
    deps.localProviderConnector ?? new OpenCodeLocalProviderConnector();
  const companionRegistry =
    deps.companionRegistry ??
    (() => {
      const defaultRegistry = createRuntimeProviderCompanionRegistry({
        emitProgress: deps.emitProgress,
      });
      return deps.companionService
        ? new Map(defaultRegistry).set('kiro-cli', {
            service: deps.companionService,
            verification: { providerId: 'kiro', modelId: 'kiro/auto' },
          })
        : defaultRegistry;
    })();
  const companionCoordinator = new RuntimeProviderCompanionCoordinator(port, companionRegistry);

  return {
    listLocalProviders: (
      input: RuntimeLocalProviderListInput
    ): Promise<RuntimeLocalProviderListResponse> =>
      localProviderConnector.listLocalProviders(input),
    scanLocalProviders: (
      input: RuntimeLocalProviderScanInput
    ): Promise<RuntimeLocalProviderScanResponse> =>
      localProviderConnector.scanLocalProviders(input),
    probeLocalProvider: (
      input: RuntimeLocalProviderProbeInput
    ): Promise<RuntimeLocalProviderProbeResponse> =>
      localProviderConnector.probeLocalProvider(input),
    configureLocalProvider: (
      input: RuntimeLocalProviderConfigureInput
    ): Promise<RuntimeLocalProviderConfigureResponse> =>
      localProviderConnector.configureLocalProvider(input),
    getCompanionStatus: async (
      input: RuntimeProviderCompanionInput
    ): Promise<RuntimeProviderCompanionStatusDto> => {
      return companionCoordinator.getStatus(input);
    },
    installAndConnectCompanion: async (
      input: RuntimeProviderCompanionInput
    ): Promise<RuntimeProviderCompanionStatusDto> => {
      return companionCoordinator.installAndConnect(input);
    },
    connectCompanion: async (
      input: RuntimeProviderCompanionInput
    ): Promise<RuntimeProviderCompanionStatusDto> => {
      return companionCoordinator.connect(input);
    },
    onCompanionProgress: (): (() => void) => () => {},
    loadView: (
      input: RuntimeProviderManagementLoadViewInput
    ): Promise<RuntimeProviderManagementViewResponse> => port.loadView(input),
    loadProviderDirectory: (
      input: RuntimeProviderManagementLoadDirectoryInput
    ): Promise<RuntimeProviderManagementDirectoryResponse> => port.loadProviderDirectory(input),
    loadSetupForm: (
      input: RuntimeProviderManagementLoadSetupFormInput
    ): Promise<RuntimeProviderManagementSetupFormResponse> => port.loadSetupForm(input),
    connectProvider: (
      input: RuntimeProviderManagementConnectInput
    ): Promise<RuntimeProviderManagementProviderResponse> => port.connectProvider(input),
    connectWithApiKey: (
      input: RuntimeProviderManagementConnectApiKeyInput
    ): Promise<RuntimeProviderManagementProviderResponse> => port.connectWithApiKey(input),
    forgetCredential: (
      input: RuntimeProviderManagementForgetInput
    ): Promise<RuntimeProviderManagementProviderResponse> => port.forgetCredential(input),
    loadModels: (
      input: RuntimeProviderManagementLoadModelsInput
    ): Promise<RuntimeProviderManagementModelsResponse> => port.loadModels(input),
    testModel: (
      input: RuntimeProviderManagementTestModelInput
    ): Promise<RuntimeProviderManagementModelTestResponse> => port.testModel(input),
    setDefaultModel: (
      input: RuntimeProviderManagementSetDefaultModelInput
    ): Promise<RuntimeProviderManagementViewResponse> => port.setDefaultModel(input),
    configureModelLimits: (
      input: RuntimeProviderManagementConfigureModelLimitsInput
    ): Promise<RuntimeProviderManagementModelLimitsResponse> => port.configureModelLimits(input),
    submitOAuthCode: (
      input: RuntimeProviderManagementSubmitOAuthCodeInput
    ): Promise<RuntimeProviderManagementOAuthControlResponse> => port.submitOAuthCode(input),
    cancelOAuth: (
      input: RuntimeProviderManagementCancelOAuthInput
    ): Promise<RuntimeProviderManagementOAuthControlResponse> => port.cancelOAuth(input),
    onOAuthProgress: (listener: (event: RuntimeProviderOAuthProgressDto) => void): (() => void) =>
      port.onOAuthProgress(listener),
  };
}
