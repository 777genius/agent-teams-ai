import type { RuntimeProviderManagementState } from './useRuntimeProviderManagement';

/**
 * Hide all scope-derived data synchronously during a project transition.
 * Effects clear stale state after commit, but cannot prevent a render-time flash.
 */
export function maskRuntimeProviderStateForScope(
  state: RuntimeProviderManagementState
): RuntimeProviderManagementState {
  return {
    ...state,
    view: null,
    providers: [],
    selectedProviderId: null,
    directoryEntries: [],
    directoryLoaded: false,
    directoryLoading: false,
    directoryRefreshing: false,
    directoryTotalCount: null,
    directoryNextCursor: null,
    directorySelectedProviderId: null,
    directoryError: null,
    directoryErrorDiagnostics: null,
    activeFormProviderId: null,
    connectionIntent: null,
    setupForm: null,
    setupFormLoading: false,
    setupFormError: null,
    setupFormErrorDiagnostics: null,
    setupSubmitError: null,
    setupSubmitErrorDiagnostics: null,
    setupMetadata: {},
    apiKeyValue: '',
    selectedAuthOptionId: null,
    oauthProgress: null,
    oauthCodeValue: '',
    modelPickerProviderId: null,
    models: [],
    modelsError: null,
    modelsErrorDiagnostics: null,
    selectedModelId: null,
    modelResults: {},
    warningMessage: null,
    successMessage: null,
    error: null,
    errorDiagnostics: null,
  };
}
