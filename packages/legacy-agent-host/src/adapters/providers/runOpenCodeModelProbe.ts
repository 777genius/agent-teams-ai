import type { ProviderModelProbeLimits } from '../../management/contracts.js';
import type { OpenCodeClient } from '@agent-teams/provider-implementations/opencode';

export type OpenCodeProbeClient = Pick<
  OpenCodeClient,
  'getProviders' | 'getConfig' | 'listExperimentalToolIds' | 'createSession' | 'sendSessionMessage'
>;

/** Explicit no-tool model request. Auth/catalog presence alone cannot produce success. */
export async function runOpenCodeModelProbe(
  client: OpenCodeProbeClient,
  input: {
    providerId: string;
    modelId: string;
    cwd: string;
    variant?: string;
    limits?: ProviderModelProbeLimits;
    isCurrent?: () => boolean;
  }
): Promise<boolean> {
  const modelId = input.modelId.startsWith(input.providerId + '/')
    ? input.modelId.slice(input.providerId.length + 1)
    : input.modelId;
  const config = await client.getConfig();
  if (
    !config.permission ||
    Object.keys(config.permission).length !== 1 ||
    config.permission['*'] !== 'deny'
  )
    throw new Error('Model probe permission policy unavailable');
  const providers = await client.getProviders();
  if (
    !providers.all?.some(
      (provider) =>
        provider.id === input.providerId &&
        provider.models &&
        Object.hasOwn(provider.models, modelId)
    )
  )
    throw new Error('Model unavailable');
  if (input.variant !== undefined) {
    const model = providers.all?.find((row) => row.id === input.providerId)?.models?.[modelId];
    const variants =
      model && typeof model === 'object' ? (model as Record<string, unknown>).variants : null;
    if (
      !variants ||
      typeof variants !== 'object' ||
      Array.isArray(variants) ||
      !Object.hasOwn(variants, input.variant)
    )
      throw new Error('Model variant unavailable');
  }
  if (input.limits) {
    const provider = providers.all?.find((row) => row.id === input.providerId);
    const model = provider?.models?.[modelId];
    const limit =
      model && typeof model === 'object' ? (model as Record<string, unknown>).limit : null;
    if (
      !limit ||
      typeof limit !== 'object' ||
      (limit as Record<string, unknown>).context !== input.limits.contextTokens ||
      (limit as Record<string, unknown>).output !== input.limits.outputTokens ||
      (typeof (limit as Record<string, unknown>).input === 'number' &&
        Number((limit as Record<string, unknown>).input) > input.limits.contextTokens)
    )
      throw new Error('Native model limits were not applied');
  }
  const toolIds = await client.listExperimentalToolIds({ directory: input.cwd });
  if (
    !Array.isArray(toolIds) ||
    toolIds.length > 4096 ||
    toolIds.some((id) => typeof id !== 'string' || !id || id.length > 1024)
  )
    throw new Error('Tool policy unavailable');
  const tools = Object.fromEntries(['*', ...toolIds].map((id) => [id, false]));
  if (input.isCurrent && !input.isCurrent()) throw new Error('Model probe authority changed');
  const session = await client.createSession({ title: 'Agent Teams model connection test' });
  if (!session.id || typeof session.id !== 'string')
    throw new Error('Model probe session unavailable');
  if (input.isCurrent && !input.isCurrent()) throw new Error('Model probe authority changed');
  const message = await client.sendSessionMessage(session.id, {
    model: { providerID: input.providerId, modelID: modelId },
    tools,
    ...(input.variant === undefined ? {} : { variant: input.variant }),
    parts: [
      { type: 'text', text: 'Reply only OK. Do not use tools, access files or run commands.' },
    ],
  });
  const info = message.info;
  const time =
    info.time && typeof info.time === 'object' ? (info.time as Record<string, unknown>) : {};
  return (
    (input.isCurrent?.() ?? true) &&
    info.sessionID === session.id &&
    info.role === 'assistant' &&
    info.providerID === input.providerId &&
    info.modelID === modelId &&
    !info.error &&
    typeof time.completed === 'number' &&
    Number.isFinite(time.completed) &&
    Array.isArray(message.parts) &&
    !message.parts.some((part) => part.type === 'tool') &&
    message.parts.some(
      (part) => part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0
    )
  );
}
