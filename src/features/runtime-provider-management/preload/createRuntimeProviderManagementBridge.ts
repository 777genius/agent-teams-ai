import {
  RUNTIME_PROVIDER_COMPANION_CONNECT,
  RUNTIME_PROVIDER_COMPANION_INSTALL,
  RUNTIME_PROVIDER_COMPANION_PROGRESS,
  RUNTIME_PROVIDER_COMPANION_STATUS,
  RUNTIME_PROVIDER_MANAGEMENT_CONNECT,
  RUNTIME_PROVIDER_MANAGEMENT_CONNECT_API_KEY,
  RUNTIME_PROVIDER_MANAGEMENT_DIRECTORY,
  RUNTIME_PROVIDER_MANAGEMENT_FORGET,
  RUNTIME_PROVIDER_MANAGEMENT_MODELS,
  RUNTIME_PROVIDER_MANAGEMENT_OAUTH_CANCEL,
  RUNTIME_PROVIDER_MANAGEMENT_OAUTH_CODE,
  RUNTIME_PROVIDER_MANAGEMENT_OAUTH_PROGRESS,
  RUNTIME_PROVIDER_MANAGEMENT_SET_DEFAULT_MODEL,
  RUNTIME_PROVIDER_MANAGEMENT_SETUP_FORM,
  RUNTIME_PROVIDER_MANAGEMENT_TEST_MODEL,
  RUNTIME_PROVIDER_MANAGEMENT_VIEW,
  type RuntimeProviderManagementApi,
} from '@features/runtime-provider-management/contracts';

import type {
  RuntimeProviderCompanionInput,
  RuntimeProviderCompanionStatusDto,
  RuntimeProviderManagementCancelOAuthInput,
  RuntimeProviderManagementConnectApiKeyInput,
  RuntimeProviderManagementConnectInput,
  RuntimeProviderManagementDirectoryResponse,
  RuntimeProviderManagementForgetInput,
  RuntimeProviderManagementLoadDirectoryInput,
  RuntimeProviderManagementLoadModelsInput,
  RuntimeProviderManagementLoadSetupFormInput,
  RuntimeProviderManagementLoadViewInput,
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
import type { IpcRenderer, IpcRendererEvent } from 'electron';

export function createRuntimeProviderManagementBridge(
  ipcRenderer: IpcRenderer
): RuntimeProviderManagementApi {
  return {
    getCompanionStatus: (
      input: RuntimeProviderCompanionInput
    ): Promise<RuntimeProviderCompanionStatusDto> =>
      ipcRenderer.invoke(RUNTIME_PROVIDER_COMPANION_STATUS, input),
    installAndConnectCompanion: (
      input: RuntimeProviderCompanionInput
    ): Promise<RuntimeProviderCompanionStatusDto> =>
      ipcRenderer.invoke(RUNTIME_PROVIDER_COMPANION_INSTALL, input),
    connectCompanion: (
      input: RuntimeProviderCompanionInput
    ): Promise<RuntimeProviderCompanionStatusDto> =>
      ipcRenderer.invoke(RUNTIME_PROVIDER_COMPANION_CONNECT, input),
    onCompanionProgress: (
      listener: (event: RuntimeProviderCompanionStatusDto) => void
    ): (() => void) => {
      const handler = (_event: IpcRendererEvent, value: RuntimeProviderCompanionStatusDto): void =>
        listener(value);
      ipcRenderer.on(RUNTIME_PROVIDER_COMPANION_PROGRESS, handler);
      return () => ipcRenderer.removeListener(RUNTIME_PROVIDER_COMPANION_PROGRESS, handler);
    },
    loadView: (
      input: RuntimeProviderManagementLoadViewInput
    ): Promise<RuntimeProviderManagementViewResponse> =>
      ipcRenderer.invoke(RUNTIME_PROVIDER_MANAGEMENT_VIEW, input),
    loadProviderDirectory: (
      input: RuntimeProviderManagementLoadDirectoryInput
    ): Promise<RuntimeProviderManagementDirectoryResponse> =>
      ipcRenderer.invoke(RUNTIME_PROVIDER_MANAGEMENT_DIRECTORY, input),
    loadSetupForm: (
      input: RuntimeProviderManagementLoadSetupFormInput
    ): Promise<RuntimeProviderManagementSetupFormResponse> =>
      ipcRenderer.invoke(RUNTIME_PROVIDER_MANAGEMENT_SETUP_FORM, input),
    connectProvider: (
      input: RuntimeProviderManagementConnectInput
    ): Promise<RuntimeProviderManagementProviderResponse> =>
      ipcRenderer.invoke(RUNTIME_PROVIDER_MANAGEMENT_CONNECT, input),
    connectWithApiKey: (
      input: RuntimeProviderManagementConnectApiKeyInput
    ): Promise<RuntimeProviderManagementProviderResponse> =>
      ipcRenderer.invoke(RUNTIME_PROVIDER_MANAGEMENT_CONNECT_API_KEY, input),
    forgetCredential: (
      input: RuntimeProviderManagementForgetInput
    ): Promise<RuntimeProviderManagementProviderResponse> =>
      ipcRenderer.invoke(RUNTIME_PROVIDER_MANAGEMENT_FORGET, input),
    loadModels: (
      input: RuntimeProviderManagementLoadModelsInput
    ): Promise<RuntimeProviderManagementModelsResponse> =>
      ipcRenderer.invoke(RUNTIME_PROVIDER_MANAGEMENT_MODELS, input),
    testModel: (
      input: RuntimeProviderManagementTestModelInput
    ): Promise<RuntimeProviderManagementModelTestResponse> =>
      ipcRenderer.invoke(RUNTIME_PROVIDER_MANAGEMENT_TEST_MODEL, input),
    setDefaultModel: (
      input: RuntimeProviderManagementSetDefaultModelInput
    ): Promise<RuntimeProviderManagementViewResponse> =>
      ipcRenderer.invoke(RUNTIME_PROVIDER_MANAGEMENT_SET_DEFAULT_MODEL, input),
    submitOAuthCode: (
      input: RuntimeProviderManagementSubmitOAuthCodeInput
    ): Promise<RuntimeProviderManagementOAuthControlResponse> =>
      ipcRenderer.invoke(RUNTIME_PROVIDER_MANAGEMENT_OAUTH_CODE, input),
    cancelOAuth: (
      input: RuntimeProviderManagementCancelOAuthInput
    ): Promise<RuntimeProviderManagementOAuthControlResponse> =>
      ipcRenderer.invoke(RUNTIME_PROVIDER_MANAGEMENT_OAUTH_CANCEL, input),
    onOAuthProgress: (listener: (event: RuntimeProviderOAuthProgressDto) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, value: RuntimeProviderOAuthProgressDto): void =>
        listener(value);
      ipcRenderer.on(RUNTIME_PROVIDER_MANAGEMENT_OAUTH_PROGRESS, handler);
      return () => ipcRenderer.removeListener(RUNTIME_PROVIDER_MANAGEMENT_OAUTH_PROGRESS, handler);
    },
  };
}
