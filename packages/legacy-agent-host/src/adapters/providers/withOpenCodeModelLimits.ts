import type { OpenCodeManagementProfile } from '../../management/profile.js';
import type { ProviderModelProbeLimits } from '../../management/contracts.js';

const record = (value: unknown): Record<string, unknown> => {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid native model config');
  return value as Record<string, unknown>;
};
export function withOpenCodeModelLimits(
  profile: OpenCodeManagementProfile,
  input: { providerId: string; modelId: string; limits: ProviderModelProbeLimits }
): OpenCodeManagementProfile {
  const config = record(JSON.parse(profile.environment.OPENCODE_CONFIG_CONTENT ?? '{}'));
  const providers = record(config.provider);
  const provider = record(
    Object.hasOwn(providers, input.providerId) ? providers[input.providerId] : undefined
  );
  const models = record(provider.models);
  const modelId = input.modelId.startsWith(input.providerId + '/')
    ? input.modelId.slice(input.providerId.length + 1)
    : input.modelId;
  const model = record(Object.hasOwn(models, modelId) ? models[modelId] : undefined);
  const next = {
    ...config,
    provider: {
      ...providers,
      [input.providerId]: {
        ...provider,
        models: {
          ...models,
          [modelId]: {
            ...model,
            limit: {
              context: input.limits.contextTokens,
              output: input.limits.outputTokens,
            },
          },
        },
      },
    },
  };
  return {
    ...profile,
    environment: { ...profile.environment, OPENCODE_CONFIG_CONTENT: JSON.stringify(next) },
  };
}
