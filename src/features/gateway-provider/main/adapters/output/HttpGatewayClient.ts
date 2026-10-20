import type { GatewayModelUsage } from '../../../core/application/usage';

export class GatewayHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly kind: 'http' | 'shape' = 'http'
  ) {
    super(message);
    this.name = 'GatewayHttpError';
  }
}

const REQUEST_TIMEOUT_MS = 20_000;

async function requestJson(input: {
  baseUrl: string;
  path: string;
  apiKey: string;
}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${input.baseUrl}${input.path}`, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new GatewayHttpError(
        `Gateway request failed (HTTP ${response.status}).`,
        response.status
      );
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new GatewayHttpError('Gateway returned invalid JSON.', response.status, 'shape');
    }
  } catch (error) {
    if (error instanceof GatewayHttpError) throw error;
    if ((error as Error).name === 'AbortError') {
      throw new GatewayHttpError('Gateway request timed out.');
    }
    throw new GatewayHttpError('Gateway is unreachable.');
  } finally {
    clearTimeout(timer);
  }
}

export async function probeGatewayModels(input: {
  baseUrl: string;
  apiKey: string;
}): Promise<string[]> {
  const payload = await requestJson({ ...input, path: '/v1/models' });
  const data =
    payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : null;
  if (!data) {
    throw new GatewayHttpError('Gateway model catalog is invalid.', undefined, 'shape');
  }
  const models = Array.from(
    new Set(
      data.flatMap((entry) => {
        const id = entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined;
        return typeof id === 'string' && id.trim() ? [id.trim()] : [];
      })
    )
  );
  return models.sort((left, right) => left.localeCompare(right));
}

function readNonNegativeNumber(
  record: Record<string, unknown>,
  key: string,
  options: { integer?: boolean } = {}
): number {
  const value = record[key];
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    (options.integer && !Number.isInteger(value))
  ) {
    throw new GatewayHttpError(`Gateway usage field "${key}" is invalid.`, undefined, 'shape');
  }
  return value;
}

export async function readGatewayUsageDay(input: {
  baseUrl: string;
  apiKey: string;
  day: string;
}): Promise<GatewayModelUsage[]> {
  const query = `start_date=${encodeURIComponent(input.day)}&end_date=${encodeURIComponent(input.day)}`;
  const payload = await requestJson({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    path: `/v1/usage?${query}`,
  });
  if (!payload || typeof payload !== 'object') {
    throw new GatewayHttpError('Gateway usage response is invalid.', undefined, 'shape');
  }
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.model_stats)) {
    throw new GatewayHttpError('Gateway usage statistics are unavailable.', undefined, 'shape');
  }
  return record.model_stats.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new GatewayHttpError('Gateway model usage entry is invalid.', undefined, 'shape');
    }
    const stat = entry as Record<string, unknown>;
    const model = typeof stat.model === 'string' ? stat.model.trim() : '';
    if (!model) {
      throw new GatewayHttpError('Gateway model usage entry has no model.', undefined, 'shape');
    }
    return {
      model,
      requests: readNonNegativeNumber(stat, 'requests', { integer: true }),
      inputTokens: readNonNegativeNumber(stat, 'input_tokens', { integer: true }),
      outputTokens: readNonNegativeNumber(stat, 'output_tokens', { integer: true }),
      cacheCreationTokens: readNonNegativeNumber(stat, 'cache_creation_tokens', { integer: true }),
      cacheReadTokens: readNonNegativeNumber(stat, 'cache_read_tokens', { integer: true }),
      totalTokens: readNonNegativeNumber(stat, 'total_tokens', { integer: true }),
      apiEquivalentUsd: readNonNegativeNumber(stat, 'cost'),
      billableUsd: readNonNegativeNumber(stat, 'actual_cost'),
    };
  });
}
