import { OpenCodeManagementError } from './OpenCodeManagementHost.js';
import { isConfiguredAuthless } from './openCodeConfiguredAuthless.js';
import { readProviderAuthMethods } from './readProviderAuthMethods.js';

import type { OpenCodeManagementClient } from './OpenCodeManagementHost.js';
import type { ProviderManagementCatalog } from '../../management/contracts.js';

const row = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OpenCodeManagementError('unavailable');
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 2048 || value.includes('\0'))
    throw new OpenCodeManagementError('unavailable');
  return value;
};
const positive = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

/** Drop provider options, credential values and unknown extensions before leaving Host. */
export async function readOpenCodeCatalog(
  client: OpenCodeManagementClient,
  binding: Pick<ProviderManagementCatalog, 'profileId' | 'configRevision'>,
  selectedProviderId?: string,
  includeModels = false
): Promise<ProviderManagementCatalog> {
  const [native, configured, auth, config] = await Promise.all([
    client.getProviders(),
    client.getConfigProviders(),
    client.getProviderAuth(),
    client.getConfig(),
  ]);
  if (
    !Array.isArray(native.all) ||
    !Array.isArray(native.connected) ||
    !Array.isArray(configured.providers) ||
    native.all.length > 1024 ||
    configured.providers.length > 1024
  )
    throw new OpenCodeManagementError('unavailable');
  const providerConfig = row(config).provider;
  const nativeConfigProviders = providerConfig === undefined ? {} : row(providerConfig);
  const connected = new Set(native.connected.map(text));
  const configuredIds = new Set(configured.providers.map((entry) => text(entry.id)));
  const entries = new Map<string, NonNullable<typeof native.all>[number]>();
  // Preserve configured-only native providers; the effective configured row takes precedence.
  for (const entry of [...native.all, ...configured.providers]) entries.set(text(entry.id), entry);
  let modelCount = 0;
  const providers: ProviderManagementCatalog['providers'] = [];
  for (const [providerId, entry] of entries) {
    if (selectedProviderId !== undefined && providerId !== selectedProviderId) continue;
    const nativeModels = Object.entries(entry.models ?? {});
    const models = (selectedProviderId === undefined && !includeModels ? [] : nativeModels).map(
      ([modelId, raw]) => {
        if (++modelCount > 4096) throw new OpenCodeManagementError('unavailable');
        const model = row(raw),
          limit = model.limit === undefined ? {} : row(model.limit);
        const cost = model.cost === undefined ? {} : row(model.cost);
        const costsKnown = ['input', 'output'].every(
          (key) =>
            typeof cost[key] === 'number' && Number.isFinite(cost[key]) && Number(cost[key]) >= 0
        );
        return {
          modelId: text(modelId),
          displayName: text(model.name ?? modelId),
          contextTokens: positive(limit.context),
          outputTokens: positive(limit.output),
          free: costsKnown ? cost.input === 0 && cost.output === 0 : null,
        };
      }
    );
    const methods = auth[providerId] ?? [];
    if (!Array.isArray(methods)) throw new OpenCodeManagementError('unavailable');
    const authMethods: ('api' | 'oauth')[] = [
      ...new Set(
        methods.flatMap((method) =>
          method.type === 'api' || method.type === 'oauth' ? [method.type as 'api' | 'oauth'] : []
        )
      ),
    ];
    providers.push({
      providerId,
      displayName: text(entry.name ?? providerId),
      source:
        entry.source === 'env' ||
        entry.source === 'api' ||
        entry.source === 'custom' ||
        entry.source === 'config'
          ? entry.source
          : null,
      connected: connected.has(providerId),
      configured: configuredIds.has(providerId),
      configuredAuthless:
        isConfiguredAuthless(entry) ||
        (Object.hasOwn(nativeConfigProviders, providerId) &&
          isConfiguredAuthless({ ...row(nativeConfigProviders[providerId]), id: providerId })),
      modelCount: nativeModels.length,
      defaultModelId:
        native.default?.[providerId] === undefined ? null : text(native.default[providerId]),
      models,
      authMethods,
      ...(selectedProviderId === undefined
        ? {}
        : { authOptions: readProviderAuthMethods(methods) }),
    });
  }
  const nativeModel = row(config).model;
  const configuredDefaultModelId =
    typeof nativeModel === 'string' && nativeModel.includes('/') ? text(nativeModel) : null;
  const result = { ...binding, configuredDefaultModelId, providers };
  if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024)
    throw new OpenCodeManagementError('unavailable');
  return result;
}
