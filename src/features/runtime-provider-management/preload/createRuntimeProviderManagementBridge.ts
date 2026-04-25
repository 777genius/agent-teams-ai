import {
  RUNTIME_PROVIDER_MANAGEMENT_CONNECT,
  RUNTIME_PROVIDER_MANAGEMENT_CONNECT_API_KEY,
  RUNTIME_PROVIDER_MANAGEMENT_DIRECTORY,
  RUNTIME_PROVIDER_MANAGEMENT_FORGET,
  RUNTIME_PROVIDER_MANAGEMENT_MODELS,
  RUNTIME_PROVIDER_MANAGEMENT_SET_DEFAULT_MODEL,
  RUNTIME_PROVIDER_MANAGEMENT_SETUP_FORM,
  RUNTIME_PROVIDER_MANAGEMENT_TEST_MODEL,
  RUNTIME_PROVIDER_MANAGEMENT_VIEW,
  type RuntimeProviderManagementApi,
} from '@features/runtime-provider-management/contracts';

import type {
  RuntimeProviderManagementConnectApiKeyInput,
  RuntimeProviderManagementConnectInput,
  RuntimeProviderManagementDirectoryResponse,
  RuntimeProviderManagementForgetInput,
  RuntimeProviderManagementLoadDirectoryInput,
  RuntimeProviderManagementLoadSetupFormInput,
  RuntimeProviderManagementLoadModelsInput,
  RuntimeProviderManagementLoadViewInput,
  RuntimeProviderManagementModelTestResponse,
  RuntimeProviderManagementModelsResponse,
  RuntimeProviderManagementProviderResponse,
  RuntimeProviderManagementSetDefaultModelInput,
  RuntimeProviderManagementSetupFormResponse,
  RuntimeProviderManagementTestModelInput,
  RuntimeProviderManagementViewResponse,
} from '@features/runtime-provider-management/contracts';
import type { IpcRenderer } from 'electron';

export function createRuntimeProviderManagementBridge(
  ipcRenderer: IpcRenderer
): RuntimeProviderManagementApi {
  return {
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
  };
}
