import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';

import { selectInitialProviderId } from '../../core/domain';
import {
  getOpenCodeModelForNewTeams,
  saveOpenCodeModelForNewTeams,
} from '../adapters/createTeamDefaultModelWriter';

import type {
  RuntimeProviderConnectionDto,
  RuntimeProviderDefaultScopeDto,
  RuntimeProviderDirectoryEntryDto,
  RuntimeProviderDirectoryFilterDto,
  RuntimeProviderManagementRuntimeId,
  RuntimeProviderManagementViewDto,
  RuntimeProviderModelDto,
  RuntimeProviderModelTestResultDto,
  RuntimeProviderSetupFormDto,
} from '@features/runtime-provider-management/contracts';

interface UseRuntimeProviderManagementOptions {
  runtimeId: RuntimeProviderManagementRuntimeId;
  enabled: boolean;
  projectPath?: string | null;
  initialProviderId?: string | null;
  initialProviderAction?: 'connect' | 'select' | null;
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
  directoryEntries: readonly RuntimeProviderDirectoryEntryDto[];
  directoryTotalCount: number | null;
  directoryNextCursor: string | null;
  directoryLoaded: boolean;
  directorySelectedProviderId: string | null;
  directorySupported: boolean;
  activeFormProviderId: string | null;
  setupForm: RuntimeProviderSetupFormDto | null;
  setupFormLoading: boolean;
  setupFormError: string | null;
  setupSubmitError: string | null;
  setupMetadata: Readonly<Record<string, string>>;
  apiKeyValue: string;
  modelPickerProviderId: string | null;
  modelPickerMode: RuntimeProviderModelPickerMode | null;
  modelQuery: string;
  models: readonly RuntimeProviderModelDto[];
  modelsLoading: boolean;
  modelsError: string | null;
  selectedModelId: string | null;
  testingModelIds: readonly string[];
  savingDefaultModelId: string | null;
  modelResults: Readonly<Record<string, RuntimeProviderModelTestResultDto>>;
  loading: boolean;
  savingProviderId: string | null;
  error: string | null;
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
  cancelConnect: () => void;
  setApiKeyValue: (value: string) => void;
  setSetupMetadataValue: (key: string, value: string) => void;
  submitConnect: (providerId: string) => Promise<void>;
  forgetProvider: (providerId: string) => Promise<void>;
  openModelPicker: (providerId: string, mode: RuntimeProviderModelPickerMode) => void;
  closeModelPicker: () => void;
  setModelQuery: (value: string) => void;
  selectModel: (modelId: string) => void;
  useModelForNewTeams: (modelId: string) => void;
  testModel: (providerId: string, modelId: string) => Promise<void>;
  setDefaultModel: (
    providerId: string,
    modelId: string,
    scope?: RuntimeProviderDefaultScopeDto
  ) => Promise<void>;
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
        reject(error);
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
  if (!provider || provider.state !== 'connected') {
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

export function useRuntimeProviderManagement(
  options: UseRuntimeProviderManagementOptions
): [RuntimeProviderManagementState, RuntimeProviderManagementActions] {
  const [view, setView] = useState<RuntimeProviderManagementViewDto | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [providerQuery, setProviderQuery] = useState('');
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryRefreshing, setDirectoryRefreshing] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [directoryEntries, setDirectoryEntries] = useState<
    readonly RuntimeProviderDirectoryEntryDto[]
  >([]);
  const [directoryTotalCount, setDirectoryTotalCount] = useState<number | null>(null);
  const [directoryNextCursor, setDirectoryNextCursor] = useState<string | null>(null);
  const [directoryQuery, setDirectoryQuery] = useState('');
  const [directoryLoaded, setDirectoryLoaded] = useState(false);
  const [directorySelectedProviderId, setDirectorySelectedProviderId] = useState<string | null>(
    null
  );
  const [directorySupported, setDirectorySupported] = useState(true);
  const [activeFormProviderId, setActiveFormProviderId] = useState<string | null>(null);
  const [setupForm, setSetupForm] = useState<RuntimeProviderSetupFormDto | null>(null);
  const [setupFormLoading, setSetupFormLoading] = useState(false);
  const [setupFormError, setSetupFormError] = useState<string | null>(null);
  const [setupSubmitError, setSetupSubmitError] = useState<string | null>(null);
  const [setupMetadata, setSetupMetadata] = useState<Record<string, string>>({});
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [modelPickerProviderId, setModelPickerProviderId] = useState<string | null>(null);
  const [modelPickerMode, setModelPickerMode] = useState<RuntimeProviderModelPickerMode | null>(
    null
  );
  const [modelQuery, setModelQuery] = useState('');
  const [models, setModels] = useState<readonly RuntimeProviderModelDto[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [testingModelIds, setTestingModelIds] = useState<readonly string[]>([]);
  const [savingDefaultModelId, setSavingDefaultModelId] = useState<string | null>(null);
  const [modelResults, setModelResults] = useState<
    Record<string, RuntimeProviderModelTestResultDto>
  >({});
  const [loading, setLoading] = useState(false);
  const [savingProviderId, setSavingProviderId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const viewLoadRequestSeq = useRef(0);
  const directoryRequestSeq = useRef(0);
  const setupFormRequestSeq = useRef(0);
  const modelLoadRequestSeq = useRef(0);
  const modelProbeGenerationRef = useRef(0);
  const activeModelPickerProviderRef = useRef<string | null>(null);
  const appliedInitialProviderRef = useRef<string | null>(null);
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
    setSelectedModelId(null);
    setModelResults({});
    setTestingModelIds([]);
  }, []);

  useEffect(() => {
    directoryRequestSeq.current += 1;
    setupFormRequestSeq.current += 1;
    modelLoadRequestSeq.current += 1;
    modelProbeGenerationRef.current += 1;
    setDirectoryEntries([]);
    setDirectoryTotalCount(null);
    setDirectoryNextCursor(null);
    setDirectoryError(null);
    setDirectorySelectedProviderId(null);
    setDirectoryLoaded(false);
    setSetupForm(null);
    setSetupFormLoading(false);
    setSetupFormError(null);
    setSetupSubmitError(null);
    setActiveFormProviderId(null);
    setApiKeyValue('');
    setSetupMetadata({});
    setModels([]);
    setModelsLoading(false);
    setModelsError(null);
    setSelectedModelId(null);
    setTestingModelIds([]);
    setSavingDefaultModelId(null);
    setModelResults({});
    setSuccessMessage(null);
  }, [currentProjectPath]);

  const refresh = useCallback(
    async (input: { silent?: boolean } = {}): Promise<void> => {
      if (!options.enabled) {
        return;
      }
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

      try {
        const response = await api.runtimeProviderManagement.loadProviderDirectory({
          runtimeId: options.runtimeId,
          projectPath: projectContext.path,
          query: query.trim() || null,
          filter,
          limit: 50,
          cursor,
          refresh: refreshDirectoryData,
        });
        if (!requestIsCurrent()) {
          return;
        }
        if (response.error) {
          setDirectoryError(response.error.message);
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
          return;
        }
        setDirectoryLoaded(true);
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
      directorySupported,
      getProjectContextSnapshot,
      isProjectContextCurrent,
      options.enabled,
      options.runtimeId,
    ]
  );

  useEffect(() => {
    if (!options.enabled) {
      viewLoadRequestSeq.current += 1;
      appliedInitialProviderRef.current = null;
      setProviderQuery('');
      setDirectoryLoading(false);
      setDirectoryRefreshing(false);
      setDirectoryError(null);
      setDirectoryEntries([]);
      setDirectoryTotalCount(null);
      setDirectoryNextCursor(null);
      setDirectoryQuery('');
      setDirectoryLoaded(false);
      setDirectorySelectedProviderId(null);
      setApiKeyValue('');
      setSetupMetadata({});
      setSetupForm(null);
      setSetupFormLoading(false);
      setSetupFormError(null);
      setSetupSubmitError(null);
      setActiveFormProviderId(null);
      closeModelPickerState();
      return;
    }
    void refresh();
  }, [closeModelPickerState, currentProjectPath, options.enabled, refresh]);

  useEffect(() => {
    if (!options.enabled || !directorySupported) {
      return;
    }

    const timeout = window.setTimeout(
      () => {
        void loadDirectoryPage({
          append: false,
          query: directoryQuery,
          filter: DEFAULT_DIRECTORY_FILTER,
          cursor: null,
        });
      },
      directoryLoaded ? 250 : 0
    );

    return () => window.clearTimeout(timeout);
  }, [directoryLoaded, directoryQuery, directorySupported, loadDirectoryPage, options.enabled]);

  useEffect(() => {
    if (!options.enabled || !modelPickerProviderId) {
      modelLoadRequestSeq.current += 1;
      setModelsLoading(false);
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
      (selectedDirectoryProvider?.state === 'connected' &&
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
      refresh({ silent: true }),
      loadDirectoryPage({
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
      setSetupSubmitError(null);
      setSetupMetadata({});
      setApiKeyValue('');

      const compactProvider = view?.providers.find(
        (provider) => provider.providerId === providerId
      );
      const directoryProvider = directoryEntries.find(
        (provider) => provider.providerId === providerId
      );
      const connected =
        compactProvider?.state === 'connected' || directoryProvider?.state === 'connected';
      const modelCount = compactProvider?.modelCount ?? directoryProvider?.modelCount ?? null;

      if (connected && modelCount !== 0) {
        openModelPickerState(providerId, 'use');
      } else {
        closeModelPickerState();
      }
    },
    [closeModelPickerState, directoryEntries, openModelPickerState, view]
  );

  const searchAllProviders = useCallback((query: string): void => {
    setDirectoryQuery(query);
    setDirectoryError(null);
    setDirectoryNextCursor(null);
  }, []);

  const startConnect = useCallback(
    (providerId: string): void => {
      setSelectedProviderId(providerId);
      setActiveFormProviderId(providerId);
      closeModelPickerState();
      setApiKeyValue('');
      setSetupMetadata({});
      setSetupForm(null);
      setSetupFormError(null);
      setSetupSubmitError(null);
      setSetupFormLoading(true);
      setError(null);
      setSuccessMessage(null);
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
            return;
          }
          setSetupForm(response.setupForm ?? null);
          if (!response.setupForm) {
            setSetupFormError('Provider setup form response was empty');
          }
        })
        .catch((setupError) => {
          if (!requestIsCurrent()) {
            return;
          }
          setSetupFormError(
            setupError instanceof Error ? setupError.message : 'Failed to load provider setup form'
          );
        })
        .finally(() => {
          if (requestIsCurrent()) {
            setSetupFormLoading(false);
          }
        });
    },
    [closeModelPickerState, getProjectContextSnapshot, isProjectContextCurrent, options.runtimeId]
  );

  const updateProviderQuery = useCallback(
    (value: string): void => {
      setProviderQuery(value);
      if (!directorySupported) {
        return;
      }
      setDirectoryQuery(value);
      setDirectoryNextCursor(null);
    },
    [directorySupported]
  );

  const cancelConnect = useCallback((): void => {
    setupFormRequestSeq.current += 1;
    setActiveFormProviderId(null);
    setApiKeyValue('');
    setSetupMetadata({});
    setSetupForm(null);
    setSetupFormLoading(false);
    setSetupFormError(null);
    setSetupSubmitError(null);
    setError(null);
  }, []);

  const updateApiKeyValue = useCallback((value: string): void => {
    setApiKeyValue(value);
    setSetupSubmitError(null);
  }, []);

  const setSetupMetadataValue = useCallback((key: string, value: string): void => {
    setSetupMetadata((current) => ({
      ...current,
      [key]: value,
    }));
    setSetupSubmitError(null);
  }, []);

  const submitConnect = useCallback(
    async (providerId: string): Promise<void> => {
      if (!setupForm) {
        setSetupSubmitError(setupFormError ?? 'Provider setup form is not loaded');
        return;
      }
      if (!setupForm.supported) {
        setSetupSubmitError(
          setupForm.disabledReason ?? 'Provider setup is not supported in the app'
        );
        return;
      }
      const apiKey = apiKeyValue.trim();
      if (setupForm.secret?.required && !apiKey) {
        setSetupSubmitError(`${setupForm.secret.label} is required`);
        return;
      }

      setSavingProviderId(providerId);
      setError(null);
      setSetupSubmitError(null);
      setSuccessMessage(null);
      const projectContext = getProjectContextSnapshot();
      try {
        const response = await withUiTimeout(
          api.runtimeProviderManagement.connectProvider({
            runtimeId: options.runtimeId,
            providerId,
            method: setupForm.method,
            apiKey: apiKey || null,
            metadata: setupMetadata,
            projectPath: projectContext.path,
          }),
          'Provider connect timed out'
        );
        if (!isProjectContextCurrent(projectContext)) {
          return;
        }
        if (response.error) {
          setSetupSubmitError(response.error.message);
          return;
        }
        if (response.provider) {
          setView((current) => replaceProvider(current, response.provider!));
        }
        setActiveFormProviderId(null);
        setSuccessMessage(null);
        setApiKeyValue('');
        setSetupMetadata({});
        setSetupForm(null);
        setSetupFormError(null);
        setSetupSubmitError(null);
        try {
          await options.onProviderChanged?.();
          if (!isProjectContextCurrent(projectContext)) {
            return;
          }
          await Promise.all([
            refresh({ silent: true }),
            loadDirectoryPage({ refresh: true, cursor: null }),
          ]);
        } catch (refreshError) {
          if (!isProjectContextCurrent(projectContext)) {
            return;
          }
          setError(
            refreshError instanceof Error ? refreshError.message : 'Failed to refresh providers'
          );
        }
      } catch (connectError) {
        if (!isProjectContextCurrent(projectContext)) {
          return;
        }
        setSetupSubmitError(
          connectError instanceof Error ? connectError.message : 'Failed to connect provider'
        );
      } finally {
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
      setupMetadata,
    ]
  );

  const forgetProvider = useCallback(
    async (providerId: string): Promise<void> => {
      setSavingProviderId(providerId);
      setError(null);
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
            refresh({ silent: true }),
            loadDirectoryPage({ refresh: true, cursor: null }),
          ]);
        } catch (refreshError) {
          if (!isProjectContextCurrent(projectContext)) {
            return;
          }
          setError(
            refreshError instanceof Error ? refreshError.message : 'Failed to refresh providers'
          );
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
      openModelPickerState(providerId, mode);
      setError(null);
      setSuccessMessage(null);
    },
    [openModelPickerState]
  );

  const closeModelPicker = useCallback((): void => {
    closeModelPickerState();
  }, [closeModelPickerState]);

  const useModelForNewTeams = useCallback((modelId: string): void => {
    saveOpenCodeModelForNewTeams(modelId);
    setSelectedModelId(modelId);
    setSuccessMessage(null);
    setError(null);
  }, []);

  const testModel = useCallback(
    async (providerId: string, modelId: string): Promise<void> => {
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
          if (shouldRecordProbeResult()) {
            const result = buildFailedModelTestResult(providerId, modelId, response.error.message);
            setModelResults((current) => ({
              ...current,
              [modelId]: result,
            }));
            setModels((current) =>
              current.map((model) => applyModelTestResultToModel(model, result))
            );
            setView((current) => applyModelTestResultToView(current, result));
          }
          return;
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
      } catch (testError) {
        if (shouldRecordProbeResult()) {
          const result = buildFailedModelTestResult(
            providerId,
            modelId,
            testError instanceof Error ? testError.message : 'Failed to test model'
          );
          setModelResults((current) => ({
            ...current,
            [modelId]: result,
          }));
          setModels((current) =>
            current.map((model) => applyModelTestResultToModel(model, result))
          );
          setView((current) => applyModelTestResultToView(current, result));
        }
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
      setSetupForm(null);
      setSetupFormError(null);
      setSetupSubmitError(null);
      setSetupMetadata({});
      setApiKeyValue('');
      if (activeModelPickerProviderRef.current !== providerId) {
        closeModelPickerState();
      }
    },
    [closeModelPickerState]
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
    const initialKey = `${initialProviderId}:${initialAction}`;
    if (appliedInitialProviderRef.current === initialKey) {
      return;
    }

    appliedInitialProviderRef.current = initialKey;
    updateProviderQuery(initialProviderId);

    if (initialAction === 'connect') {
      startConnect(initialProviderId);
      return;
    }

    selectProvider(initialProviderId);
  }, [
    options.enabled,
    options.initialProviderAction,
    options.initialProviderId,
    selectProvider,
    startConnect,
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
      directoryEntries,
      directoryTotalCount,
      directoryNextCursor,
      directoryLoaded,
      directorySelectedProviderId,
      directorySupported,
      activeFormProviderId,
      setupForm,
      setupFormLoading,
      setupFormError,
      setupSubmitError,
      setupMetadata,
      apiKeyValue,
      modelPickerProviderId,
      modelPickerMode,
      modelQuery,
      models,
      modelsLoading,
      modelsError,
      selectedModelId,
      testingModelIds,
      savingDefaultModelId,
      modelResults,
      loading,
      savingProviderId,
      error,
      successMessage,
    }),
    [
      activeFormProviderId,
      apiKeyValue,
      setupForm,
      setupFormError,
      setupFormLoading,
      setupSubmitError,
      setupMetadata,
      directoryEntries,
      directoryError,
      directoryLoaded,
      directoryLoading,
      directoryNextCursor,
      directoryRefreshing,
      directorySelectedProviderId,
      directorySupported,
      directoryTotalCount,
      error,
      loading,
      modelPickerMode,
      modelPickerProviderId,
      modelQuery,
      modelResults,
      models,
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
      cancelConnect,
      setApiKeyValue: updateApiKeyValue,
      setSetupMetadataValue,
      submitConnect,
      forgetProvider,
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
      openModelPicker,
      refresh,
      refreshDirectory,
      searchAllProviders,
      selectDirectoryProvider,
      selectProvider,
      setDefaultModel,
      setSetupMetadataValue,
      startConnect,
      submitConnect,
      testModel,
      updateApiKeyValue,
      updateProviderQuery,
      useModelForNewTeams,
    ]
  );

  return [state, actions];
}
