/** Diagnostic formatting must never interfere with physical ownership or pending cleanup. */
export function normalizePhysicalFault(error: unknown): string {
  const fallback = 'Physical completion is unconfirmed';
  try {
    if (error instanceof Error) {
      const message: unknown = error.message;
      if (typeof message === 'string' && message.length > 0) return message;
    }
    const message = String(error);
    return message || fallback;
  } catch {
    // Error getters, proxies and coercion hooks are arbitrary user code.
    return fallback;
  }
}
