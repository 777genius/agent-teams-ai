import {
  isRuntimeProviderCompanionAction,
  isRuntimeProviderCompanionId,
  RUNTIME_LOCAL_PROVIDER_CONFIGURE,
  RUNTIME_LOCAL_PROVIDER_LIST,
  RUNTIME_LOCAL_PROVIDER_PRESET_IDS,
  RUNTIME_LOCAL_PROVIDER_PROBE,
  RUNTIME_LOCAL_PROVIDER_SCAN,
  RUNTIME_LOCAL_PROVIDER_SCOPES,
  RUNTIME_PROVIDER_COMPANION_ACTION,
  RUNTIME_PROVIDER_COMPANION_CONNECT,
  RUNTIME_PROVIDER_COMPANION_INSTALL,
  RUNTIME_PROVIDER_COMPANION_STATUS,
  RUNTIME_PROVIDER_MANAGEMENT_CONFIGURE_MODEL_LIMITS,
  RUNTIME_PROVIDER_MANAGEMENT_CONNECT,
  RUNTIME_PROVIDER_MANAGEMENT_CONNECT_API_KEY,
  RUNTIME_PROVIDER_MANAGEMENT_DIRECTORY,
  RUNTIME_PROVIDER_MANAGEMENT_FORGET,
  RUNTIME_PROVIDER_MANAGEMENT_MODELS,
  RUNTIME_PROVIDER_MANAGEMENT_OAUTH_CANCEL,
  RUNTIME_PROVIDER_MANAGEMENT_OAUTH_CODE,
  RUNTIME_PROVIDER_MANAGEMENT_SET_DEFAULT_MODEL,
  RUNTIME_PROVIDER_MANAGEMENT_SETUP_FORM,
  RUNTIME_PROVIDER_MANAGEMENT_TEST_MODEL,
  RUNTIME_PROVIDER_MANAGEMENT_VIEW,
} from '@features/runtime-provider-management/contracts';
import { createLogger } from '@shared/utils/logger';

import type { RuntimeProviderManagementFeatureFacade } from '../../composition/createRuntimeProviderManagementFeature';
import type {
  RuntimeLocalProviderConfigureInput,
  RuntimeLocalProviderConfigureResponse,
  RuntimeLocalProviderErrorCodeDto,
  RuntimeLocalProviderListInput,
  RuntimeLocalProviderListResponse,
  RuntimeLocalProviderPresetIdDto,
  RuntimeLocalProviderProbeInput,
  RuntimeLocalProviderProbeResponse,
  RuntimeLocalProviderScanInput,
  RuntimeLocalProviderScanResponse,
  RuntimeProviderCompanionActionInput,
  RuntimeProviderCompanionInput,
  RuntimeProviderCompanionStatusDto,
  RuntimeProviderManagementCancelOAuthInput,
  RuntimeProviderManagementConfigureModelLimitsInput,
  RuntimeProviderManagementConnectApiKeyInput,
  RuntimeProviderManagementConnectInput,
  RuntimeProviderManagementDirectoryResponse,
  RuntimeProviderManagementErrorDto,
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
} from '@features/runtime-provider-management/contracts';
import type { IpcMain } from 'electron';

const logger = createLogger('Feature:RuntimeProviderManagement:IPC');
const LOCAL_PROVIDER_PRESET_ID_SET = new Set<string>(RUNTIME_LOCAL_PROVIDER_PRESET_IDS);
const LOCAL_PROVIDER_SCOPE_SET = new Set<string>(RUNTIME_LOCAL_PROVIDER_SCOPES);
const RUNTIME_PROVIDER_IPC_ERROR_DETAIL_LIMIT = 1_600;
const ESCAPE_CHARACTER = String.fromCharCode(27);
const BELL_CHARACTER = String.fromCharCode(7);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ESCAPE_CHARACTER}\\[[0-?]*[ -/]*[@-~]`, 'g');
const OSC_ESCAPE_PATTERN = new RegExp(
  `${ESCAPE_CHARACTER}\\][\\s\\S]*?(?:${BELL_CHARACTER}|${ESCAPE_CHARACTER}\\\\)`,
  'g'
);

function truncateRuntimeProviderIpcErrorDetail(message: string): string {
  if (message.length <= RUNTIME_PROVIDER_IPC_ERROR_DETAIL_LIMIT) {
    return message;
  }
  return `${message.slice(0, RUNTIME_PROVIDER_IPC_ERROR_DETAIL_LIMIT).trimEnd()}...`;
}

function sanitizeRuntimeProviderIpcErrorMessage(message: string): string {
  const sanitized = message
    .replace(OSC_ESCAPE_PATTERN, '')
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, 'sk-...redacted')
    .replace(/\b(or-[A-Za-z0-9_-]{12,})\b/g, 'or-...redacted')
    .replace(/\b(AIza[A-Za-z0-9_-]{20,})\b/g, 'AIza...redacted')
    .replace(
      /\b([a-z0-9_.-]*(?:api[-_]?key|(?:access|auth)[-_]?token|token|secret|password|[-_]key)["'\s:=]+)([a-z0-9._~+/=-]{12,})/gi,
      '$1...redacted'
    )
    .replace(/\b(key["'\s:=]+)([a-z0-9._~+/=-]{12,})/gi, '$1...redacted')
    .replace(/\b(bearer\s+)([a-z0-9._~+/=-]{12,})/gi, '$1...redacted')
    .trim();
  return truncateRuntimeProviderIpcErrorDetail(sanitized);
}

function getRuntimeProviderIpcErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string') {
    return sanitizeRuntimeProviderIpcErrorMessage(error) || fallback;
  }
  if (!(error instanceof Error) || !error.message.trim()) {
    return fallback;
  }
  return sanitizeRuntimeProviderIpcErrorMessage(error.message) || fallback;
}

function getRuntimeProviderIpcConnectLogDetail(error: unknown): string {
  if (error instanceof Error) {
    return sanitizeRuntimeProviderIpcErrorMessage(error.message) || error.name || 'Error';
  }
  if (typeof error === 'string') {
    return sanitizeRuntimeProviderIpcErrorMessage(error) || 'Non-Error throw';
  }
  return 'Non-Error throw';
}

function createUnexpectedRuntimeProviderIpcError(
  code: RuntimeProviderManagementErrorDto['code'],
  message: string
): RuntimeProviderManagementErrorDto {
  return {
    code,
    message,
    recoverable: true,
    diagnostics: {
      errorCode: code,
      summary: message,
      likelyCause:
        'The desktop app runtime provider management handler failed before it returned a normal response.',
      binaryPath: null,
      command: null,
      projectPath: null,
      exitCode: null,
      stderrPreview: message,
      stdoutPreview: null,
      hints: [
        'Retry the action once after refreshing provider settings.',
        'If it repeats, copy diagnostics and attach the app logs from the same session.',
      ],
    },
  };
}

export function registerRuntimeProviderManagementIpc(
  ipcMain: IpcMain,
  feature: RuntimeProviderManagementFeatureFacade
): void {
  const localProviderError = <
    T extends
      | RuntimeLocalProviderListResponse
      | RuntimeLocalProviderScanResponse
      | RuntimeLocalProviderProbeResponse
      | RuntimeLocalProviderConfigureResponse,
  >(
    code: RuntimeLocalProviderErrorCodeDto,
    message: string
  ): T =>
    ({
      schemaVersion: 1,
      runtimeId: 'opencode',
      error: { code, message, recoverable: true },
    }) as T;
  const isPresetId = (value: unknown): value is RuntimeLocalProviderPresetIdDto =>
    typeof value === 'string' && LOCAL_PROVIDER_PRESET_ID_SET.has(value);
  const isLocalProviderScope = (value: unknown): boolean =>
    typeof value === 'string' && LOCAL_PROVIDER_SCOPE_SET.has(value);
  const validOptionalString = (value: unknown): boolean =>
    value === undefined || value === null || typeof value === 'string';

  ipcMain.handle(
    RUNTIME_LOCAL_PROVIDER_LIST,
    async (
      _event,
      input: RuntimeLocalProviderListInput
    ): Promise<RuntimeLocalProviderListResponse> => {
      if (
        input?.runtimeId !== 'opencode' ||
        !isLocalProviderScope(input.scope) ||
        !validOptionalString(input.projectPath) ||
        (typeof input.projectPath === 'string' && input.projectPath.length > 4_096) ||
        (input.scope === 'project' && typeof input.projectPath !== 'string')
      ) {
        return localProviderError('invalid-input', 'Local provider list request is invalid.');
      }
      try {
        return await feature.listLocalProviders(input);
      } catch (error) {
        const message = getRuntimeProviderIpcErrorMessage(error, 'Failed to load local providers');
        logger.error('Failed to load local providers', message);
        return localProviderError('config-invalid', message);
      }
    }
  );

  ipcMain.handle(
    RUNTIME_LOCAL_PROVIDER_SCAN,
    async (
      _event,
      input: RuntimeLocalProviderScanInput
    ): Promise<RuntimeLocalProviderScanResponse> => {
      if (input?.runtimeId !== 'opencode') {
        return localProviderError('invalid-input', 'Local provider scan request is invalid.');
      }
      try {
        return await feature.scanLocalProviders(input);
      } catch (error) {
        const message = getRuntimeProviderIpcErrorMessage(error, 'Failed to scan local providers');
        logger.error('Failed to scan local providers', message);
        return localProviderError('endpoint-unreachable', message);
      }
    }
  );

  ipcMain.handle(
    RUNTIME_LOCAL_PROVIDER_PROBE,
    async (
      _event,
      input: RuntimeLocalProviderProbeInput
    ): Promise<RuntimeLocalProviderProbeResponse> => {
      if (
        input?.runtimeId !== 'opencode' ||
        !isPresetId(input.presetId) ||
        !validOptionalString(input.baseUrl) ||
        !validOptionalString(input.providerId)
      ) {
        return localProviderError('invalid-input', 'Local provider probe request is invalid.');
      }
      try {
        return await feature.probeLocalProvider(input);
      } catch (error) {
        const message = getRuntimeProviderIpcErrorMessage(error, 'Failed to test local provider');
        logger.error('Failed to test local provider', message);
        return localProviderError('endpoint-unreachable', message);
      }
    }
  );

  ipcMain.handle(
    RUNTIME_LOCAL_PROVIDER_CONFIGURE,
    async (
      _event,
      input: RuntimeLocalProviderConfigureInput
    ): Promise<RuntimeLocalProviderConfigureResponse> => {
      if (
        input?.runtimeId !== 'opencode' ||
        !isPresetId(input.presetId) ||
        !isLocalProviderScope(input.scope) ||
        !validOptionalString(input.projectPath) ||
        (typeof input.projectPath === 'string' && input.projectPath.length > 4_096) ||
        (input.scope === 'project' && typeof input.projectPath !== 'string') ||
        !validOptionalString(input.baseUrl) ||
        !validOptionalString(input.providerId) ||
        typeof input.defaultModelId !== 'string' ||
        input.defaultModelId.length > 256 ||
        typeof input.setAsDefault !== 'boolean'
      ) {
        return localProviderError('invalid-input', 'Local provider configuration is invalid.');
      }
      try {
        return await feature.configureLocalProvider(input);
      } catch (error) {
        const message = getRuntimeProviderIpcErrorMessage(
          error,
          'Failed to configure local provider'
        );
        logger.error('Failed to configure local provider', message);
        return localProviderError('write-failed', message);
      }
    }
  );

  const readCompanionInput = (
    input: RuntimeProviderCompanionInput
  ): RuntimeProviderCompanionInput => {
    if (
      !input ||
      !isRuntimeProviderCompanionId(input.companionId) ||
      (input.projectPath !== undefined &&
        input.projectPath !== null &&
        typeof input.projectPath !== 'string')
    ) {
      throw new Error('Unsupported runtime provider companion');
    }
    return input;
  };
  ipcMain.handle(
    RUNTIME_PROVIDER_COMPANION_STATUS,
    async (
      _event,
      input: RuntimeProviderCompanionInput
    ): Promise<RuntimeProviderCompanionStatusDto> =>
      feature.getCompanionStatus(readCompanionInput(input))
  );
  ipcMain.handle(
    RUNTIME_PROVIDER_COMPANION_INSTALL,
    async (
      _event,
      input: RuntimeProviderCompanionInput
    ): Promise<RuntimeProviderCompanionStatusDto> =>
      feature.installAndConnectCompanion(readCompanionInput(input))
  );
  ipcMain.handle(
    RUNTIME_PROVIDER_COMPANION_CONNECT,
    async (
      _event,
      input: RuntimeProviderCompanionInput
    ): Promise<RuntimeProviderCompanionStatusDto> =>
      feature.connectCompanion(readCompanionInput(input))
  );
  ipcMain.handle(
    RUNTIME_PROVIDER_COMPANION_ACTION,
    async (
      _event,
      input: RuntimeProviderCompanionActionInput
    ): Promise<RuntimeProviderCompanionStatusDto> => {
      const companionInput = readCompanionInput(input);
      if (!isRuntimeProviderCompanionAction(input.action)) {
        throw new Error('Unsupported runtime provider companion action');
      }
      return feature.runCompanionAction({ ...companionInput, action: input.action });
    }
  );
  ipcMain.handle(
    RUNTIME_PROVIDER_MANAGEMENT_VIEW,
    async (
      _event,
      input: RuntimeProviderManagementLoadViewInput
    ): Promise<RuntimeProviderManagementViewResponse> => {
      try {
        return await feature.loadView(input);
      } catch (error) {
        const message = getRuntimeProviderIpcErrorMessage(error, 'Failed to load providers');
        logger.error('Failed to load runtime provider management view', message);
        return {
          schemaVersion: 1,
          runtimeId: input.runtimeId,
          error: createUnexpectedRuntimeProviderIpcError('runtime-unhealthy', message),
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
        const message = getRuntimeProviderIpcErrorMessage(
          error,
          'Failed to load provider directory'
        );
        logger.error('Failed to load runtime provider directory', message);
        return {
          schemaVersion: 1,
          runtimeId: input.runtimeId,
          error: createUnexpectedRuntimeProviderIpcError('runtime-unhealthy', message),
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
        const message = getRuntimeProviderIpcErrorMessage(
          error,
          'Failed to load provider setup form'
        );
        logger.error('Failed to load runtime provider setup form', message);
        return {
          schemaVersion: 1,
          runtimeId: input.runtimeId,
          error: createUnexpectedRuntimeProviderIpcError('runtime-unhealthy', message),
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
        const message = getRuntimeProviderIpcErrorMessage(error, 'Failed to connect provider');
        logger.error(
          'Failed to connect runtime provider',
          getRuntimeProviderIpcConnectLogDetail(error)
        );
        return {
          schemaVersion: 1,
          runtimeId: input.runtimeId,
          error: createUnexpectedRuntimeProviderIpcError('auth-failed', message),
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
        const message = getRuntimeProviderIpcErrorMessage(error, 'Failed to connect provider');
        logger.error(
          'Failed to connect runtime provider',
          getRuntimeProviderIpcConnectLogDetail(error)
        );
        return {
          schemaVersion: 1,
          runtimeId: input.runtimeId,
          error: createUnexpectedRuntimeProviderIpcError('auth-failed', message),
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
        const message = getRuntimeProviderIpcErrorMessage(error, 'Failed to forget provider');
        logger.error('Failed to forget runtime provider credential', message);
        return {
          schemaVersion: 1,
          runtimeId: input.runtimeId,
          error: createUnexpectedRuntimeProviderIpcError('unsupported-action', message),
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
        const message = getRuntimeProviderIpcErrorMessage(error, 'Failed to load provider models');
        logger.error('Failed to load runtime provider models', message);
        return {
          schemaVersion: 1,
          runtimeId: input.runtimeId,
          error: createUnexpectedRuntimeProviderIpcError('runtime-unhealthy', message),
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
        const message = getRuntimeProviderIpcErrorMessage(error, 'Failed to test model');
        logger.error('Failed to test runtime provider model', message);
        return {
          schemaVersion: 1,
          runtimeId: input.runtimeId,
          error: createUnexpectedRuntimeProviderIpcError('model-test-failed', message),
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
        const message = getRuntimeProviderIpcErrorMessage(error, 'Failed to set default model');
        logger.error('Failed to set runtime provider default model', message);
        return {
          schemaVersion: 1,
          runtimeId: input.runtimeId,
          error: createUnexpectedRuntimeProviderIpcError('model-test-failed', message),
        };
      }
    }
  );

  ipcMain.handle(
    RUNTIME_PROVIDER_MANAGEMENT_CONFIGURE_MODEL_LIMITS,
    async (
      _event,
      input: RuntimeProviderManagementConfigureModelLimitsInput
    ): Promise<RuntimeProviderManagementModelLimitsResponse> => {
      const validInput =
        input?.runtimeId === 'opencode' &&
        typeof input.providerId === 'string' &&
        typeof input.modelId === 'string' &&
        Number.isSafeInteger(input.contextTokens) &&
        input.contextTokens > 0 &&
        Number.isSafeInteger(input.outputTokens) &&
        input.outputTokens > 0 &&
        input.outputTokens <= input.contextTokens;
      if (!validInput) {
        return {
          schemaVersion: 1,
          runtimeId: 'opencode',
          error: createUnexpectedRuntimeProviderIpcError(
            'model-test-failed',
            'Local model context limits are invalid'
          ),
        };
      }
      try {
        return await feature.configureModelLimits(input);
      } catch (error) {
        const message = getRuntimeProviderIpcErrorMessage(
          error,
          'Failed to configure local model context limits'
        );
        logger.error('Failed to configure runtime provider model limits', message);
        return {
          schemaVersion: 1,
          runtimeId: input.runtimeId,
          error: createUnexpectedRuntimeProviderIpcError('model-test-failed', message),
        };
      }
    }
  );

  ipcMain.handle(
    RUNTIME_PROVIDER_MANAGEMENT_OAUTH_CODE,
    async (
      _event,
      input: RuntimeProviderManagementSubmitOAuthCodeInput
    ): Promise<RuntimeProviderManagementOAuthControlResponse> => {
      if (!input || typeof input.operationId !== 'string' || typeof input.code !== 'string') {
        return { ok: false, error: 'OAuth code request is invalid' };
      }
      return feature.submitOAuthCode(input);
    }
  );

  ipcMain.handle(
    RUNTIME_PROVIDER_MANAGEMENT_OAUTH_CANCEL,
    async (
      _event,
      input: RuntimeProviderManagementCancelOAuthInput
    ): Promise<RuntimeProviderManagementOAuthControlResponse> => {
      if (!input || typeof input.operationId !== 'string') {
        return { ok: false, error: 'OAuth cancel request is invalid' };
      }
      return feature.cancelOAuth(input);
    }
  );
}

export function removeRuntimeProviderManagementIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(RUNTIME_LOCAL_PROVIDER_SCAN);
  ipcMain.removeHandler(RUNTIME_LOCAL_PROVIDER_PROBE);
  ipcMain.removeHandler(RUNTIME_LOCAL_PROVIDER_CONFIGURE);
  ipcMain.removeHandler(RUNTIME_PROVIDER_COMPANION_STATUS);
  ipcMain.removeHandler(RUNTIME_PROVIDER_COMPANION_INSTALL);
  ipcMain.removeHandler(RUNTIME_PROVIDER_COMPANION_CONNECT);
  ipcMain.removeHandler(RUNTIME_PROVIDER_COMPANION_ACTION);
  ipcMain.removeHandler(RUNTIME_PROVIDER_MANAGEMENT_VIEW);
  ipcMain.removeHandler(RUNTIME_PROVIDER_MANAGEMENT_DIRECTORY);
  ipcMain.removeHandler(RUNTIME_PROVIDER_MANAGEMENT_SETUP_FORM);
  ipcMain.removeHandler(RUNTIME_PROVIDER_MANAGEMENT_CONNECT);
  ipcMain.removeHandler(RUNTIME_PROVIDER_MANAGEMENT_CONNECT_API_KEY);
  ipcMain.removeHandler(RUNTIME_PROVIDER_MANAGEMENT_FORGET);
  ipcMain.removeHandler(RUNTIME_PROVIDER_MANAGEMENT_MODELS);
  ipcMain.removeHandler(RUNTIME_PROVIDER_MANAGEMENT_TEST_MODEL);
  ipcMain.removeHandler(RUNTIME_PROVIDER_MANAGEMENT_SET_DEFAULT_MODEL);
  ipcMain.removeHandler(RUNTIME_PROVIDER_MANAGEMENT_CONFIGURE_MODEL_LIMITS);
  ipcMain.removeHandler(RUNTIME_PROVIDER_MANAGEMENT_OAUTH_CODE);
  ipcMain.removeHandler(RUNTIME_PROVIDER_MANAGEMENT_OAUTH_CANCEL);
}
