/** Existing promise-only Plugin/MCP APIs retain original context through success and error replies. */
export function createContextScopedExtensionApi<T extends object>(
  original: T,
  capture: () => () => boolean
): T {
  // contextBridge freezes its API groups; the wrapping target must own writable method copies.
  return new Proxy(
    { ...original },
    {
      get(_target, key) {
        const method = Reflect.get(original, key, original) as unknown;
        if (typeof method !== 'function') return method;
        return async (...args: unknown[]) => {
          const isCurrent = capture();
          if (!isCurrent()) throw new Error('Extensions context changed');
          try {
            const result: unknown = await Reflect.apply(method, original, args);
            if (!isCurrent()) throw new Error('Extensions context changed');
            return result;
          } catch (error) {
            if (!isCurrent()) throw new Error('Extensions context changed');
            throw error;
          }
        };
      },
    }
  );
}
