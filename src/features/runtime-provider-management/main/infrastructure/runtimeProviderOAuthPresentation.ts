import { sanitizeRuntimeProviderText } from './runtimeProviderModelTestBoundary';

const OAUTH_EVENT_INSTRUCTIONS_LIMIT = 1_000;
const OAUTH_INSTRUCTIONS_URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

export function sanitizeOAuthInstructions(value: string): string | null {
  const sanitized = sanitizeRuntimeProviderText(value)
    .replace(OAUTH_INSTRUCTIONS_URL_PATTERN, '[authorization link hidden]')
    .trim();
  if (!sanitized) {
    return null;
  }
  return sanitized.length > OAUTH_EVENT_INSTRUCTIONS_LIMIT
    ? `${sanitized.slice(0, OAUTH_EVENT_INSTRUCTIONS_LIMIT).trimEnd()}...`
    : sanitized;
}

export function isSafeOAuthAuthorizationUrl(value: string): boolean {
  if (!value || value.length > 8_192) {
    return false;
  }
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      return false;
    }
    if (url.protocol === 'https:') {
      return true;
    }
    return (
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1')
    );
  } catch {
    return false;
  }
}

export function getCopyableOAuthAuthorizationUrl(providerId: string, value: string): string | null {
  if (providerId !== 'github-copilot') {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.pathname.replace(/\/$/, '') === '/login/device' &&
      !url.username &&
      !url.password
      ? value
      : null;
  } catch {
    return null;
  }
}
