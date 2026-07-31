import { readResponseTextWithLimit } from './boundedResponseBody';
import { buildOllamaNativeUrl, parseOllamaShowMetadata } from './ollamaRuntimeApi';

import type { RuntimeLocalProviderModelDto } from '../../contracts';

export async function filterOllamaCompletionModels(input: {
  readonly baseUrl: string;
  readonly models: readonly RuntimeLocalProviderModelDto[];
  readonly signal: AbortSignal;
  readonly fetchImpl: typeof fetch;
  readonly maxResponseBytes: number;
}): Promise<RuntimeLocalProviderModelDto[]> {
  const eligible = new Array<boolean>(input.models.length).fill(true);
  let nextIndex = 0;
  const workerCount = Math.min(8, input.models.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < input.models.length) {
        const index = nextIndex;
        nextIndex += 1;
        eligible[index] = await isOllamaCompletionModel({
          baseUrl: input.baseUrl,
          modelId: input.models[index].id,
          signal: input.signal,
          fetchImpl: input.fetchImpl,
          maxResponseBytes: input.maxResponseBytes,
        });
      }
    })
  );
  return input.models.filter((_model, index) => eligible[index]);
}

async function isOllamaCompletionModel(input: {
  readonly baseUrl: string;
  readonly modelId: string;
  readonly signal: AbortSignal;
  readonly fetchImpl: typeof fetch;
  readonly maxResponseBytes: number;
}): Promise<boolean> {
  try {
    const response = await input.fetchImpl(buildOllamaNativeUrl(input.baseUrl, '/api/show'), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: input.modelId }),
      redirect: 'error',
      signal: input.signal,
    });
    if (!response.ok) {
      return response.status < 400 || response.status >= 500;
    }
    const raw = await readResponseTextWithLimit(response, input.maxResponseBytes);
    if (!raw) return true;
    return parseOllamaShowMetadata(raw)?.completionCapable !== false;
  } catch {
    // Older or temporarily busy Ollama servers may not expose model metadata.
    // Keep the model visible and let launch verification decide compatibility.
    return true;
  }
}
