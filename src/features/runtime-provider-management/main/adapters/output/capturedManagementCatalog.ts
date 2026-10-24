import type * as Dto from '../../../contracts';
import type {
  ProviderAuthenticationMethod,
  ProviderManagementCatalog,
} from '@agent-teams/legacy-agent-host/management/contracts';

export type CatalogProvider = ProviderManagementCatalog['providers'][number];

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid management response');
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 2048 || value.includes('\0'))
    throw new Error('Invalid management response');
  return value;
};
const positive = (value: unknown): number | null => {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error('Invalid management response');
  return value;
};
const nullableText = (value: unknown): string | null =>
  value === null ? null : value === '' ? '' : text(value);
function authOptions(value: unknown): ProviderAuthenticationMethod[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 128) throw new Error('Invalid management response');
  return value.map((raw): ProviderAuthenticationMethod => {
    const option = object(raw);
    if (
      !Number.isSafeInteger(option.methodIndex) ||
      Number(option.methodIndex) < 0 ||
      (option.type !== 'api' && option.type !== 'oauth') ||
      typeof option.supported !== 'boolean' ||
      !Array.isArray(option.prompts) ||
      option.prompts.length > 64
    )
      throw new Error('Invalid management response');
    return {
      methodIndex: Number(option.methodIndex),
      type: option.type,
      label: text(option.label),
      supported: option.supported,
      prompts: option.prompts.map((rawPrompt): ProviderAuthenticationMethod['prompts'][number] => {
        const prompt = object(rawPrompt),
          when = prompt.when === null ? null : object(prompt.when);
        if (
          (prompt.type !== 'text' && prompt.type !== 'select') ||
          !Array.isArray(prompt.options) ||
          prompt.options.length > 256
        )
          throw new Error('Invalid management response');
        return {
          key: text(prompt.key),
          type: prompt.type,
          label: text(prompt.label),
          placeholder: nullableText(prompt.placeholder),
          options: prompt.options.map((rawOption) => {
            const entry = object(rawOption);
            return {
              label: text(entry.label),
              value: text(entry.value),
              hint: nullableText(entry.hint),
            };
          }),
          when: when ? { key: text(when.key), op: text(when.op), value: text(when.value) } : null,
        };
      }),
    };
  });
}
export function managementValue(value: unknown): unknown {
  const result = object(value);
  if (result.ok !== true) throw new Error('Provider management outcome unavailable');
  return result.value;
}

/** Validate and allowlist the wire response; no backend/account/config metadata enters DTOs. */
export function parseManagementCatalog(
  value: unknown,
  target: { profileId: string; configRevision: string }
): CatalogProvider[] {
  const catalog = object(managementValue(value));
  if (
    catalog.profileId !== target.profileId ||
    catalog.configRevision !== target.configRevision ||
    !Array.isArray(catalog.providers) ||
    catalog.providers.length > 1024
  )
    throw new Error('Invalid management response');
  const providers = catalog.providers.map((raw): CatalogProvider => {
    const provider = object(raw);
    if (
      (provider.configuredAuthless !== undefined &&
        typeof provider.configuredAuthless !== 'boolean') ||
      typeof provider.connected !== 'boolean' ||
      typeof provider.configured !== 'boolean' ||
      !Number.isSafeInteger(provider.modelCount) ||
      Number(provider.modelCount) < 0 ||
      !Array.isArray(provider.models) ||
      provider.models.length > 4096 ||
      !Array.isArray(provider.authMethods) ||
      provider.authMethods.some((method) => method !== 'api' && method !== 'oauth') ||
      ![null, 'env', 'config', 'custom', 'api'].includes(provider.source as string | null)
    )
      throw new Error('Invalid management response');
    return {
      providerId: text(provider.providerId),
      displayName: text(provider.displayName),
      connected: provider.connected,
      configured: provider.configured,
      configuredAuthless: provider.configuredAuthless === true,
      modelCount: Number(provider.modelCount),
      source: provider.source as CatalogProvider['source'],
      defaultModelId: provider.defaultModelId === null ? null : text(provider.defaultModelId),
      authMethods: [...new Set(provider.authMethods)] as CatalogProvider['authMethods'],
      ...(provider.authOptions === undefined
        ? {}
        : { authOptions: authOptions(provider.authOptions) }),
      models: provider.models.map((rawModel) => {
        const model = object(rawModel);
        if (model.free !== null && typeof model.free !== 'boolean')
          throw new Error('Invalid management response');
        return {
          modelId: text(model.modelId),
          displayName: text(model.displayName),
          contextTokens: positive(model.contextTokens),
          outputTokens: positive(model.outputTokens),
          free: model.free,
        };
      }),
    };
  });
  if (new Set(providers.map((provider) => provider.providerId)).size !== providers.length)
    throw new Error('Invalid management response');
  return providers;
}

export function connection(provider: CatalogProvider): Dto.RuntimeProviderConnectionDto {
  const ownership: Dto.RuntimeProviderOwnershipDto[] =
    provider.source === 'env'
      ? ['env']
      : provider.source === 'config' || provider.source === 'custom'
        ? ['project']
        : provider.connected
          ? ['local']
          : [];
  return {
    providerId: provider.providerId,
    displayName: provider.displayName,
    state: provider.connected ? 'connected' : 'not-connected',
    ownership,
    recommended: false,
    modelCount: provider.modelCount,
    defaultModelId: provider.defaultModelId,
    authMethods: provider.authMethods,
    actions: [
      {
        id: 'connect',
        label: 'Connect',
        enabled: provider.authMethods.length > 0,
        disabledReason: provider.authMethods.length ? null : 'No native authentication method',
        requiresSecret: false,
        ownershipScope: 'runtime',
      },
      {
        id: 'forget',
        label: 'Forget credential',
        enabled: provider.connected,
        disabledReason: provider.connected ? null : 'No connected credential reported',
        requiresSecret: false,
        ownershipScope: 'local',
      },
    ],
    detail: provider.connected
      ? 'Native provider is connected; model execution has not been verified.'
      : null,
  };
}

export function directoryEntry(provider: CatalogProvider): Dto.RuntimeProviderDirectoryEntryDto {
  const row = connection(provider);
  return {
    ...row,
    setupKind: provider.connected
      ? 'connected'
      : provider.authMethods.includes('oauth')
        ? 'connect-oauth'
        : provider.authMethods.includes('api')
          ? 'connect-api-key'
          : 'configure-manually',
    sources: provider.configured ? ['opencode-provider', 'config-provider'] : ['opencode-provider'],
    sourceLabel: 'OpenCode',
    providerSource: provider.source,
    metadata: {
      hasKnownModels: provider.modelCount > 0,
      requiresManualConfig: !provider.authMethods.length,
      supportedInlineAuth: provider.authMethods.length > 0,
      configuredAuthless: provider.configuredAuthless === true,
    },
  };
}

/** Catalog/credential presence is never an execution proof, including free models. */
export function models(provider: CatalogProvider): Dto.RuntimeProviderModelDto[] {
  return provider.models.map((model) => ({
    modelId: model.modelId.startsWith(`${provider.providerId}/`)
      ? model.modelId
      : `${provider.providerId}/${model.modelId}`,
    providerId: provider.providerId,
    displayName: model.displayName,
    sourceLabel: 'OpenCode',
    free: model.free === true,
    default: false,
    availability: 'untested',
    routeKind: provider.configuredAuthless
      ? 'configured_local'
      : provider.connected
        ? 'connected_provider'
        : 'catalog_provider',
    proofState: 'needs_probe',
    requiresExecutionProof: true,
    catalogContextTokens: model.contextTokens,
    catalogOutputTokens: model.outputTokens,
  }));
}
