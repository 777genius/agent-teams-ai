import type {
  RuntimeProviderActionDescriptorDto,
  RuntimeProviderActionIdDto,
  RuntimeProviderConnectionDto,
  RuntimeProviderManagementRuntimeDto,
  RuntimeProviderManagementViewDto,
} from '@features/runtime-provider-management/contracts';

const ACTION_ORDER: RuntimeProviderActionIdDto[] = [
  'connect',
  'use',
  'test',
  'set-default',
  'forget',
  'configure',
  'unignore',
];

export function getProviderAction(
  provider: RuntimeProviderConnectionDto,
  actionId: RuntimeProviderActionIdDto
): RuntimeProviderActionDescriptorDto | null {
  return provider.actions.find((action) => action.id === actionId) ?? null;
}

export function getPrimaryProviderAction(
  provider: RuntimeProviderConnectionDto
): RuntimeProviderActionDescriptorDto | null {
  for (const actionId of ACTION_ORDER) {
    const action = getProviderAction(provider, actionId);
    if (action) {
      return action;
    }
  }
  return provider.actions[0] ?? null;
}

export function canConnectWithApiKey(provider: RuntimeProviderConnectionDto): boolean {
  const connect = getProviderAction(provider, 'connect');
  return Boolean(
    connect?.enabled && connect.requiresSecret && provider.authMethods.includes('api')
  );
}

export function canForgetManagedCredential(provider: RuntimeProviderConnectionDto): boolean {
  const forget = getProviderAction(provider, 'forget');
  return Boolean(forget?.enabled);
}

export function selectInitialProviderId(
  view: RuntimeProviderManagementViewDto | null
): string | null {
  if (!view?.providers.length) {
    return null;
  }
  return (
    view.providers.find((provider) => provider.recommended && provider.state !== 'connected')
      ?.providerId ??
    view.providers.find((provider) => provider.state === 'connected')?.providerId ??
    view.providers[0]?.providerId ??
    null
  );
}

export function formatRuntimeState(runtime: RuntimeProviderManagementRuntimeDto): string {
  switch (runtime.state) {
    case 'ready':
      return 'Ready';
    case 'needs-auth':
      return 'Needs auth';
    case 'needs-setup':
      return 'Needs setup';
    case 'degraded':
      return 'Degraded';
  }
}

export function formatProviderState(provider: RuntimeProviderConnectionDto): string {
  switch (provider.state) {
    case 'connected':
      return 'Connected';
    case 'available':
      return 'Available';
    case 'not-connected':
      return 'Not connected';
    case 'ignored':
      return 'Ignored';
    case 'error':
      return 'Error';
  }
}

export function getProviderModelsLabel(provider: RuntimeProviderConnectionDto): string {
  if (provider.modelCount <= 0) {
    return 'Models not reported';
  }
  return `${provider.modelCount} model${provider.modelCount === 1 ? '' : 's'}`;
}
