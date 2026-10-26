import { RuntimeProviderCompanionCoordinator } from '../application/RuntimeProviderCompanionCoordinator';
import {
  AgentTeamsRuntimeProviderManagementCliClient,
  type RuntimeProviderCliClientDependencies,
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
  RuntimeProviderManagementRequestScope,
  ScopedRuntimeProviderManagementMethod,
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
  RuntimeProviderCompanionActionInput,
  RuntimeProviderCompanionInput,
  RuntimeProviderCompanionStatusDto,
  RuntimeProviderManagementApi,
  RuntimeProviderManagementCancelModelLoadInput,
  RuntimeProviderManagementCancelModelTestInput,
  RuntimeProviderManagementCancelOAuthInput,
  RuntimeProviderManagementClearProjectDefaultInput,
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
  RuntimeProviderManagementModelTestControlResponse,
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

export type RuntimeProviderManagementFeatureFacade = Omit<
  RuntimeProviderManagementApi,
  ScopedRuntimeProviderManagementMethod
> &
  Pick<RuntimeProviderManagementPort, ScopedRuntimeProviderManagementMethod> & {
    shutdown(): Promise<void>;
  };

export function createRuntimeProviderManagementFeature(
  deps: {
    port?: RuntimeProviderManagementPort;
    localProviderConnector?: RuntimeLocalProviderConnectorPort;
    companionRegistry?: RuntimeProviderCompanionRegistry;
    /** @deprecated Use companionRegistry. Kept for focused tests and packaged integrations. */
    companionService?: KiroCliCompanionService;
  } & RuntimeProviderCliClientDependencies &
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
    shutdown: () => port.shutdown?.() ?? Promise.resolve(),
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
    runCompanionAction: async (
      input: RuntimeProviderCompanionActionInput
    ): Promise<RuntimeProviderCompanionStatusDto> => companionCoordinator.runAction(input),
    onCompanionProgress: (): (() => void) => () => {},
    loadView: (
      input: RuntimeProviderManagementLoadViewInput,
      scope?: RuntimeProviderManagementRequestScope
    ): Promise<RuntimeProviderManagementViewResponse> => port.loadView(input, scope),
    loadProviderDirectory: (
      input: RuntimeProviderManagementLoadDirectoryInput,
      scope?: RuntimeProviderManagementRequestScope
    ): Promise<RuntimeProviderManagementDirectoryResponse> =>
      port.loadProviderDirectory(input, scope),
    loadSetupForm: (
      input: RuntimeProviderManagementLoadSetupFormInput,
      scope?: RuntimeProviderManagementRequestScope
    ): Promise<RuntimeProviderManagementSetupFormResponse> => port.loadSetupForm(input, scope),
    connectProvider: (
      input: RuntimeProviderManagementConnectInput,
      scope?: RuntimeProviderManagementRequestScope
    ): Promise<RuntimeProviderManagementProviderResponse> => port.connectProvider(input, scope),
    connectWithApiKey: (
      input: RuntimeProviderManagementConnectApiKeyInput
    ): Promise<RuntimeProviderManagementProviderResponse> => port.connectWithApiKey(input),
    forgetCredential: (
      input: RuntimeProviderManagementForgetInput,
      scope?: RuntimeProviderManagementRequestScope
    ): Promise<RuntimeProviderManagementProviderResponse> => port.forgetCredential(input, scope),
    loadModels: (
      input: RuntimeProviderManagementLoadModelsInput
    ): Promise<RuntimeProviderManagementModelsResponse> => port.loadModels(input),
    cancelModelLoad: (
      input: RuntimeProviderManagementCancelModelLoadInput
    ): Promise<RuntimeProviderManagementModelTestControlResponse> => port.cancelModelLoad(input),
    testModel: (
      input: RuntimeProviderManagementTestModelInput
    ): Promise<RuntimeProviderManagementModelTestResponse> => port.testModel(input),
    cancelModelTest: (
      input: RuntimeProviderManagementCancelModelTestInput
    ): Promise<RuntimeProviderManagementModelTestControlResponse> => port.cancelModelTest(input),
    setDefaultModel: (
      input: RuntimeProviderManagementSetDefaultModelInput
    ): Promise<RuntimeProviderManagementViewResponse> => port.setDefaultModel(input),
    clearProjectDefaultModel: (
      input: RuntimeProviderManagementClearProjectDefaultInput
    ): Promise<RuntimeProviderManagementViewResponse> => port.clearProjectDefaultModel(input),
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
