export type AuthWarningSource = 'probe' | 'stdout' | 'stderr' | 'assistant' | 'pre-complete';

export interface TeamProvisioningStallWarningRequest {
  model?: string | null;
  effort?: string | null;
}

export function isAuthFailureWarning(text: string, source: AuthWarningSource): boolean {
  const lower = text.toLowerCase();
  const hasExplicitCliAuthSignal =
    lower.includes('not authenticated') ||
    lower.includes('not logged in') ||
    lower.includes('please run /login') ||
    lower.includes('missing api key') ||
    lower.includes('invalid api key') ||
    lower.includes('authentication failed') ||
    lower.includes('not configured for runtime use') ||
    lower.includes('set gemini_api_key') ||
    lower.includes('google adc credentials') ||
    lower.includes('google_cloud_project') ||
    lower.includes('codex provider is not authenticated') ||
    lower.includes('run `claude auth login`') ||
    lower.includes('claude auth login') ||
    lower.includes('claude-multimodel auth login');

  if (hasExplicitCliAuthSignal) {
    return true;
  }

  if (source === 'assistant' || source === 'stdout') {
    return false;
  }

  const hasAuthStatus401 =
    /api error:\s*401\b/i.test(text) ||
    /\b401 unauthorized\b/i.test(lower) ||
    (/(^|\D)401(\D|$)/.test(lower) &&
      (lower.includes('auth') || lower.includes('api') || lower.includes('login')));

  return (
    hasAuthStatus401 ||
    (lower.includes('unauthorized') &&
      (lower.includes('api') || lower.includes('auth') || lower.includes('login')))
  );
}

export function hasApiError(text: string): boolean {
  return /api error:\s*\d{3}\b/i.test(text) || /invalid_request_error/i.test(text);
}

export function sanitizeCliSnippet(text: string): string {
  // Remove control characters that often show up as binary noise in CLI error payloads.
  // Preserve newlines/tabs for readability.
  // eslint-disable-next-line no-control-regex, sonarjs/no-control-regex -- intentionally stripping control chars
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

export function normalizeApiRetryErrorMessage(text: string): string {
  const sanitized = sanitizeCliSnippet(text).trim();
  if (!sanitized) {
    return sanitized;
  }

  const jsonMatch = /^\d{3}\s+(\{[\s\S]*\})$/.exec(sanitized);
  const jsonCandidate = jsonMatch?.[1] ?? (sanitized.startsWith('{') ? sanitized : null);
  if (jsonCandidate) {
    try {
      const parsed = JSON.parse(jsonCandidate) as {
        error?: { message?: unknown };
        message?: unknown;
      };
      const nestedMessage =
        typeof parsed.error?.message === 'string'
          ? parsed.error.message
          : typeof parsed.message === 'string'
            ? parsed.message
            : null;
      if (nestedMessage) {
        return normalizeApiRetryErrorMessage(nestedMessage);
      }
    } catch {
      // Fall through to raw sanitized text.
    }
  }

  return sanitized
    .replace(/^gemini cli backend error:\s*/i, '')
    .replace(/^gemini api backend error:\s*/i, '')
    .replace(/^api error:\s*\d+\s*/i, '')
    .trim();
}

export function isQuotaRetryMessage(text: string | undefined): boolean {
  const lower = (text ?? '').toLowerCase();
  return (
    lower.includes('quota will reset after') ||
    lower.includes('exhausted your capacity on this model') ||
    lower.includes('resource exhausted') ||
    lower.includes('model cooldown') ||
    lower.includes('cooling down') ||
    lower.includes('rate limit') ||
    lower.includes('rate_limit')
  );
}

export function toMarkdownCodeSafe(text: string): string {
  return sanitizeCliSnippet(text).replace(/```/g, '``\\`');
}

export function extractApiErrorSnippet(text: string): string | null {
  const match = /api error:\s*\d{3}\b/i.exec(text) ?? /invalid_request_error/i.exec(text);
  if (match?.index === undefined) return null;
  const start = Math.max(0, match.index - 200);
  const end = Math.min(text.length, match.index + 4000);
  const raw = text.slice(start, end).trim();
  if (!raw) return null;
  // Avoid breaking markdown fences if the payload contains ``` accidentally.
  return sanitizeCliSnippet(raw).replace(/```/g, '``\\`');
}

export function buildStallWarningText(
  silenceSec: number,
  request: TeamProvisioningStallWarningRequest
): string {
  const mins = Math.floor(silenceSec / 60);
  const secs = silenceSec % 60;
  const elapsed = mins > 0 ? (secs > 0 ? `${mins}m ${secs}s` : `${mins}m`) : `${secs}s`;

  if (silenceSec < 60) {
    return (
      `---\n\n` +
      `**Waiting for CLI response** (silent for ${elapsed})\n\n` +
      `The process is running but not producing output yet. Model responses can delay logs, ` +
      `and short waits like this are normal. The SDK also retries automatically if the ` +
      `request briefly hits rate limiting.\n\n` +
      `Waiting...`
    );
  }

  if (silenceSec < 120) {
    return (
      `---\n\n` +
      `**Waiting for CLI response** (silent for ${elapsed})\n\n` +
      `The process is still waiting for a model response. Logs can sometimes show up after ` +
      `1-1.5 minutes, and that is still okay. The SDK retries automatically if the ` +
      `request hits rate limiting (error 429 / model cooldown).\n\n` +
      `If there is still no output after 2 minutes, that starts to look unusual.\n\n` +
      `You can cancel and try again later if the wait continues.`
    );
  }

  const modelName = request.model ?? 'default';
  const effortLabel = request.effort ? ` (effort: ${request.effort})` : '';

  return (
    `---\n\n` +
    `**Extended CLI wait** (silent for ${elapsed})\n\n` +
    `Model **${modelName}**${effortLabel} is still waiting to respond. Some delay is normal, ` +
    `but no logs for ${elapsed} is already unusual.\n\n` +
    `Possible causes:\n` +
    `- Rate limiting / model cooldown (429) - SDK retries automatically\n` +
    `- API server overload for this model\n` +
    `- A stalled or delayed model response\n\n` +
    `Consider canceling and trying with a different model.`
  );
}

export function buildStallProgressMessage(silenceSec: number, elapsed: string): string {
  if (silenceSec < 120) {
    return `Waiting for model response for ${elapsed} - logs can be delayed, this is still OK`;
  }
  return `Still waiting for model response for ${elapsed} - this is unusual`;
}
