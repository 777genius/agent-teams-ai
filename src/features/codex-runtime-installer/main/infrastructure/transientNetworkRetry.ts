const NETWORK_MAX_ATTEMPTS = 3;
const NETWORK_RETRY_BASE_DELAY_MS = 1_000;
const TRANSIENT_ERROR_CODE =
  /^(?:ECONNRESET|EAI_AGAIN|ETIMEDOUT|UND_ERR_(?:BODY|CONNECT|HEADERS)_TIMEOUT)$/;

function isTransientNetworkError(error: unknown): boolean {
  let current = error;
  while (current && typeof current === 'object') {
    const candidate = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (
      candidate.name === 'AbortError' ||
      candidate.name === 'TimeoutError' ||
      (typeof candidate.code === 'string' && TRANSIENT_ERROR_CODE.test(candidate.code))
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export function shouldRetryTransientNetworkError(error: unknown, attempt: number): boolean {
  return attempt < NETWORK_MAX_ATTEMPTS && isTransientNetworkError(error);
}

export function getNetworkRetryDelayMs(attempt: number): number {
  return NETWORK_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
}
