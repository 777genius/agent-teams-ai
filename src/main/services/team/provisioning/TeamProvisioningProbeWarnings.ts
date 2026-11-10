/**
 * Classifies runtime/CLI probe warning strings so provisioning can tell a
 * transient hiccup (retryable) apart from a hard binary/launch failure.
 */

export function isTransientProbeWarning(warning: string): boolean {
  const lower = warning.toLowerCase();
  return (
    lower.includes('timeout running:') ||
    lower.includes('did not complete') ||
    lower.includes('runtime status was unavailable') ||
    lower.includes('runtime status check did not complete') ||
    lower.includes('timed out') ||
    lower.includes('etimedout') ||
    lower.includes('econnreset') ||
    lower.includes('eai_again')
  );
}

export function isBinaryProbeWarning(warning: string): boolean {
  const lower = warning.toLowerCase();
  return (
    (lower.includes('spawn ') && lower.includes(' enoent')) ||
    lower.includes('eacces') ||
    lower.includes('enoexec') ||
    lower.includes('bad cpu type in executable') ||
    lower.includes('image not found')
  );
}
