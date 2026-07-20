import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  classifyAnalyticsError,
  elapsedMsSince,
  recordProviderConnectionEnd,
} from '@renderer/analytics/productAnalytics';
import { api } from '@renderer/api';
import { getOpenCodeSourceDisplayName } from '@shared/utils/opencodeModelRef';

import {
  getRuntimeProviderCredentialUrl,
  selectInitialProviderId,
  selectRuntimeProviderSetupAuthOptionId,
} from '../../core/domain';
import {
  getOpenCodeModelForNewTeams,
  saveOpenCodeModelForNewTeams,
} from '../adapters/createTeamDefaultModelWriter';

import type { RuntimeProviderConnectionIntent } from '../../core/domain';
import type {
  RuntimeProviderConnectionDto,
  RuntimeProviderDefaultScopeDto,
  RuntimeProviderDirectoryEntryDto,
  RuntimeProviderDirectoryFilterDto,
  RuntimeProviderManagementErrorDiagnosticsDto,
  RuntimeProviderManagementErrorDto,
  RuntimeProviderManagementRuntimeId,
  RuntimeProviderManagementViewDto,
  RuntimeProviderModelDto,
  RuntimeProviderModelTestResultDto,
  RuntimeProviderOAuthProgressDto,
  RuntimeProviderSetupAuthOptionDto,
  RuntimeProviderSetupFormDto,
} from '@features/runtime-provider-management/contracts';

interface UseRuntimeProviderManagementOptions {
  runtimeId: RuntimeProviderManagementRuntimeId;
  enabled: boolean;
  directoryPageSize?: number;
  directorySummaryOnEnable?: boolean;
  loadViewOnEnable?: boolean;
  searchDirectoryOnQueryChange?: boolean;
  projectPath?: string | null;
  initialProviderId?: string | null;
  initialProviderAction?: RuntimeProviderConnectionIntent | 'select' | null;
  onProviderChanged?: (
    changeKind: RuntimeProviderChangeKind
  ) => Promise<boolean | void> | boolean | void;
}

export type RuntimeProviderModelPickerMode = 'use' | 'runtime-default';
export type RuntimeProviderChangeKind =
  | 'connection'
  | 'credential_removed'
  | 'configuration'
  | 'oauth_cancelled';

const DEFAULT_DIRECTORY_FILTER: RuntimeProviderDirectoryFilterDto = 'all';
const MODEL_PAGE_SIZE = 250;
const MODEL_SEARCH_DEBOUNCE_MS = 300;
const OAUTH_CONNECT_UI_TIMEOUT_MS = 18 * 60_000;

function presentProviderConnection(
  provider: RuntimeProviderConnectionDto
): RuntimeProviderConnectionDto {
  const displayName = getOpenCodeSourceDisplayName(provider.providerId, provider.displayName);
  return displayName === provider.displayName ? provider : { ...provider, displayName };
}

function presentDirectoryEntry(
  provider: RuntimeProviderDirectoryEntryDto
): RuntimeProviderDirectoryEntryDto {
  const displayName = getOpenCodeSourceDisplayName(provider.providerId, provider.displayName);
  return displayName === provider.displayName ? provider : { ...provider, displayName };
}

function presentManagementView(
  view: RuntimeProviderManagementViewDto | null
): RuntimeProviderManagementViewDto | null {
  if (!view) return null;
  return { ...view, providers: view.providers.map(presentProviderConnection) };
}

function replaceProviderNameInText(
  value: string | null,
  currentDisplayName: string,
  presentedDisplayName: string
): string | null {
  if (!value || currentDisplayName === presentedDisplayName) return value;
  return value.replace(currentDisplayName, presentedDisplayName);
}

function presentSetupForm(
  form: RuntimeProviderSetupFormDto | null
): RuntimeProviderSetupFormDto | null {
  if (!form) return null;
  // xAI is the catalog source, while SuperGrok is the user-facing subscription
  // being connected. Keep the curated plan name in setup and error messages.
  const displayName =
    form.providerId.trim().toLowerCase() === 'xai' &&
    form.displayName.trim().toLowerCase() === 'supergrok'
      ? form.displayName
      : getOpenCodeSourceDisplayName(form.providerId, form.displayName);
  if (displayName === form.displayName) return form;
  return {
    ...form,
    displayName,
    title: replaceProviderNameInText(form.title, form.displayName, displayName) ?? form.title,
    description: replaceProviderNameInText(form.description, form.displayName, displayName),
    submitLabel:
      replaceProviderNameInText(form.submitLabel, form.displayName, displayName) ??
      form.submitLabel,
  };
}

function presentOAuthProgress(
  event: RuntimeProviderOAuthProgressDto
): RuntimeProviderOAuthProgressDto {
  const displayName = getOpenCodeSourceDisplayName(event.providerId, event.displayName);
  return displayName === event.displayName ? event : { ...event, displayName };
}

interface ProjectContextSnapshot {
  path: string | null;
  generation: number;
}

function mergeModelPages(
  current: readonly RuntimeProviderModelDto[],
  incoming: readonly RuntimeProviderModelDto[]
): readonly RuntimeProviderModelDto[] {
  const merged = new Map(current.map((model) => [model.modelId, model]));
  for (const model of incoming) {
    merged.set(model.modelId, model);
  }
  return [...merged.values()];
}

export interface RuntimeProviderManagementState {
  view: RuntimeProviderManagementViewDto | null;
  providers: readonly RuntimeProviderConnectionDto[];
  selectedProviderId: string | null;
  providerQuery: string;
  directoryLoading: boolean;
  directoryRefreshing: boolean;
  directoryError: string | null;
  directoryErrorDiagnostics: RuntimeProviderManagementErrorDiagnosticsDto | null;
  directoryEntries: readonly RuntimeProviderDirectoryEntryDto[];
  directoryTotalCount: number | null;
  directoryNextCursor: string | null;
  directoryLoaded: boolean;
  directorySummary: boolean;
  directorySelectedProviderId: string | null;
  directorySupported: boolean;
  activeFormProviderId: string | null;
  connectionIntent: RuntimeProviderConnectionIntent | null;
  setupForm: RuntimeProviderSetupFormDto | null;
  setupFormLoading: boolean;
  setupFormError: string | null;
  setupFormErrorDiagnostics: RuntimeProviderManagementErrorDiagnosticsDto | null;
  setupSubmitError: string | null;
  setupSubmitErrorDiagnostics: RuntimeProviderManagementErrorDiagnosticsDto | null;
  setupMetadata: Readonly<Record<string, string>>;
  apiKeyValue: string;
  selectedAuthOptionId: string | null;
  oauthProgress: RuntimeProviderOAuthProgressDto | null;
  oauthCodeValue: string;
  modelPickerProviderId: string | null;
  modelPickerMode: RuntimeProviderModelPickerMode | null;
  modelQuery: string;
  models: readonly RuntimeProviderModelDto[];
  modelsLoading: boolean;
  modelsLoadingMore: boolean;
  modelsTotalCount: number | null;
  modelsNextCursor: string | null;
  modelsError: string | null;
  modelsErrorDiagnostics: RuntimeProviderManagementErrorDiagnosticsDto | null;
  selectedModelId: string | null;
  testingModelIds: readonly string[];
  savingDefaultModelId: string | null;
  modelResults: Readonly<Record<string, RuntimeProviderModelTestResultDto>>;
  loading: boolean;
  savingProviderId: string | null;
  error: string | null;
  errorDiagnostics: RuntimeProviderManagementErrorDiagnosticsDto | null;
  successMessage: string | null;
  warningMessage: string | null;
}

export interface RuntimeProviderManagementActions {
  refresh: () => Promise<boolean>;
  selectProvider: (providerId: string) => void;
  setProviderQuery: (value: string) => void;
  loadMoreDirectory: () => Promise<void>;
  refreshDirectory: () => Promise<void>;
  selectDirectoryProvider: (providerId: string) => void;
  searchAllProviders: (query: string) => void;
  startConnect: (providerId: string) => void;
  startReconnect: (providerId: string) => void;
  cancelConnect: () => void;
  setApiKeyValue: (value: string) => void;
  setAuthOption: (authOptionId: string) => void;
  setSetupMetadataValue: (key: string, value: string) => void;
  setOAuthCodeValue: (value: string) => void;
  submitOAuthCode: () => Promise<void>;
  submitConnect: (providerId: string) => Promise<RuntimeProviderConnectOutcome | null>;
  forgetProvider: (providerId: string) => Promise<void>;
  openProviderCredentialPage: (providerId: string) => Promise<void>;
  openModelPicker: (providerId: string, mode: RuntimeProviderModelPickerMode) => void;
  closeModelPicker: () => void;
  setModelQuery: (value: string) => void;
  loadMoreModels: () => Promise<void>;
  selectModel: (modelId: string) => void;
  useModelForNewTeams: (modelId: string) => void;
  testModel: (providerId: string, modelId: string) => Promise<RuntimeProviderModelTestResultDto>;
  setDefaultModel: (
    providerId: string,
    modelId: string,
    scope?: RuntimeProviderDefaultScopeDto
  ) => Promise<void>;
}

export interface RuntimeProviderConnectOutcome {
  readonly status: 'connected' | 'cancelled';
  readonly verifiedModelId: string | null;
}

function replaceProvider(
  view: RuntimeProviderManagementViewDto | null,
  provider: RuntimeProviderConnectionDto
): RuntimeProviderManagementViewDto | null {
  if (!view) {
    return view;
  }
  return {
    ...view,
    providers: view.providers.map((entry) =>
      entry.providerId === provider.providerId ? provider : entry
    ),
  };
}

function replaceDirectoryProvider(
  entries: readonly RuntimeProviderDirectoryEntryDto[],
  provider: RuntimeProviderConnectionDto,
  connectedMethod: 'api' | 'oauth' | null
): readonly RuntimeProviderDirectoryEntryDto[] {
  return entries.map((entry) => {
    if (entry.providerId !== provider.providerId) {
      return entry;
    }
    const connectedAuthHint =
      provider.connectedAuthHint ?? connectedMethod ?? entry.connectedAuthHint;
    return {
      ...entry,
      state: provider.state,
      setupKind: provider.state === 'connected' ? 'connected' : entry.setupKind,
      connectedAuthHint,
      ownership: provider.ownership,
      recommended: provider.recommended,
      modelCount: provider.modelCount,
      defaultModelId: provider.defaultModelId,
      authMethods: provider.authMethods,
      actions: provider.actions,
      detail: provider.detail,
    };
  });
}

function withUiTimeout<T>(promise: Promise<T>, message: string, timeoutMs = 70_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

function formatProviderConnectError(
  displayName: string,
  error: RuntimeProviderManagementErrorDto
): string {
  const normalizedMessage = error.message.toLowerCase();
  const invalidApiKey =
    /\binvalid[\s_-]+api[\s_-]*key\b/.test(normalizedMessage) ||
    /\bapi[\s_-]*key\s+(?:is\s+)?(?:invalid|expired|revoked)\b/.test(normalizedMessage);
  if (invalidApiKey) {
    return `${displayName} rejected this API key. The new credential was not kept. Copy the key from the correct account or subscription plan, then try again.`;
  }

  const blockedByPolicy =
    normalizedMessage.includes('access denied by security policy') ||
    normalizedMessage.includes('forbidden');
  if (blockedByPolicy) {
    return `${displayName} rejected the verification request because of an account or security policy. The new credential was not kept. Check the key permissions and account restrictions, then try again.`;
  }

  if (error.code === 'auth-failed') {
    return `${displayName} could not verify this credential with a real model request. The new credential was not kept.\n${error.message}`;
  }

  return error.message;
}

function formatProviderConnectSuccess(provider: RuntimeProviderConnectionDto): string {
  return provider.verifiedModelId
    ? `${provider.displayName} connected and verified with ${provider.verifiedModelId}.`
    : `${provider.displayName} connected. Model execution was not verified during setup.`;
}

function formatProviderConnectCancellation(displayName: string): string {
  return `${displayName} connection was cancelled. Your current credential was not changed.`;
}

function formatPostOperationRefreshWarning(successMessage: string): string {
  return `${successMessage} The change is saved, but the latest provider status could not be refreshed. Refresh provider status to see the current state.`;
}

function isProviderConnectCancellation(error: unknown): boolean {
  const value = (() => {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    if (!error || typeof error !== 'object') return '';
    const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
    const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
    return `${code} ${message}`;
  })().toLowerCase();

  return /cancel(?:l)?ed/.test(value) || /access[\s_-]denied/.test(value);
}

function normalizeProjectContextPath(projectPath: string | null | undefined): string | null {
  return projectPath?.trim() || null;
}

function buildFailedModelTestResult(
  providerId: string,
  modelId: string,
  message: string
): RuntimeProviderModelTestResultDto {
  return {
    providerId,
    modelId,
    ok: false,
    availability: 'unknown',
    message,
    diagnostics: [],
  };
}

function applyModelTestResultToModel(
  model: RuntimeProviderModelDto,
  result: RuntimeProviderModelTestResultDto
): RuntimeProviderModelDto {
  if (model.modelId !== result.modelId) {
    return model;
  }
  return {
    ...model,
    availability: result.availability,
    proofState: result.ok ? 'verified' : 'failed',
    accessKind: result.ok ? 'verified' : model.accessKind,
    requiresExecutionProof: result.ok ? false : model.requiresExecutionProof,
  };
}

function applyModelTestResultToView(
  view: RuntimeProviderManagementViewDto | null,
  result: RuntimeProviderModelTestResultDto
): RuntimeProviderManagementViewDto | null {
  if (!view?.configuredModels) {
    return view;
  }
  return {
    ...view,
    configuredModels: view.configuredModels.map((model) =>
      applyModelTestResultToModel(model, result)
    ),
  };
}

function resolveSavedModelForNewTeams(models: readonly RuntimeProviderModelDto[]): string | null {
  const savedModelId = getOpenCodeModelForNewTeams();
  if (!savedModelId) {
    return null;
  }
  return models.some((model) => model.modelId === savedModelId) ? savedModelId : null;
}

function formatCredentialRemovedMessage(provider: RuntimeProviderConnectionDto | null): string {
  if (provider?.state !== 'connected') {
    return 'Credential removed';
  }

  const ownership = new Set(provider.ownership);
  if (!ownership.has('managed') && ownership.has('local')) {
    return 'Managed credential removed. Provider remains connected through local OpenCode credentials.';
  }

  if (!ownership.has('managed') && ownership.size > 0) {
    return 'Managed credential removed. Provider remains connected through another credential source.';
  }

  return 'Credential removed';
}

function resolveSetupAuthOption(
  form: RuntimeProviderSetupFormDto,
  authOptionId: string | null
): RuntimeProviderSetupAuthOptionDto | null {
  if (!form.authOptions?.length) {
    return null;
  }
  return (
    form.authOptions.find((option) => option.id === authOptionId) ?? form.authOptions[0] ?? null
  );
}

function createOAuthOperationId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) {
    return randomUuid;
  }
  if (!globalThis.crypto) {
    throw new Error('Secure random generation is unavailable for OAuth.');
  }
  const randomWords = new Uint32Array(4);
  globalThis.crypto.getRandomValues(randomWords);
  return `oauth-${Date.now()}-${[...randomWords].map((word) => word.toString(36)).join('-')}`;
}

export function useRuntimeProviderManagement(
  options: UseRuntimeProviderManagementOptions
): [RuntimeProviderManagementState, RuntimeProviderManagementActions] {
  const onProviderChanged = options.onProviderChanged;
  const [view, setView] = useState<RuntimeProviderManagementViewDto | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [providerQuery, setProviderQuery] = useState('');
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryRefreshing, setDirectoryRefreshing] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [directoryErrorDiagnostics, setDirectoryErrorDiagnostics] =
    useState<RuntimeProviderManagementErrorDiagnosticsDto | null>(null);
  const [directoryEntries, setDirectoryEntries] = useState<
    readonly RuntimeProviderDirectoryEntryDto[]
  >([]);
  const [directoryTotalCount, setDirectoryTotalCount] = useState<number | null>(null);
  const [directoryNextCursor, setDirectoryNextCursor] = useState<string | null>(null);
  const [directoryQuery, setDirectoryQuery] = useState('');
  const [directoryLoaded, setDirectoryLoaded] = useState(false);
  const [directorySummary, setDirectorySummary] = useState(
    options.directorySummaryOnEnable === true
  );
  const [directorySelectedProviderId, setDirectorySelectedProviderId] = useState<string | null>(
    null
  );
  const [directorySupported, setDirectorySupported] = useState(true);
  const [activeFormProviderId, setActiveFormProviderId] = useState<string | null>(null);
  const [connectionIntent, setConnectionIntent] = useState<RuntimeProviderConnectionIntent | null>(
    null
  );
  const [setupForm, setSetupForm] = useState<RuntimeProviderSetupFormDto | null>(null);
  const [setupFormLoading, setSetupFormLoading] = useState(false);
  const [setupFormError, setSetupFormError] = useState<string | null>(null);
  const [setupFormErrorDiagnostics, setSetupFormErrorDiagnostics] =
    useState<RuntimeProviderManagementErrorDiagnosticsDto | null>(null);
  const [setupSubmitError, setSetupSubmitError] = useState<string | null>(null);
  const [setupSubmitErrorDiagnostics, setSetupSubmitErrorDiagnostics] =
    useState<RuntimeProviderManagementErrorDiagnosticsDto | null>(null);
  const [setupMetadata, setSetupMetadata] = useState<Record<string, string>>({});
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [selectedAuthOptionId, setSelectedAuthOptionId] = useState<string | null>(null);
  const [oauthProgress, setOAuthProgress] = useState<RuntimeProviderOAuthProgressDto | null>(null);
  const [oauthCodeValue, setOAuthCodeValue] = useState('');
  const [modelPickerProviderId, setModelPickerProviderId] = useState<string | null>(null);
  const [modelPickerMode, setModelPickerMode] = useState<RuntimeProviderModelPickerMode | null>(
    null
  );
  const [modelQuery, setModelQuery] = useState('');
  const [debouncedModelQuery, setDebouncedModelQuery] = useState('');
  const [models, setModels] = useState<readonly RuntimeProviderModelDto[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsLoadingMore, setModelsLoadingMore] = useState(false);
  const [modelsTotalCount, setModelsTotalCount] = useState<number | null>(null);
  const [modelsNextCursor, setModelsNextCursor] = useState<string | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsErrorDiagnostics, setModelsErrorDiagnostics] =
    useState<RuntimeProviderManagementErrorDiagnosticsDto | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [testingModelIds, setTestingModelIds] = useState<readonly string[]>([]);
  const [savingDefaultModelId, setSavingDefaultModelId] = useState<string | null>(null);
  const [modelResults, setModelResults] = useState<
    Record<string, RuntimeProviderModelTestResultDto>
  >({});
  const [loading, setLoading] = useState(false);
  const [savingProviderId, setSavingProviderId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDiagnostics, setErrorDiagnostics] =
    useState<RuntimeProviderManagementErrorDiagnosticsDto | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);
  const viewLoadRequestSeq = useRef(0);
  const viewRequestedRef = useRef(false);
  const directoryRequestSeq = useRef(0);
  const setupFormRequestSeq = useRef(0);
  const modelLoadRequestSeq = useRef(0);
  const modelProbeGenerationRef = useRef(0);
  const activeModelPickerProviderRef = useRef<string | null>(null);
  const appliedInitialProviderRef = useRef<string | null>(null);
  const activeOAuthOperationRef = useRef<string | null>(null);
  const activeOAuthPhaseRef = useRef<RuntimeProviderOAuthProgressDto['phase'] | null>(null);
  const cancelledOAuthOperationIdsRef = useRef(new Set<string>());
  const providerViewRef = useRef(view);
  const directoryEntriesRef = useRef(directoryEntries);
  providerViewRef.current = view;
  directoryEntriesRef.current = directoryEntries;
  const cancelActiveOAuthBestEffort = useCallback((): Promise<void> | null => {
    // Once a credential has been received, let the bounded backend verification
    // finish. Terminating here can leave a saved but unverified credential.
    if (activeOAuthPhaseRef.current === 'completing') {
      return null;
    }
    const operationId = activeOAuthOperationRef.current;
    activeOAuthOperationRef.current = null;
    activeOAuthPhaseRef.current = null;
    if (!operationId) {
      return null;
    }
    cancelledOAuthOperationIdsRef.current.add(operationId);
    const cancelOAuth = api.runtimeProviderManagement.cancelOAuth;
    if (!cancelOAuth) {
      return Promise.resolve();
    }
    return cancelOAuth({ operationId })
      .then(() => undefined)
      .catch(() => undefined);
  }, []);
  const currentProjectPath = normalizeProjectContextPath(options.projectPath);
  const projectContextRef = useRef<ProjectContextSnapshot>({
    path: currentProjectPath,
    generation: 0,
  });
  if (projectContextRef.current.path !== currentProjectPath) {
    projectContextRef.current = {
      path: currentProjectPath,
      generation: projectContextRef.current.generation + 1,
    };
  }

  const getProjectContextSnapshot = useCallback(
    (): ProjectContextSnapshot => projectContextRef.current,
    []
  );
  const isProjectContextCurrent = useCallback(
    (snapshot: ProjectContextSnapshot): boolean =>
      projectContextRef.current.path === snapshot.path &&
      projectContextRef.current.generation === snapshot.generation,
    []
  );

  const openModelPickerState = useCallback(
    (providerId: string, mode: RuntimeProviderModelPickerMode): void => {
      modelLoadRequestSeq.current += 1;
      modelProbeGenerationRef.current += 1;
      activeModelPickerProviderRef.current = providerId;
      setModelPickerProviderId(providerId);
      setModelPickerMode(mode);
      setModelQuery('');
      setDebouncedModelQuery('');
      setModels([]);
      setModelsLoading(false);
      setModelsLoadingMore(false);
      setModelsTotalCount(null);
      setModelsNextCursor(null);
      setModelsError(null);
      setModelsErrorDiagnostics(null);
      setSelectedModelId(null);
      setModelResults({});
      setTestingModelIds([]);
    },
    []
  );

  const closeModelPickerState = useCallback((): void => {
    modelLoadRequestSeq.current += 1;
    modelProbeGenerationRef.current += 1;
    activeModelPickerProviderRef.current = null;
    setModelPickerProviderId(null);
    setModelPickerMode(null);
    setModelQuery('');
    setDebouncedModelQuery('');
    setModels([]);
    setModelsLoading(false);
    setModelsLoadingMore(false);
    setModelsTotalCount(null);
    setModelsNextCursor(null);
    setModelsError(null);
    setModelsErrorDiagnostics(null);
    setSelectedModelId(null);
    setModelResults({});
    setTestingModelIds([]);
  }, []);

  useEffect(() => {
    directoryRequestSeq.current += 1;
    setupFormRequestSeq.current += 1;
    modelLoadRequestSeq.current += 1;
    modelProbeGenerationRef.current += 1;
    setDirectoryLoading(false);
    setDirectoryRefreshing(false);
    setDirectoryEntries([]);
    setDirectoryTotalCount(null);
    setDirectoryNextCursor(null);
    setDirectoryError(null);
    setDirectoryErrorDiagnostics(null);
    setDirectorySelectedProviderId(null);
    setDirectoryLoaded(false);
    setSetupForm(null);
    setSetupFormLoading(false);
    setSetupFormError(null);
    setSetupFormErrorDiagnostics(null);
    setSetupSubmitError(null);
    setSetupSubmitErrorDiagnostics(null);
    setActiveFormProviderId(null);
    setConnectionIntent(null);
    setApiKeyValue('');
    setSelectedAuthOptionId(null);
    setOAuthProgress(null);
    setOAuthCodeValue('');
    void cancelActiveOAuthBestEffort();
    setSetupMetadata({});
    setModels([]);
    setModelsLoading(false);
    setModelsLoadingMore(false);
    setModelsTotalCount(null);
    setModelsNextCursor(null);
    setModelsError(null);
    setModelsErrorDiagnostics(null);
    setSelectedModelId(null);
    setTestingModelIds([]);
    setSavingProviderId(null);
    setSavingDefaultModelId(null);
    setModelResults({});
    setSuccessMessage(null);
    setWarningMessage(null);
  }, [cancelActiveOAuthBestEffort, currentProjectPath]);

  const refresh = useCallback(
    async (input: { silent?: boolean } = {}): Promise<boolean> => {
      if (!options.enabled) {
        return true;
      }
      viewRequestedRef.current = true;
      const projectContext = getProjectContextSnapshot();
      const requestSeq = viewLoadRequestSeq.current + 1;
      viewLoadRequestSeq.current = requestSeq;
      const requestIsCurrent = (): boolean =>
        viewLoadRequestSeq.current === requestSeq && isProjectContextCurrent(projectContext);
      const silent = input.silent === true;
      if (!silent) {
        setLoading(true);
      }
      setError(null);
      setErrorDiagnostics(null);
      try {
        const response = await api.runtimeProviderManagement.loadView({
          runtimeId: options.runtimeId,
          projectPath: projectContext.path,
        });
        if (!requestIsCurrent()) {
          return false;
        }
        if (response.error) {
          if (!silent) {
            setView(null);
          }
          setError(response.error.message);
          setErrorDiagnostics(response.error.diagnostics ?? null);
          return false;
        }
        const nextView = presentManagementView(response.view ?? null);
        setView(nextView);
        setSelectedProviderId((current) => {
          if (current && nextView?.providers.some((provider) => provider.providerId === current)) {
            return current;
          }
          return selectInitialProviderId(nextView);
        });
        return true;
      } catch (loadError) {
        if (!requestIsCurrent()) {
          return false;
        }
        if (!silent) {
          setView(null);
        }
        setError(loadError instanceof Error ? loadError.message : 'Failed to load providers');
        setErrorDiagnostics(null);
        return false;
      } finally {
        if (!silent && requestIsCurrent()) {
          setLoading(false);
        }
      }
    },
    [getProjectContextSnapshot, isProjectContextCurrent, options.enabled, options.runtimeId]
  );

  const loadDirectoryPage = useCallback(
    async (
      input: {
        append?: boolean;
        refresh?: boolean;
        query?: string;
        filter?: RuntimeProviderDirectoryFilterDto;
        cursor?: string | null;
        summary?: boolean;
      } = {}
    ): Promise<boolean> => {
      if (!options.enabled || !directorySupported) {
        return true;
      }

      const append = input.append === true;
      const refreshDirectoryData = input.refresh === true;
      const query = input.query ?? directoryQuery;
      const filter = input.filter ?? DEFAULT_DIRECTORY_FILTER;
      const cursor = input.cursor ?? null;
      const summary = input.summary ?? directorySummary;
      const projectContext = getProjectContextSnapshot();
      const requestSeq = directoryRequestSeq.current + 1;
      directoryRequestSeq.current = requestSeq;
      const requestIsCurrent = (): boolean =>
        directoryRequestSeq.current === requestSeq && isProjectContextCurrent(projectContext);

      if (append) {
        setDirectoryRefreshing(true);
      } else if (refreshDirectoryData) {
        setDirectoryRefreshing(true);
      } else {
        setDirectoryLoading(true);
      }
      setDirectoryError(null);
      setDirectoryErrorDiagnostics(null);

      try {
        const response = await api.runtimeProviderManagement.loadProviderDirectory({
          runtimeId: options.runtimeId,
          ...(summary ? { summary: true } : {}),
          projectPath: projectContext.path,
          query: query.trim() || null,
          filter,
          limit: options.directoryPageSize ?? 50,
          cursor,
          refresh: refreshDirectoryData,
        });
        if (!requestIsCurrent()) {
          return false;
        }
        if (response.error) {
          setDirectoryError(response.error.message);
          setDirectoryErrorDiagnostics(response.error.diagnostics ?? null);
          if (
            response.error.code === 'unsupported-action' ||
            response.error.message.toLowerCase().includes('unknown command')
          ) {
            setDirectorySupported(false);
          }
          return false;
        }
        const directory = response.directory;
        if (!directory) {
          setDirectoryError('Provider directory response was empty');
          setDirectoryErrorDiagnostics(null);
          return false;
        }
        setDirectoryLoaded(true);
        setDirectorySummary(summary);
        setDirectoryTotalCount(directory.totalCount);
        setDirectoryNextCursor(directory.nextCursor);
        setDirectoryEntries((current) =>
          append
            ? [...current, ...directory.entries.map(presentDirectoryEntry)]
            : directory.entries.map(presentDirectoryEntry)
        );
        return true;
      } catch (loadError) {
        if (requestIsCurrent()) {
          setDirectoryError(
            loadError instanceof Error ? loadError.message : 'Failed to load provider directory'
          );
          setDirectoryErrorDiagnostics(null);
        }
        return false;
      } finally {
        if (requestIsCurrent()) {
          setDirectoryLoading(false);
          setDirectoryRefreshing(false);
        }
      }
    },
    [
      directoryQuery,
      directorySummary,
      directorySupported,
      getProjectContextSnapshot,
      isProjectContextCurrent,
      options.enabled,
      options.directoryPageSize,
      options.runtimeId,
    ]
  );
  const loadDirectoryPageRef = useRef(loadDirectoryPage);
  useEffect(() => {
    loadDirectoryPageRef.current = loadDirectoryPage;
  }, [loadDirectoryPage]);

  useEffect(() => {
    if (!options.enabled) {
      viewRequestedRef.current = false;
      viewLoadRequestSeq.current += 1;
      directoryRequestSeq.current += 1;
      setupFormRequestSeq.current += 1;
      appliedInitialProviderRef.current = null;
      setView(null);
      setSelectedProviderId(null);
      setProviderQuery('');
      setLoading(false);
      setSavingProviderId(null);
      setSavingDefaultModelId(null);
      setError(null);
      setErrorDiagnostics(null);
      setSuccessMessage(null);
      setWarningMessage(null);
      setDirectoryLoading(false);
      setDirectoryRefreshing(false);
      setDirectoryError(null);
      setDirectoryErrorDiagnostics(null);
      setDirectoryEntries([]);
      setDirectoryTotalCount(null);
      setDirectoryNextCursor(null);
      setDirectoryQuery('');
      setDirectoryLoaded(false);
      setDirectorySummary(options.directorySummaryOnEnable === true);
      setDirectorySelectedProviderId(null);
      setDirectorySupported(true);
      setApiKeyValue('');
      setSelectedAuthOptionId(null);
      setOAuthProgress(null);
      setOAuthCodeValue('');
      void cancelActiveOAuthBestEffort();
      setSetupMetadata({});
      setSetupForm(null);
      setSetupFormLoading(false);
      setSetupFormError(null);
      setSetupFormErrorDiagnostics(null);
      setSetupSubmitError(null);
      setSetupSubmitErrorDiagnostics(null);
      setActiveFormProviderId(null);
      closeModelPickerState();
      return;
    }
    if (options.loadViewOnEnable !== false || viewRequestedRef.current) {
      void refresh();
    }
  }, [
    closeModelPickerState,
    cancelActiveOAuthBestEffort,
    currentProjectPath,
    options.enabled,
    options.directorySummaryOnEnable,
    options.loadViewOnEnable,
    refresh,
  ]);

  useEffect(() => {
    if (!options.enabled) {
      return;
    }
    return api.runtimeProviderManagement.onOAuthProgress?.((event) => {
      if (event.operationId !== activeOAuthOperationRef.current) {
        return;
      }
      activeOAuthPhaseRef.current = event.phase;
      setOAuthProgress(presentOAuthProgress(event));
      if (event.phase === 'failed') {
        setSetupSubmitError(event.message ?? 'Browser authorization failed');
      }
    });
  }, [options.enabled]);

  useEffect(() => {
    if (!options.enabled || !directorySupported) {
      return;
    }
    const timeout = window.setTimeout(
      () => {
        void loadDirectoryPageRef.current({
          append: false,
          query: directoryQuery,
          filter: DEFAULT_DIRECTORY_FILTER,
          cursor: null,
        });
      },
      directoryQuery ? 250 : 0
    );

    return () => window.clearTimeout(timeout);
  }, [currentProjectPath, directoryQuery, directorySupported, options.enabled]);

  useEffect(() => {
    if (!options.enabled || !modelPickerProviderId) {
      return;
    }
    const normalizedQuery = modelQuery.trim();
    if (normalizedQuery === debouncedModelQuery) {
      return;
    }
    const timeout = window.setTimeout(
      () => setDebouncedModelQuery(normalizedQuery),
      normalizedQuery ? MODEL_SEARCH_DEBOUNCE_MS : 0
    );
    return () => window.clearTimeout(timeout);
  }, [debouncedModelQuery, modelPickerProviderId, modelQuery, options.enabled]);

  const loadModelsPage = useCallback(
    async (input: { append?: boolean; cursor?: string | null } = {}): Promise<void> => {
      if (!options.enabled || !modelPickerProviderId) {
        return;
      }
      const append = input.append === true;
      const providerId = modelPickerProviderId;
      const projectContext = getProjectContextSnapshot();
      const requestSeq = modelLoadRequestSeq.current + 1;
      modelLoadRequestSeq.current = requestSeq;
      const requestIsCurrent = (): boolean =>
        modelLoadRequestSeq.current === requestSeq &&
        activeModelPickerProviderRef.current === providerId &&
        isProjectContextCurrent(projectContext);

      if (append) {
        setModelsLoadingMore(true);
      } else {
        setModelsLoading(true);
      }
      setModelsError(null);
      setModelsErrorDiagnostics(null);

      try {
        const response = await withUiTimeout(
          api.runtimeProviderManagement.loadModels({
            runtimeId: options.runtimeId,
            providerId,
            projectPath: projectContext.path,
            query: debouncedModelQuery || null,
            limit: MODEL_PAGE_SIZE,
            cursor: input.cursor ?? null,
            requestGroupId: `provider-model-picker:${options.runtimeId}:${projectContext.path ?? ''}:${providerId}`,
          }),
          'Provider models load timed out',
          100_000
        );
        if (!requestIsCurrent()) {
          return;
        }
        if (response.error) {
          if (!append) {
            setModels([]);
            setModelsTotalCount(null);
            setModelsNextCursor(null);
          }
          setModelsError(response.error.message);
          setModelsErrorDiagnostics(response.error.diagnostics ?? null);
          return;
        }
        const modelPage = response.models;
        const nextModels = modelPage?.models ?? [];
        setModels((current) => (append ? mergeModelPages(current, nextModels) : nextModels));
        setModelsTotalCount(
          (current) => modelPage?.totalCount ?? (append ? current : nextModels.length)
        );
        setModelsNextCursor(modelPage?.nextCursor ?? null);
        setSelectedModelId((current) => {
          if (append) {
            return current ?? resolveSavedModelForNewTeams(nextModels);
          }
          if (current && nextModels.some((model) => model.modelId === current)) {
            return current;
          }
          return resolveSavedModelForNewTeams(nextModels);
        });
      } catch (modelsLoadError) {
        if (requestIsCurrent()) {
          if (!append) {
            setModels([]);
            setModelsTotalCount(null);
            setModelsNextCursor(null);
          }
          setModelsError(
            modelsLoadError instanceof Error
              ? modelsLoadError.message
              : 'Failed to load provider models'
          );
          setModelsErrorDiagnostics(null);
        }
      } finally {
        if (requestIsCurrent()) {
          if (append) {
            setModelsLoadingMore(false);
          } else {
            setModelsLoading(false);
          }
        }
      }
    },
    [
      debouncedModelQuery,
      getProjectContextSnapshot,
      isProjectContextCurrent,
      modelPickerProviderId,
      options.enabled,
      options.runtimeId,
    ]
  );

  const loadModelsPageRef = useRef(loadModelsPage);
  useEffect(() => {
    loadModelsPageRef.current = loadModelsPage;
  }, [loadModelsPage]);

  useEffect(() => {
    if (!options.enabled || !modelPickerProviderId) {
      modelLoadRequestSeq.current += 1;
      setModelsLoading(false);
      setModelsLoadingMore(false);
      setModelsErrorDiagnostics(null);
      return;
    }
    void loadModelsPageRef.current();
  }, [currentProjectPath, debouncedModelQuery, modelPickerProviderId, options.enabled]);

  useEffect(() => {
    if (!options.enabled || activeFormProviderId) {
      return;
    }

    const selectedProvider = view?.providers.find(
      (provider) => provider.providerId === selectedProviderId
    );
    const selectedDirectoryProvider = directoryEntries.find(
      (provider) => provider.providerId === selectedProviderId
    );
    if (
      (selectedProvider?.state === 'connected' && selectedProvider.modelCount > 0) ||
      ((selectedDirectoryProvider?.state === 'connected' ||
        selectedDirectoryProvider?.metadata.configuredAuthless === true) &&
        selectedDirectoryProvider.modelCount !== 0)
    ) {
      const providerId = selectedProvider?.providerId ?? selectedDirectoryProvider!.providerId;
      if (modelPickerProviderId !== providerId) {
        openModelPickerState(providerId, 'use');
      }
      return;
    }

    if (modelPickerProviderId) {
      closeModelPickerState();
    }
  }, [
    activeFormProviderId,
    closeModelPickerState,
    directoryEntries,
    modelPickerProviderId,
    openModelPickerState,
    options.enabled,
    selectedProviderId,
    view,
  ]);

  const loadMoreDirectory = useCallback(async (): Promise<void> => {
    if (!directoryNextCursor || directoryLoading || directoryRefreshing) {
      return;
    }
    await loadDirectoryPage({
      append: true,
      cursor: directoryNextCursor,
    });
  }, [directoryLoading, directoryNextCursor, directoryRefreshing, loadDirectoryPage]);

  const loadMoreModels = useCallback(async (): Promise<void> => {
    if (!modelsNextCursor || modelsLoading || modelsLoadingMore) {
      return;
    }
    await loadModelsPage({
      append: true,
      cursor: modelsNextCursor,
    });
  }, [loadModelsPage, modelsLoading, modelsLoadingMore, modelsNextCursor]);

  const refreshDirectory = useCallback(async (): Promise<void> => {
    setSuccessMessage(null);
    setWarningMessage(null);
    await Promise.all([
      viewRequestedRef.current ? refresh({ silent: true }) : Promise.resolve(),
      loadDirectoryPage({
        summary: false,
        refresh: true,
        cursor: null,
      }),
    ]);
    if (modelPickerProviderId) {
      await loadModelsPage();
    }
  }, [loadDirectoryPage, loadModelsPage, modelPickerProviderId, refresh]);

  const selectDirectoryProvider = useCallback(
    (providerId: string): void => {
      setDirectorySelectedProviderId(providerId);
      setSelectedProviderId(providerId);
      setActiveFormProviderId(null);
      setSetupForm(null);
      setSetupFormError(null);
      setSetupFormErrorDiagnostics(null);
      setSetupSubmitError(null);
      setSetupSubmitErrorDiagnostics(null);
      setSetupMetadata({});
      setApiKeyValue('');
      setSelectedAuthOptionId(null);
      setOAuthProgress(null);
      setOAuthCodeValue('');
      void cancelActiveOAuthBestEffort();

      const compactProvider = view?.providers.find(
        (provider) => provider.providerId === providerId
      );
      const directoryProvider = directoryEntries.find(
        (provider) => provider.providerId === providerId
      );
      const connected =
        compactProvider?.state === 'connected' ||
        directoryProvider?.state === 'connected' ||
        directoryProvider?.metadata.configuredAuthless === true;
      const modelCount = compactProvider?.modelCount ?? directoryProvider?.modelCount ?? null;

      if (connected && modelCount !== 0) {
        openModelPickerState(providerId, 'use');
      } else {
        closeModelPickerState();
      }
    },
    [
      cancelActiveOAuthBestEffort,
      closeModelPickerState,
      directoryEntries,
      openModelPickerState,
      view,
    ]
  );

  const searchAllProviders = useCallback((query: string): void => {
    setDirectorySummary(false);
    setDirectoryQuery(query);
    setDirectoryError(null);
    setDirectoryErrorDiagnostics(null);
    setDirectoryNextCursor(null);
  }, []);

  const startConnection = useCallback(
    (providerId: string, intent: RuntimeProviderConnectionIntent): void => {
      setSelectedProviderId(providerId);
      setActiveFormProviderId(providerId);
      setConnectionIntent(intent);
      closeModelPickerState();
      setApiKeyValue('');
      setSelectedAuthOptionId(null);
      setOAuthProgress(null);
      setOAuthCodeValue('');
      void cancelActiveOAuthBestEffort();
      setSetupMetadata({});
      setSetupForm(null);
      setSetupFormError(null);
      setSetupFormErrorDiagnostics(null);
      setSetupSubmitError(null);
      setSetupSubmitErrorDiagnostics(null);
      setSetupFormLoading(true);
      setError(null);
      setErrorDiagnostics(null);
      setSuccessMessage(null);
      setWarningMessage(null);
      const connectedAuthHint =
        providerViewRef.current?.providers.find((provider) => provider.providerId === providerId)
          ?.connectedAuthHint ??
        directoryEntriesRef.current.find((provider) => provider.providerId === providerId)
          ?.connectedAuthHint ??
        null;
      const projectContext = getProjectContextSnapshot();
      const requestSeq = setupFormRequestSeq.current + 1;
      setupFormRequestSeq.current = requestSeq;
      const requestIsCurrent = (): boolean =>
        setupFormRequestSeq.current === requestSeq && isProjectContextCurrent(projectContext);

      void withUiTimeout(
        api.runtimeProviderManagement.loadSetupForm({
          runtimeId: options.runtimeId,
          providerId,
          projectPath: projectContext.path,
        }),
        'Provider setup form load timed out'
      )
        .then((response) => {
          if (!requestIsCurrent()) {
            return;
          }
          if (response.error) {
            setSetupFormError(response.error.message);
            setSetupFormErrorDiagnostics(response.error.diagnostics ?? null);
            return;
          }
          const setupForm = presentSetupForm(response.setupForm ?? null);
          setSetupForm(setupForm);
          setSelectedAuthOptionId(
            setupForm
              ? selectRuntimeProviderSetupAuthOptionId({
                  form: setupForm,
                  intent,
                  connectedAuthHint,
                })
              : null
          );
          if (!setupForm) {
            setSetupFormError('Provider setup form response was empty');
            setSetupFormErrorDiagnostics(null);
          }
        })
        .catch((setupError) => {
          if (!requestIsCurrent()) {
            return;
          }
          setSetupFormError(
            setupError instanceof Error ? setupError.message : 'Failed to load provider setup form'
          );
          setSetupFormErrorDiagnostics(null);
        })
        .finally(() => {
          if (requestIsCurrent()) {
            setSetupFormLoading(false);
          }
        });
    },
    [
      cancelActiveOAuthBestEffort,
      closeModelPickerState,
      getProjectContextSnapshot,
      isProjectContextCurrent,
      options.runtimeId,
    ]
  );

  const startConnect = useCallback(
    (providerId: string): void => startConnection(providerId, 'connect'),
    [startConnection]
  );

  const startReconnect = useCallback(
    (providerId: string): void => startConnection(providerId, 'reconnect'),
    [startConnection]
  );

  const updateProviderQuery = useCallback(
    (value: string): void => {
      setProviderQuery(value);
      if (!directorySupported) {
        return;
      }
      if (options.searchDirectoryOnQueryChange === false) {
        if (!value.trim() && directoryQuery) {
          setDirectoryQuery('');
          setDirectoryNextCursor(null);
        }
        return;
      }
      setDirectoryQuery(value);
      setDirectoryNextCursor(null);
    },
    [directoryQuery, directorySupported, options.searchDirectoryOnQueryChange]
  );

  const updateModelQuery = useCallback((value: string): void => {
    modelLoadRequestSeq.current += 1;
    setModelQuery(value);
    setModelsLoading(false);
    setModelsLoadingMore(false);
    setModelsNextCursor(null);
  }, []);

  const cancelConnect = useCallback((): void => {
    const cancellation = cancelActiveOAuthBestEffort();
    setupFormRequestSeq.current += 1;
    setActiveFormProviderId(null);
    setConnectionIntent(null);
    setApiKeyValue('');
    setSelectedAuthOptionId(null);
    setOAuthProgress(null);
    setOAuthCodeValue('');
    setSetupMetadata({});
    setSetupForm(null);
    setSetupFormLoading(false);
    setSetupFormError(null);
    setSetupFormErrorDiagnostics(null);
    setSetupSubmitError(null);
    setSetupSubmitErrorDiagnostics(null);
    setError(null);
    setErrorDiagnostics(null);
    if (cancellation) {
      void cancellation.then(() => onProviderChanged?.('oauth_cancelled')).catch(() => undefined);
    }
  }, [cancelActiveOAuthBestEffort, onProviderChanged]);

  const updateApiKeyValue = useCallback((value: string): void => {
    setApiKeyValue(value);
    setSetupSubmitError(null);
    setSetupSubmitErrorDiagnostics(null);
  }, []);

  const setAuthOption = useCallback((authOptionId: string): void => {
    setSelectedAuthOptionId(authOptionId);
    setApiKeyValue('');
    setSetupMetadata({});
    setOAuthProgress(null);
    setOAuthCodeValue('');
    setSetupSubmitError(null);
    setSetupSubmitErrorDiagnostics(null);
  }, []);

  const submitOAuthCode = useCallback(async (): Promise<void> => {
    const operationId = activeOAuthOperationRef.current;
    const code = oauthCodeValue.trim();
    if (!operationId || !code) {
      setSetupSubmitError('Authorization code is required');
      return;
    }
    const result = await api.runtimeProviderManagement.submitOAuthCode({ operationId, code });
    if (!result.ok) {
      setSetupSubmitError(result.error ?? 'Could not submit the authorization code');
      return;
    }
    setOAuthCodeValue('');
  }, [oauthCodeValue]);

  const setSetupMetadataValue = useCallback((key: string, value: string): void => {
    setSetupMetadata((current) => ({
      ...current,
      [key]: value,
    }));
    setSetupSubmitError(null);
    setSetupSubmitErrorDiagnostics(null);
  }, []);

  const submitConnect = useCallback(
    async (providerId: string): Promise<RuntimeProviderConnectOutcome | null> => {
      if (!setupForm) {
        setSetupSubmitError(setupFormError ?? 'Provider setup form is not loaded');
        setSetupSubmitErrorDiagnostics(setupFormErrorDiagnostics ?? null);
        return null;
      }
      if (!setupForm.supported) {
        setSetupSubmitError(
          setupForm.disabledReason ?? 'Provider setup is not supported in the app'
        );
        setSetupSubmitErrorDiagnostics(null);
        return null;
      }
      const authOption = resolveSetupAuthOption(setupForm, selectedAuthOptionId);
      if (authOption && !authOption.supported) {
        setSetupSubmitError(authOption.disabledReason ?? 'This sign-in method is unavailable');
        setSetupSubmitErrorDiagnostics(null);
        return null;
      }
      const apiKey = apiKeyValue.trim();
      const secret = authOption?.secret ?? setupForm.secret;
      if (secret?.required && !apiKey) {
        setSetupSubmitError(`${secret.label} is required`);
        setSetupSubmitErrorDiagnostics(null);
        return null;
      }

      setSavingProviderId(providerId);
      setError(null);
      setErrorDiagnostics(null);
      setSetupSubmitError(null);
      setSetupSubmitErrorDiagnostics(null);
      setSuccessMessage(null);
      setWarningMessage(null);
      const projectContext = getProjectContextSnapshot();
      const method = authOption?.method ?? setupForm.method;
      const connectionStartedAtMs = Date.now();
      const connectionAttemptIntent = connectionIntent ?? 'unknown';
      const oauthOperationId = method === 'oauth' ? createOAuthOperationId() : null;
      const recordUnsuccessfulConnection = (error: unknown): boolean => {
        const cancelled =
          method === 'oauth' &&
          ((oauthOperationId !== null &&
            cancelledOAuthOperationIdsRef.current.has(oauthOperationId)) ||
            isProviderConnectCancellation(error));
        recordProviderConnectionEnd({
          runtime: options.runtimeId,
          provider: providerId,
          authMethod: method,
          connectionIntent: connectionAttemptIntent,
          outcome: cancelled ? 'cancelled' : 'failed',
          errorClass: cancelled
            ? 'none'
            : error == null
              ? 'unknown'
              : classifyAnalyticsError(error),
          durationMs: elapsedMsSince(connectionStartedAtMs),
        });
        return cancelled;
      };
      activeOAuthOperationRef.current = oauthOperationId;
      activeOAuthPhaseRef.current = null;
      setOAuthProgress(null);
      try {
        const response = await withUiTimeout(
          api.runtimeProviderManagement.connectProvider({
            runtimeId: options.runtimeId,
            providerId,
            method,
            apiKey: apiKey || null,
            metadata: setupMetadata,
            ...(authOption?.methodIndex !== undefined && authOption.methodIndex !== null
              ? { authMethodIndex: authOption.methodIndex }
              : {}),
            ...(authOption?.id ? { authOptionId: authOption.id } : {}),
            ...(oauthOperationId ? { oauthOperationId } : {}),
            projectPath: projectContext.path,
          }),
          'Provider connect timed out',
          method === 'oauth' ? OAUTH_CONNECT_UI_TIMEOUT_MS : 100_000
        );
        if (response.error) {
          const cancelled = recordUnsuccessfulConnection(response.error);
          if (!isProjectContextCurrent(projectContext)) {
            return null;
          }
          setSetupSubmitError(
            cancelled
              ? formatProviderConnectCancellation(setupForm.displayName)
              : formatProviderConnectError(setupForm.displayName, response.error)
          );
          setSetupSubmitErrorDiagnostics(cancelled ? null : (response.error.diagnostics ?? null));
          return cancelled ? { status: 'cancelled', verifiedModelId: null } : null;
        }
        const connectedProvider =
          response.provider?.state === 'connected'
            ? presentProviderConnection(response.provider)
            : null;
        if (!connectedProvider) {
          const cancelled = recordUnsuccessfulConnection(null);
          if (!isProjectContextCurrent(projectContext)) {
            return null;
          }
          setSetupSubmitError(
            cancelled
              ? formatProviderConnectCancellation(setupForm.displayName)
              : `${setupForm.displayName} did not confirm the connection. Your current credential was not changed. Try again or refresh provider status.`
          );
          setSetupSubmitErrorDiagnostics(null);
          return cancelled ? { status: 'cancelled', verifiedModelId: null } : null;
        }
        recordProviderConnectionEnd({
          runtime: options.runtimeId,
          provider: providerId,
          authMethod: method,
          connectionIntent: connectionAttemptIntent,
          outcome: connectedProvider.verifiedModelId ? 'verified' : 'connected_unverified',
          errorClass: 'none',
          durationMs: elapsedMsSince(connectionStartedAtMs),
        });
        if (!isProjectContextCurrent(projectContext)) {
          return null;
        }
        setView((current) => replaceProvider(current, connectedProvider));
        setDirectoryEntries((current) =>
          replaceDirectoryProvider(current, connectedProvider, method === 'manual' ? null : method)
        );
        setActiveFormProviderId(null);
        setConnectionIntent(null);
        setApiKeyValue('');
        setSelectedAuthOptionId(null);
        setOAuthProgress(null);
        setOAuthCodeValue('');
        activeOAuthOperationRef.current = null;
        activeOAuthPhaseRef.current = null;
        setSetupMetadata({});
        setSetupForm(null);
        setSetupFormError(null);
        setSetupFormErrorDiagnostics(null);
        setSetupSubmitError(null);
        setSetupSubmitErrorDiagnostics(null);
        const success = formatProviderConnectSuccess(connectedProvider);
        try {
          const externalRefreshResult = await options.onProviderChanged?.('connection');
          if (!isProjectContextCurrent(projectContext)) {
            return null;
          }
          const [viewRefreshed, directoryRefreshed] = await Promise.all([
            viewRequestedRef.current ? refresh({ silent: true }) : Promise.resolve(true),
            loadDirectoryPage({ refresh: true, cursor: null }),
          ]);
          if (externalRefreshResult === false || !viewRefreshed || !directoryRefreshed) {
            setError(null);
            setErrorDiagnostics(null);
            setDirectoryError(null);
            setDirectoryErrorDiagnostics(null);
            setSuccessMessage(null);
            setWarningMessage(formatPostOperationRefreshWarning(success));
          } else {
            setWarningMessage(null);
            setSuccessMessage(success);
          }
        } catch {
          if (!isProjectContextCurrent(projectContext)) {
            return null;
          }
          setError(null);
          setErrorDiagnostics(null);
          setDirectoryError(null);
          setDirectoryErrorDiagnostics(null);
          setSuccessMessage(null);
          setWarningMessage(formatPostOperationRefreshWarning(success));
        }
        return {
          status: 'connected',
          verifiedModelId: connectedProvider.verifiedModelId ?? null,
        };
      } catch (connectError) {
        const cancelled = recordUnsuccessfulConnection(connectError);
        if (!isProjectContextCurrent(projectContext)) {
          return null;
        }
        setSetupSubmitError(
          cancelled
            ? formatProviderConnectCancellation(setupForm.displayName)
            : connectError instanceof Error
              ? connectError.message
              : 'Failed to connect provider'
        );
        setSetupSubmitErrorDiagnostics(null);
        return cancelled ? { status: 'cancelled', verifiedModelId: null } : null;
      } finally {
        if (oauthOperationId) {
          cancelledOAuthOperationIdsRef.current.delete(oauthOperationId);
        }
        if (activeOAuthOperationRef.current === oauthOperationId) {
          activeOAuthOperationRef.current = null;
          activeOAuthPhaseRef.current = null;
        }
        if (isProjectContextCurrent(projectContext)) {
          setSavingProviderId(null);
        }
      }
    },
    [
      apiKeyValue,
      connectionIntent,
      getProjectContextSnapshot,
      isProjectContextCurrent,
      loadDirectoryPage,
      options,
      refresh,
      setupForm,
      setupFormError,
      setupFormErrorDiagnostics,
      setupMetadata,
      selectedAuthOptionId,
    ]
  );

  const forgetProvider = useCallback(
    async (providerId: string): Promise<void> => {
      setSavingProviderId(providerId);
      setError(null);
      setErrorDiagnostics(null);
      setSuccessMessage(null);
      setWarningMessage(null);
      const projectContext = getProjectContextSnapshot();
      try {
        const response = await withUiTimeout(
          api.runtimeProviderManagement.forgetCredential({
            runtimeId: options.runtimeId,
            providerId,
            projectPath: projectContext.path,
          }),
          'Provider forget timed out'
        );
        if (!isProjectContextCurrent(projectContext)) {
          return;
        }
        if (response.error) {
          setError(response.error.message);
          setErrorDiagnostics(response.error.diagnostics ?? null);
          return;
        }
        if (response.provider) {
          setView((current) => replaceProvider(current, response.provider!));
        }
        const success = formatCredentialRemovedMessage(response.provider ?? null);
        try {
          const externalRefreshResult = await options.onProviderChanged?.('credential_removed');
          if (!isProjectContextCurrent(projectContext)) {
            return;
          }
          const [viewRefreshed, directoryRefreshed] = await Promise.all([
            viewRequestedRef.current ? refresh({ silent: true }) : Promise.resolve(true),
            loadDirectoryPage({ refresh: true, cursor: null }),
          ]);
          if (externalRefreshResult === false || !viewRefreshed || !directoryRefreshed) {
            setError(null);
            setErrorDiagnostics(null);
            setDirectoryError(null);
            setDirectoryErrorDiagnostics(null);
            setSuccessMessage(null);
            setWarningMessage(formatPostOperationRefreshWarning(success));
          } else {
            setWarningMessage(null);
            setSuccessMessage(success);
          }
        } catch {
          if (!isProjectContextCurrent(projectContext)) {
            return;
          }
          setError(null);
          setErrorDiagnostics(null);
          setDirectoryError(null);
          setDirectoryErrorDiagnostics(null);
          setSuccessMessage(null);
          setWarningMessage(formatPostOperationRefreshWarning(success));
        }
        if (!isProjectContextCurrent(projectContext)) {
          return;
        }
      } catch (forgetError) {
        if (!isProjectContextCurrent(projectContext)) {
          return;
        }
        setError(
          forgetError instanceof Error ? forgetError.message : 'Failed to forget credential'
        );
        setErrorDiagnostics(null);
      } finally {
        if (isProjectContextCurrent(projectContext)) {
          setSavingProviderId(null);
        }
      }
    },
    [getProjectContextSnapshot, isProjectContextCurrent, loadDirectoryPage, options, refresh]
  );

  const openModelPicker = useCallback(
    (providerId: string, mode: RuntimeProviderModelPickerMode): void => {
      setSelectedProviderId(providerId);
      setActiveFormProviderId(null);
      setConnectionIntent(null);
      openModelPickerState(providerId, mode);
      setError(null);
      setErrorDiagnostics(null);
      setSuccessMessage(null);
      setWarningMessage(null);
    },
    [openModelPickerState]
  );

  const openProviderCredentialPage = useCallback(async (providerId: string): Promise<void> => {
    const credentialUrl = getRuntimeProviderCredentialUrl(providerId);
    if (credentialUrl) {
      await api.openExternal(credentialUrl);
    }
  }, []);

  const closeModelPicker = useCallback((): void => {
    closeModelPickerState();
  }, [closeModelPickerState]);

  const useModelForNewTeams = useCallback((modelId: string): void => {
    saveOpenCodeModelForNewTeams(modelId);
    setSelectedModelId(modelId);
    setSuccessMessage(null);
    setWarningMessage(null);
    setError(null);
    setErrorDiagnostics(null);
  }, []);

  const testModel = useCallback(
    async (providerId: string, modelId: string): Promise<RuntimeProviderModelTestResultDto> => {
      const probeGeneration = modelProbeGenerationRef.current;
      const activeProviderAtStart = activeModelPickerProviderRef.current;
      const projectContext = getProjectContextSnapshot();
      const shouldRecordProbeResult = (): boolean =>
        modelProbeGenerationRef.current === probeGeneration &&
        (activeProviderAtStart === null || activeModelPickerProviderRef.current === providerId) &&
        isProjectContextCurrent(projectContext);
      setTestingModelIds((current) =>
        current.includes(modelId) ? current : [...current, modelId]
      );
      setError(null);
      setErrorDiagnostics(null);
      setSuccessMessage(null);
      setWarningMessage(null);
      try {
        const response = await withUiTimeout(
          api.runtimeProviderManagement.testModel({
            runtimeId: options.runtimeId,
            providerId,
            modelId,
            projectPath: projectContext.path,
          }),
          'Model test timed out',
          100_000
        );
        if (response.error) {
          const result = buildFailedModelTestResult(providerId, modelId, response.error.message);
          if (response.error.diagnostics && shouldRecordProbeResult()) {
            setError(response.error.message);
            setErrorDiagnostics(response.error.diagnostics);
          }
          if (shouldRecordProbeResult()) {
            setModelResults((current) => ({
              ...current,
              [modelId]: result,
            }));
            setModels((current) =>
              current.map((model) => applyModelTestResultToModel(model, result))
            );
            setView((current) => applyModelTestResultToView(current, result));
          }
          return result;
        }
        if (response.result && shouldRecordProbeResult()) {
          const result = response.result;
          setModelResults((current) => ({
            ...current,
            [modelId]: result,
          }));
          setModels((current) =>
            current.map((model) => applyModelTestResultToModel(model, result))
          );
          setView((current) => applyModelTestResultToView(current, result));
        }
        return (
          response.result ??
          buildFailedModelTestResult(providerId, modelId, 'Model test response was empty')
        );
      } catch (testError) {
        const result = buildFailedModelTestResult(
          providerId,
          modelId,
          testError instanceof Error ? testError.message : 'Failed to test model'
        );
        if (shouldRecordProbeResult()) {
          setModelResults((current) => ({
            ...current,
            [modelId]: result,
          }));
          setModels((current) =>
            current.map((model) => applyModelTestResultToModel(model, result))
          );
          setView((current) => applyModelTestResultToView(current, result));
        }
        return result;
      } finally {
        if (shouldRecordProbeResult()) {
          setTestingModelIds((current) => current.filter((entry) => entry !== modelId));
        }
      }
    },
    [getProjectContextSnapshot, isProjectContextCurrent, options.runtimeId]
  );

  const setDefaultModel = useCallback(
    async (
      providerId: string,
      modelId: string,
      scope: RuntimeProviderDefaultScopeDto = 'project'
    ): Promise<void> => {
      setSavingDefaultModelId(modelId);
      setError(null);
      setErrorDiagnostics(null);
      setSuccessMessage(null);
      setWarningMessage(null);
      const projectContext = getProjectContextSnapshot();
      try {
        const response = await withUiTimeout(
          api.runtimeProviderManagement.setDefaultModel({
            runtimeId: options.runtimeId,
            providerId,
            modelId,
            probe: true,
            scope,
            projectPath: projectContext.path,
          }),
          'Set default model timed out',
          100_000
        );
        if (!isProjectContextCurrent(projectContext)) {
          return;
        }
        if (response.error) {
          setError(response.error.message);
          setErrorDiagnostics(response.error.diagnostics ?? null);
          return;
        }
        const proofResult: RuntimeProviderModelTestResultDto = {
          providerId,
          modelId,
          ok: true,
          availability: 'available',
          message: 'Model probe passed',
          diagnostics: [],
        };
        if (response.view) {
          setView(applyModelTestResultToView(response.view, proofResult));
        }
        const effectiveDefaultModelId = response.view?.defaultModel ?? modelId;
        setModelResults((current) => ({
          ...current,
          [modelId]: proofResult,
        }));
        setSelectedModelId(effectiveDefaultModelId);
        setModels((current) =>
          current.map((model) =>
            applyModelTestResultToModel(
              {
                ...model,
                default: model.modelId === effectiveDefaultModelId,
              },
              proofResult
            )
          )
        );
        const success =
          scope === 'all_projects'
            ? `All-projects OpenCode default set to ${modelId}`
            : `Project OpenCode default set to ${modelId}`;
        try {
          const externalRefreshResult = await options.onProviderChanged?.('configuration');
          if (!isProjectContextCurrent(projectContext)) {
            return;
          }
          if (externalRefreshResult === false) {
            setError(null);
            setErrorDiagnostics(null);
            setWarningMessage(formatPostOperationRefreshWarning(success));
          } else {
            setSuccessMessage(success);
          }
        } catch {
          if (!isProjectContextCurrent(projectContext)) {
            return;
          }
          setError(null);
          setErrorDiagnostics(null);
          setWarningMessage(formatPostOperationRefreshWarning(success));
        }
      } catch (defaultError) {
        if (!isProjectContextCurrent(projectContext)) {
          return;
        }
        setError(
          defaultError instanceof Error ? defaultError.message : 'Failed to set OpenCode default'
        );
        setErrorDiagnostics(null);
      } finally {
        if (isProjectContextCurrent(projectContext)) {
          setSavingDefaultModelId(null);
        }
      }
    },
    [getProjectContextSnapshot, isProjectContextCurrent, options]
  );

  const selectProvider = useCallback(
    (providerId: string): void => {
      setupFormRequestSeq.current += 1;
      setSelectedProviderId(providerId);
      setActiveFormProviderId(null);
      setConnectionIntent(null);
      setSetupForm(null);
      setSetupFormError(null);
      setSetupFormErrorDiagnostics(null);
      setSetupSubmitError(null);
      setSetupSubmitErrorDiagnostics(null);
      setSetupMetadata({});
      setApiKeyValue('');
      setSelectedAuthOptionId(null);
      setOAuthProgress(null);
      setOAuthCodeValue('');
      void cancelActiveOAuthBestEffort();
      if (activeModelPickerProviderRef.current !== providerId) {
        closeModelPickerState();
      }
    },
    [cancelActiveOAuthBestEffort, closeModelPickerState]
  );

  useEffect(() => {
    if (!options.enabled) {
      return;
    }

    const initialProviderId = options.initialProviderId?.trim();
    if (!initialProviderId) {
      return;
    }

    const initialAction = options.initialProviderAction ?? 'select';
    updateProviderQuery(initialProviderId);
    if (
      (initialAction === 'connect' || initialAction === 'reconnect') &&
      directorySupported &&
      !directoryLoaded &&
      !directoryError
    ) {
      return;
    }
    const initialKey = `${initialProviderId}:${initialAction}`;
    if (appliedInitialProviderRef.current === initialKey) {
      return;
    }

    appliedInitialProviderRef.current = initialKey;

    if (initialAction === 'connect' || initialAction === 'reconnect') {
      startConnection(initialProviderId, initialAction);
      return;
    }

    selectProvider(initialProviderId);
  }, [
    directoryError,
    directoryLoaded,
    directorySupported,
    options.enabled,
    options.initialProviderAction,
    options.initialProviderId,
    selectProvider,
    startConnection,
    updateProviderQuery,
  ]);

  const state = useMemo<RuntimeProviderManagementState>(
    () => ({
      view,
      providers: view?.providers ?? [],
      selectedProviderId,
      providerQuery,
      directoryLoading,
      directoryRefreshing,
      directoryError,
      directoryErrorDiagnostics,
      directoryEntries,
      directoryTotalCount,
      directoryNextCursor,
      directoryLoaded,
      directorySummary,
      directorySelectedProviderId,
      directorySupported,
      activeFormProviderId,
      connectionIntent,
      setupForm,
      setupFormLoading,
      setupFormError,
      setupFormErrorDiagnostics,
      setupSubmitError,
      setupSubmitErrorDiagnostics,
      setupMetadata,
      apiKeyValue,
      selectedAuthOptionId,
      oauthProgress,
      oauthCodeValue,
      modelPickerProviderId,
      modelPickerMode,
      modelQuery,
      models,
      modelsLoading,
      modelsLoadingMore,
      modelsTotalCount,
      modelsNextCursor,
      modelsError,
      modelsErrorDiagnostics,
      selectedModelId,
      testingModelIds,
      savingDefaultModelId,
      modelResults,
      loading,
      savingProviderId,
      error,
      errorDiagnostics,
      successMessage,
      warningMessage,
    }),
    [
      activeFormProviderId,
      connectionIntent,
      apiKeyValue,
      selectedAuthOptionId,
      oauthProgress,
      oauthCodeValue,
      setupForm,
      setupFormErrorDiagnostics,
      setupFormError,
      setupFormLoading,
      setupSubmitErrorDiagnostics,
      setupSubmitError,
      setupMetadata,
      directoryEntries,
      directoryError,
      directoryErrorDiagnostics,
      directoryLoaded,
      directorySummary,
      directoryLoading,
      directoryNextCursor,
      directoryRefreshing,
      directorySelectedProviderId,
      directorySupported,
      directoryTotalCount,
      error,
      errorDiagnostics,
      loading,
      modelPickerMode,
      modelPickerProviderId,
      modelQuery,
      modelResults,
      models,
      modelsErrorDiagnostics,
      modelsError,
      modelsLoading,
      modelsLoadingMore,
      modelsNextCursor,
      modelsTotalCount,
      providerQuery,
      savingDefaultModelId,
      savingProviderId,
      selectedModelId,
      selectedProviderId,
      successMessage,
      warningMessage,
      testingModelIds,
      view,
    ]
  );

  const actions = useMemo<RuntimeProviderManagementActions>(
    () => ({
      refresh,
      selectProvider,
      setProviderQuery: updateProviderQuery,
      loadMoreDirectory,
      refreshDirectory,
      selectDirectoryProvider,
      searchAllProviders,
      startConnect,
      startReconnect,
      cancelConnect,
      setApiKeyValue: updateApiKeyValue,
      setAuthOption,
      setSetupMetadataValue,
      setOAuthCodeValue,
      submitOAuthCode,
      submitConnect,
      forgetProvider,
      openProviderCredentialPage,
      openModelPicker,
      closeModelPicker,
      setModelQuery: updateModelQuery,
      loadMoreModels,
      selectModel: setSelectedModelId,
      useModelForNewTeams,
      testModel,
      setDefaultModel,
    }),
    [
      cancelConnect,
      closeModelPicker,
      forgetProvider,
      loadMoreDirectory,
      loadMoreModels,
      openProviderCredentialPage,
      openModelPicker,
      refresh,
      refreshDirectory,
      searchAllProviders,
      selectDirectoryProvider,
      selectProvider,
      setDefaultModel,
      setSetupMetadataValue,
      setAuthOption,
      startConnect,
      startReconnect,
      submitConnect,
      submitOAuthCode,
      testModel,
      updateApiKeyValue,
      updateModelQuery,
      updateProviderQuery,
      useModelForNewTeams,
    ]
  );

  return [state, actions];
}
