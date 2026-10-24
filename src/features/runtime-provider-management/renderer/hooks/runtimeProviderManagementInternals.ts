import type {
  RuntimeProviderModelDto,
  RuntimeProviderSetupAuthOptionDto,
  RuntimeProviderSetupFormDto,
} from '@features/runtime-provider-management/contracts';

export function mergeModelPages(
  current: readonly RuntimeProviderModelDto[],
  incoming: readonly RuntimeProviderModelDto[]
): readonly RuntimeProviderModelDto[] {
  const merged = new Map(current.map((model) => [model.modelId, model]));
  for (const model of incoming) {
    merged.set(model.modelId, model);
  }
  return [...merged.values()];
}

export function withUiTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 70_000
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

export function isProviderConnectCancellation(error: unknown): boolean {
  const value = (() => {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    if (!error || typeof error !== 'object') return '';
    const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
    const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
    return `${code} ${message}`;
  })().toLowerCase();

  return /cancel(?:l)?ed/.test(value) || /access[\s_-]denied/.test(value);
}

export function normalizeProjectContextPath(projectPath: string | null | undefined): string | null {
  return projectPath?.trim() || null;
}

export function resolveEffectiveDefaultModel(
  models: readonly RuntimeProviderModelDto[]
): string | null {
  return models.find((model) => model.default)?.modelId ?? null;
}

export function resolveSetupAuthOption(
  form: RuntimeProviderSetupFormDto,
  authOptionId: string | null
): RuntimeProviderSetupAuthOptionDto | null {
  if (!form.authOptions?.length) {
    return null;
  }
  return (
    form.authOptions.find((option) => option.id === authOptionId) ?? form.authOptions[0] ?? null
  );
}

/**
 * Selector fields for a connect request. A plain key option (no native method index and no
 * prompts) needs no selector: V1 then connects its first key option, which is the same option
 * the form showed, and the OpenCode V2 runtime refuses a key connect that carries a selector.
 * Without the id, V1 no longer rejects a form that went stale since it loaded; the connect
 * still uses the current first key option, and required prompts still fail there.
 */
export function buildSetupAuthSelector(option: RuntimeProviderSetupAuthOptionDto | null): {
  authMethodIndex?: number;
  authOptionId?: string;
} {
  if (!option) return {};
  if (option.method === 'api' && option.methodIndex === null && option.prompts.length === 0) {
    return {};
  }
  return {
    ...(option.methodIndex !== null ? { authMethodIndex: option.methodIndex } : {}),
    ...(option.id ? { authOptionId: option.id } : {}),
  };
}

export function createOAuthOperationId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) {
    return randomUuid;
  }
  if (!globalThis.crypto) {
    throw new Error('Secure random generation is unavailable for OAuth.');
  }
  const randomWords = new Uint32Array(4);
  globalThis.crypto.getRandomValues(randomWords);
  return `oauth-${Date.now()}-${[...randomWords].map((word) => word.toString(36)).join('-')}`;
}
