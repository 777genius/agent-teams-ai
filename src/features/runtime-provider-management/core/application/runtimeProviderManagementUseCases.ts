import type { RuntimeProviderManagementPort } from './RuntimeProviderManagementPort';
import type {
  RuntimeProviderManagementConnectApiKeyInput,
  RuntimeProviderManagementDirectoryResponse,
  RuntimeProviderManagementForgetInput,
  RuntimeProviderManagementLoadDirectoryInput,
  RuntimeProviderManagementLoadModelsInput,
  RuntimeProviderManagementLoadViewInput,
  RuntimeProviderManagementModelTestResponse,
  RuntimeProviderManagementModelsResponse,
  RuntimeProviderManagementProviderResponse,
  RuntimeProviderManagementSetDefaultModelInput,
  RuntimeProviderManagementTestModelInput,
  RuntimeProviderManagementViewResponse,
} from '@features/runtime-provider-management/contracts';

export function loadRuntimeProviderManagementView(
  port: RuntimeProviderManagementPort,
  input: RuntimeProviderManagementLoadViewInput
): Promise<RuntimeProviderManagementViewResponse> {
  return port.loadView(input);
}

export function loadRuntimeProviderDirectory(
  port: RuntimeProviderManagementPort,
  input: RuntimeProviderManagementLoadDirectoryInput
): Promise<RuntimeProviderManagementDirectoryResponse> {
  return port.loadProviderDirectory(input);
}

export function connectRuntimeProviderWithApiKey(
  port: RuntimeProviderManagementPort,
  input: RuntimeProviderManagementConnectApiKeyInput
): Promise<RuntimeProviderManagementProviderResponse> {
  return port.connectWithApiKey(input);
}

export function forgetRuntimeProviderCredential(
  port: RuntimeProviderManagementPort,
  input: RuntimeProviderManagementForgetInput
): Promise<RuntimeProviderManagementProviderResponse> {
  return port.forgetCredential(input);
}

export function loadRuntimeProviderModels(
  port: RuntimeProviderManagementPort,
  input: RuntimeProviderManagementLoadModelsInput
): Promise<RuntimeProviderManagementModelsResponse> {
  return port.loadModels(input);
}

export function testRuntimeProviderModel(
  port: RuntimeProviderManagementPort,
  input: RuntimeProviderManagementTestModelInput
): Promise<RuntimeProviderManagementModelTestResponse> {
  return port.testModel(input);
}

export function setRuntimeProviderDefaultModel(
  port: RuntimeProviderManagementPort,
  input: RuntimeProviderManagementSetDefaultModelInput
): Promise<RuntimeProviderManagementViewResponse> {
  return port.setDefaultModel(input);
}
