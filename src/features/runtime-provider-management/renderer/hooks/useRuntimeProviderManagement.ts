import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';

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
  onProviderChanged?: () => Promise<void> | void;
}

export type RuntimeProviderModelPickerMode = 'use' | 'runtime-default';

const DEFAULT_DIRECTORY_FILTER: RuntimeProviderDirectoryFilterDto = 'all';

interface ProjectContextSnapshot {
  path: string | null;
  generation: number;
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
}

export interface RuntimeProviderManagementActions {
  refresh: () => Promise<void>;
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
  const [models, setModels] = useState<readonly RuntimeProviderModelDto[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
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
      setModels([]);
      setModelsLoading(false);
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
    setModels([]);
    setModelsLoading(false);
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
    setModelsError(null);
    setModelsErrorDiagnostics(null);
    setSelectedModelId(null);
    setTestingModelIds([]);
    setSavingProviderId(null);
    setSavingDefaultModelId(null);
    setModelResults({});
    setSuccessMessage(null);
  }, [cancelActiveOAuthBestEffort, currentProjectPath]);

  const refresh = useCallback(
    async (input: { silent?: boolean } = {}): Promise<void> => {
      if (!options.enabled) {
        return;
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
          return;
        }
        if (response.error) {
          if (!silent) {
            setView(null);
          }
          setError(response.error.message);
          setErrorDiagnostics(response.error.diagnostics ?? null);
          return;
        }
        const nextView = response.view ?? null;
        setView(nextView);
        setSelectedProviderId((current) => {
          if (current && nextView?.providers.some((provider) => provider.providerId === current)) {
            return current;
          }
          return selectInitialProviderId(nextView);
        });
      } catch (loadError) {
        if (!requestIsCurrent()) {
          return;
        }
        if (!silent) {
          setView(null);
        }
        setError(loadError instanceof Error ? loadError.message : 'Failed to load providers');
        setErrorDiagnostics(null);
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
    ): Promise<void> => {
      if (!options.enabled || !directorySupported) {
        return;
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
          return;
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
          return;
        }
        const directory = response.directory;
        if (!directory) {
          setDirectoryError('Provider directory response was empty');
          setDirectoryErrorDiagnostics(null);
          return;
        }
        setDirectoryLoaded(true);
        setDirectorySummary(summary);
        setDirectoryTotalCount(directory.totalCount);
        setDirectoryNextCursor(directory.nextCursor);
        setDirectoryEntries((current) =>
          append ? [...current, ...directory.entries] : directory.entries
        );
      } catch (loadError) {
        if (requestIsCurrent()) {
          setDirectoryError(
            loadError instanceof Error ? loadError.message : 'Failed to load provider directory'
          );
          setDirectoryErrorDiagnostics(null);
        }
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
      setOAuthProgress(event);
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
      modelLoadRequestSeq.current += 1;
      setModelsLoading(false);
      setModelsErrorDiagnostics(null);
      return;
    }

    const requestSeq = modelLoadRequestSeq.current + 1;
    modelLoadRequestSeq.current = requestSeq;
    const providerId = modelPickerProviderId;
    const projectContext = getProjectContextSnapshot();
    const requestIsCurrent = (): boolean =>
      modelLoadRequestSeq.current === requestSeq &&
      activeModelPickerProviderRef.current === providerId &&
      isProjectContextCurrent(projectContext);
    let cancelled = false;
    setModelsLoading(true);
    setModelsError(null);
    setModelsErrorDiagnostics(null);
    void withUiTimeout(
      api.runtimeProviderManagement.loadModels({
        runtimeId: options.runtimeId,
        providerId,
        projectPath: projectContext.path,
        query: modelQuery.trim() || null,
        limit: 250,
      }),
      'Provider models load timed out'
    )
      .then((response) => {
        if (cancelled || !requestIsCurrent()) {
          return;
        }
        if (response.error) {
          setModels([]);
          setModelsError(response.error.message);
          setModelsErrorDiagnostics(response.error.diagnostics ?? null);
          return;
        }
        const nextModels = response.models?.models ?? [];
        setModels(nextModels);
        setSelectedModelId((current) => {
          if (current && nextModels.some((model) => model.modelId === current)) {
            return current;
          }
          return resolveSavedModelForNewTeams(nextModels);
        });
      })
      .catch((modelsLoadError) => {
        if (!cancelled && requestIsCurrent()) {
          setModels([]);
          setModelsError(
            modelsLoadError instanceof Error
              ? modelsLoadError.message
              : 'Failed to load provider models'
          );
          setModelsErrorDiagnostics(null);
        }
      })
      .finally(() => {
        if (!cancelled && requestIsCurrent()) {
          setModelsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    getProjectContextSnapshot,
    isProjectContextCurrent,
    modelPickerProviderId,
    modelQuery,
    options.enabled,
    options.runtimeId,
  ]);

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

  const refreshDirectory = useCallback(async (): Promise<void> => {
    setSuccessMessage(null);
    await Promise.all([
      viewRequestedRef.current ? refresh({ silent: true }) : Promise.resolve(),
      loadDirectoryPage({
        summary: false,
        refresh: true,
        cursor: null,
      }),
    ]);
  }, [loadDirectoryPage, refresh]);

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
          setSetupForm(response.setupForm ?? null);
          setSelectedAuthOptionId(
            response.setupForm
              ? selectRuntimeProviderSetupAuthOptionId({
                  form: response.setupForm,
                  intent,
                  connectedAuthHint,
                })
              : null
          );
          if (!response.setupForm) {
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
      void cancellation.then(() => onProviderChanged?.()).catch(() => undefined);
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
      const projectContext = getProjectContextSnapshot();
      const method = authOption?.method ?? setupForm.method;
      const oauthOperationId = method === 'oauth' ? createOAuthOperationId() : null;
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
          method === 'oauth' ? 370_000 : 100_000
        );
        if (!isProjectContextCurrent(projectContext)) {
          return null;
        }
        if (response.error) {
          setSetupSubmitError(response.error.message);
          setSetupSubmitErrorDiagnostics(response.error.diagnostics ?? null);
          return null;
        }
        if (response.provider) {
          setView((current) => replaceProvider(current, response.provider!));
          setDirectoryEntries((current) =>
            replaceDirectoryProvider(
              current,
              response.provider!,
              method === 'manual' ? null : method
            )
          );
        }
        setActiveFormProviderId(null);
        setConnectionIntent(null);
        setSuccessMessage(null);
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
        try {
          await options.onProviderChanged?.();
          if (!isProjectContextCurrent(projectContext)) {
            return null;
          }
          await Promise.all([
            viewRequestedRef.current ? refresh({ silent: true }) : Promise.resolve(),
            loadDirectoryPage({ refresh: true, cursor: null }),
          ]);
        } catch (refreshError) {
          if (!isProjectContextCurrent(projectContext)) {
            return null;
          }
          setError(
            refreshError instanceof Error ? refreshError.message : 'Failed to refresh providers'
          );
          setErrorDiagnostics(null);
        }
        return { verifiedModelId: response.provider?.verifiedModelId ?? null };
      } catch (connectError) {
        if (!isProjectContextCurrent(projectContext)) {
          return null;
        }
        setSetupSubmitError(
          connectError instanceof Error ? connectError.message : 'Failed to connect provider'
        );
        setSetupSubmitErrorDiagnostics(null);
        return null;
      } finally {
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
          await options.onProviderChanged?.();
          if (!isProjectContextCurrent(projectContext)) {
            return;
          }
          await Promise.all([
            viewRequestedRef.current ? refresh({ silent: true }) : Promise.resolve(),
            loadDirectoryPage({ refresh: true, cursor: null }),
          ]);
        } catch (refreshError) {
          if (!isProjectContextCurrent(projectContext)) {
            return;
          }
          setError(
            refreshError instanceof Error ? refreshError.message : 'Failed to refresh providers'
          );
          setErrorDiagnostics(null);
        }
        if (!isProjectContextCurrent(projectContext)) {
          return;
        }
        setSuccessMessage(success);
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
        setSuccessMessage(
          scope === 'all_projects'
            ? `All-projects OpenCode default set to ${modelId}`
            : `Project OpenCode default set to ${modelId}`
        );
        await options.onProviderChanged?.();
        if (!isProjectContextCurrent(projectContext)) {
          return;
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
      providerQuery,
      savingDefaultModelId,
      savingProviderId,
      selectedModelId,
      selectedProviderId,
      successMessage,
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
      setModelQuery,
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
      updateProviderQuery,
      useModelForNewTeams,
    ]
  );

  return [state, actions];
}
