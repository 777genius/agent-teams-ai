import { getOpenCodeSourceDisplayName } from '@shared/utils/opencodeModelRef';

import type {
  RuntimeProviderConnectionDto,
  RuntimeProviderDirectoryEntryDto,
  RuntimeProviderManagementErrorDto,
  RuntimeProviderManagementViewDto,
  RuntimeProviderOAuthProgressDto,
  RuntimeProviderSetupFormDto,
} from '@features/runtime-provider-management/contracts';

export function presentProviderConnection(
  provider: RuntimeProviderConnectionDto
): RuntimeProviderConnectionDto {
  const displayName = getOpenCodeSourceDisplayName(provider.providerId, provider.displayName);
  return displayName === provider.displayName ? provider : { ...provider, displayName };
}

export function presentDirectoryEntry(
  provider: RuntimeProviderDirectoryEntryDto
): RuntimeProviderDirectoryEntryDto {
  const displayName = getOpenCodeSourceDisplayName(provider.providerId, provider.displayName);
  return displayName === provider.displayName ? provider : { ...provider, displayName };
}

export function presentManagementView(
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

export function presentSetupForm(
  form: RuntimeProviderSetupFormDto | null
): RuntimeProviderSetupFormDto | null {
  if (!form) return null;
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

export function presentOAuthProgress(
  event: RuntimeProviderOAuthProgressDto
): RuntimeProviderOAuthProgressDto {
  const displayName = getOpenCodeSourceDisplayName(event.providerId, event.displayName);
  return displayName === event.displayName ? event : { ...event, displayName };
}

export function replaceProvider(
  view: RuntimeProviderManagementViewDto | null,
  provider: RuntimeProviderConnectionDto
): RuntimeProviderManagementViewDto | null {
  if (!view) return view;
  return {
    ...view,
    providers: view.providers.map((entry) =>
      entry.providerId === provider.providerId ? provider : entry
    ),
  };
}

export function replaceDirectoryProvider(
  entries: readonly RuntimeProviderDirectoryEntryDto[],
  provider: RuntimeProviderConnectionDto,
  connectedMethod: 'api' | 'oauth' | null
): readonly RuntimeProviderDirectoryEntryDto[] {
  return entries.map((entry) => {
    if (entry.providerId !== provider.providerId) return entry;
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

export function formatProviderConnectError(
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
  if (
    normalizedMessage.includes('access denied by security policy') ||
    normalizedMessage.includes('forbidden')
  ) {
    return `${displayName} rejected the verification request because of an account or security policy. The new credential was not kept. Check the key permissions and account restrictions, then try again.`;
  }
  if (error.code === 'auth-failed') {
    return `${displayName} could not verify this credential with a real model request. The new credential was not kept.\n${error.message}`;
  }
  return error.message;
}

export function formatProviderConnectSuccess(provider: RuntimeProviderConnectionDto): string {
  return provider.verifiedModelId
    ? `${provider.displayName} connected and verified with ${provider.verifiedModelId}.`
    : `${provider.displayName} connected. Model execution was not verified during setup.`;
}

export function formatProviderConnectCancellation(displayName: string): string {
  return `${displayName} connection was cancelled. Your current credential was not changed.`;
}

export function formatPostOperationRefreshWarning(successMessage: string): string {
  return `${successMessage} The change is saved, but the latest provider status could not be refreshed. Refresh provider status to see the current state.`;
}

export function formatCredentialRemovedMessage(
  provider: RuntimeProviderConnectionDto | null
): string {
  if (provider?.state !== 'connected') return 'Credential removed';
  const ownership = new Set(provider.ownership);
  if (!ownership.has('managed') && ownership.has('local')) {
    return 'Managed credential removed. Provider remains connected through local OpenCode credentials.';
  }
  if (!ownership.has('managed') && ownership.size > 0) {
    return 'Managed credential removed. Provider remains connected through another credential source.';
  }
  return 'Credential removed';
}
