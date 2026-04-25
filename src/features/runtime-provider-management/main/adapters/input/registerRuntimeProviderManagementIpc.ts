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
} from '@features/runtime-provider-management/contracts';
import { createLogger } from '@shared/utils/logger';

import type { RuntimeProviderManagementFeatureFacade } from '../../composition/createRuntimeProviderManagementFeature';
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
import type { IpcMain } from 'electron';

const logger = createLogger('Feature:RuntimeProviderManagement:IPC');

export function registerRuntimeProviderManagementIpc(
  ipcMain: IpcMain,
  feature: RuntimeProviderManagementFeatureFacade
): void {
  ipcMain.handle(
    RUNTIME_PROVIDER_MANAGEMENT_VIEW,
    async (
      _event,
      input: RuntimeProviderManagementLoadViewInput
    ): Promise<RuntimeProviderManagementViewResponse> => {
      try {
        return await feature.loadView(input);
      } catch (error) {
        logger.error('Failed to load runtime provider management view', error);
        return {
          schemaVersion: 1,
          runtimeId: input.runtimeId,
          error: {
            code: 'runtime-unhealthy',
            message: error instanceof Error ? error.message : 'Failed to load providers',
            recoverable: true,
          },
        };
      }
    }
  );

  ipcMain.handle(
    RUNTIME_PROVIDER_MANAGEMENT_DIRECTORY,
    async (
      _event,
      input: RuntimeProviderManagementLoadDirectoryInput
    ): Promise<RuntimeProviderManagementDirectoryResponse> => {
      try {
        return await feature.loadProviderDirectory(input);
      } catch (error) {
        logger.error('Failed to load runtime provider directory', error);
        return {
          schemaVersion: 1,
          runtimeId: input.runtimeId,
          error: {
            code: 'runtime-unhealthy',
            message: error instanceof Error ? error.message : 'Failed to load provider directory',
            recoverable: true,
          },
        };
      }
    }
  );

  ipcMain.handle(
    RUNTIME_PROVIDER_MANAGEMENT_SETUP_FORM,
    async (
      _event,
      input: RuntimeProviderManagementLoadSetupFormInput
    ): Promise<RuntimeProviderManagementSetupFormResponse> => {
      try {
        return await feature.loadSetupForm(input);
      } catch (error) {
        logger.error('Failed to load runtime provider setup form', error);
        return {
          schemaVersion: 1,
          runtimeId: input.runtimeId,
          error: {
            code: 'runtime-unhealthy',
            message: error instanceof Error ? error.message : 'Failed to load provider setup form',
            recoverable: true,
          },
        };
      }
    }
  );

  ipcMain.handle(
    RUNTIME_PROVIDER_MANAGEMENT_CONNECT,
    async (
      _event,
      input: RuntimeProviderManagementConnectInput
    ): Promise<RuntimeProviderManagementProviderResponse> => {
      try {
        return await feature.connectProvider(input);
      } catch (error) {
        logger.error(
          'Failed to connect runtime provider',
          error instanceof Error ? error.name : error
        );
        return {
          schemaVersion: 1,
          runtimeId: input.runtimeId,
          error: {
            code: 'auth-failed',
            message: 'Failed to connect provider',
            recoverable: true,
          },
        };
      }
    }
  );

  ipcMain.handle(
    RUNTIME_PROVIDER_MANAGEMENT_CONNECT_API_KEY,
    async (
      _event,
      input: RuntimeProviderManagementConnectApiKeyInput
    ): Promise<RuntimeProviderManagementProviderResponse> => {
      try {
        return await feature.connectWithApiKey(input);
      } catch (error) {
        logger.error(
          'Failed to connect runtime provider',
          error instanceof Error ? error.name : error
        );
        return {
          schemaVersion: 1,
          runtimeId: input.runtimeId,
          error: {
            code: 'auth-failed',
            message: 'Failed to connect provider',
            recoverable: true,
          },
        };
      }
    }
  );

  ipcMain.handle(
    RUNTIME_PROVIDER_MANAGEMENT_FORGET,
    async (
      _event,
      input: RuntimeProviderManagementForgetInput
    ): Promise<RuntimeProviderManagementProviderResponse> => {
      try {
        return await feature.forgetCredential(input);
      } catch (error) {
        logger.error('Failed to forget runtime provider credential', error);
        return {
          schemaVersion: 1,
          runtimeId: input.runtimeId,
          error: {
            code: 'unsupported-action',
            message: error instanceof Error ? error.message : 'Failed to forget provider',
            recoverable: true,
          },
        };
      }
    }
  );

  ipcMain.handle(
    RUNTIME_PROVIDER_MANAGEMENT_MODELS,
    async (
      _event,
      input: RuntimeProviderManagementLoadModelsInput
    ): Promise<RuntimeProviderManagementModelsResponse> => {
      try {
        return await feature.loadModels(input);
      } catch (error) {
        logger.error('Failed to load runtime provider models', error);
        return {
          schemaVersion: 1,
          runtimeId: input.runtimeId,
          error: {
            code: 'runtime-unhealthy',
            message: error instanceof Error ? error.message : 'Failed to load provider models',
            recoverable: true,
          },
        };
      }
    }
  );

  ipcMain.handle(
    RUNTIME_PROVIDER_MANAGEMENT_TEST_MODEL,
    async (
      _event,
      input: RuntimeProviderManagementTestModelInput
    ): Promise<RuntimeProviderManagementModelTestResponse> => {
      try {
        return await feature.testModel(input);
      } catch (error) {
        logger.error('Failed to test runtime provider model', error);
        return {
          schemaVersion: 1,
          runtimeId: input.runtimeId,
          error: {
            code: 'model-test-failed',
            message: error instanceof Error ? error.message : 'Failed to test model',
            recoverable: true,
          },
        };
      }
    }
  );

  ipcMain.handle(
    RUNTIME_PROVIDER_MANAGEMENT_SET_DEFAULT_MODEL,
    async (
      _event,
      input: RuntimeProviderManagementSetDefaultModelInput
    ): Promise<RuntimeProviderManagementViewResponse> => {
      try {
        return await feature.setDefaultModel(input);
      } catch (error) {
        logger.error('Failed to set runtime provider default model', error);
        return {
          schemaVersion: 1,
          runtimeId: input.runtimeId,
          error: {
            code: 'model-test-failed',
            message: error instanceof Error ? error.message : 'Failed to set default model',
            recoverable: true,
          },
        };
      }
    }
  );
}

export function removeRuntimeProviderManagementIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(RUNTIME_PROVIDER_MANAGEMENT_VIEW);
  ipcMain.removeHandler(RUNTIME_PROVIDER_MANAGEMENT_DIRECTORY);
  ipcMain.removeHandler(RUNTIME_PROVIDER_MANAGEMENT_SETUP_FORM);
  ipcMain.removeHandler(RUNTIME_PROVIDER_MANAGEMENT_CONNECT);
  ipcMain.removeHandler(RUNTIME_PROVIDER_MANAGEMENT_CONNECT_API_KEY);
  ipcMain.removeHandler(RUNTIME_PROVIDER_MANAGEMENT_FORGET);
  ipcMain.removeHandler(RUNTIME_PROVIDER_MANAGEMENT_MODELS);
  ipcMain.removeHandler(RUNTIME_PROVIDER_MANAGEMENT_TEST_MODEL);
  ipcMain.removeHandler(RUNTIME_PROVIDER_MANAGEMENT_SET_DEFAULT_MODEL);
}
