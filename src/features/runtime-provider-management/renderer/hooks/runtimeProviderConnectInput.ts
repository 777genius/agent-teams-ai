import {
  buildSetupAuthSelector,
  resolveSetupAuthOption,
} from './runtimeProviderManagementInternals';

import type {
  RuntimeProviderDirectoryEntryDto,
  RuntimeProviderManagementConnectInput,
  RuntimeProviderManagementErrorDiagnosticsDto,
  RuntimeProviderManagementRuntimeId,
  RuntimeProviderManagementViewDto,
  RuntimeProviderSetupAuthOptionDto,
  RuntimeProviderSetupFormDto,
} from '../../contracts';

/** Preserve the original form's captured routing token alongside the existing submitted fields. */
export function runtimeProviderConnectInput(
  input: Omit<RuntimeProviderManagementConnectInput, 'authMethodIndex' | 'authOptionId'> & {
    readonly authOption?: RuntimeProviderSetupAuthOptionDto | null;
  }
): RuntimeProviderManagementConnectInput {
  const { authOption, ...request } = input;
  return {
    ...request,
    ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
    ...buildSetupAuthSelector(authOption ?? null),
  };
}

/** Reuse the original explicit project and opaque owner token for related management requests. */
export function runtimeProviderContext(
  runtimeId: RuntimeProviderManagementRuntimeId,
  projectPath: string | null,
  connectionContextToken?: string
) {
  return { runtimeId, projectPath, ...(connectionContextToken ? { connectionContextToken } : {}) };
}

/** Preserve the existing connection-method hint when refreshing a captured sign-in form. */
export function runtimeProviderConnectedAuthHint(
  providerId: string,
  view: RuntimeProviderManagementViewDto | null,
  directory: readonly RuntimeProviderDirectoryEntryDto[]
) {
  return (
    view?.providers.find((provider) => provider.providerId === providerId)?.connectedAuthHint ??
    directory.find((provider) => provider.providerId === providerId)?.connectedAuthHint ??
    null
  );
}

/** Keep the original form validation together with its submitted method and secret. */
export function validateRuntimeProviderConnectForm(
  form: RuntimeProviderSetupFormDto | null,
  selectedAuthOptionId: string | null,
  apiKeyValue: string,
  setupFormError: string | null,
  setupFormErrorDiagnostics: RuntimeProviderManagementErrorDiagnosticsDto | null
) {
  if (!form)
    return {
      form: null,
      authOption: null,
      apiKey: '',
      error: setupFormError ?? 'Provider setup form is not loaded',
      diagnostics: setupFormErrorDiagnostics,
    };
  const authOption = resolveSetupAuthOption(form, selectedAuthOptionId);
  const apiKey = apiKeyValue.trim();
  const secret = authOption?.secret ?? form.secret;
  const error = !form.supported
    ? (form.disabledReason ?? 'Provider setup is not supported in the app')
    : authOption && !authOption.supported
      ? (authOption.disabledReason ?? 'This sign-in method is unavailable')
      : secret?.required && !apiKey
        ? `${secret.label} is required`
        : null;
  return { form, authOption, apiKey, error, diagnostics: null };
}
