import { describe, expect, it } from 'vitest';

import {
  buildStallProgressMessage,
  buildStallWarningText,
  extractApiErrorSnippet,
  hasApiError,
  isAuthFailureWarning,
  isQuotaRetryMessage,
  normalizeApiRetryErrorMessage,
  toMarkdownCodeSafe,
} from '../TeamProvisioningOutputErrorPolicy';

describe('team provisioning output error policy', () => {
  it('classifies explicit auth warnings across CLI output sources', () => {
    expect(isAuthFailureWarning('Codex provider is not authenticated', 'stdout')).toBe(true);
    expect(isAuthFailureWarning('Please run /login first', 'assistant')).toBe(true);
    expect(isAuthFailureWarning('Run `claude auth login` to continue', 'probe')).toBe(true);
  });

  it('treats ambiguous 401 auth text as auth failure only for trusted sources', () => {
    const warning = 'API Error: 401 Unauthorized';

    expect(isAuthFailureWarning(warning, 'probe')).toBe(true);
    expect(isAuthFailureWarning(warning, 'stderr')).toBe(true);
    expect(isAuthFailureWarning(warning, 'pre-complete')).toBe(true);
    expect(isAuthFailureWarning(warning, 'stdout')).toBe(false);
    expect(isAuthFailureWarning(warning, 'assistant')).toBe(false);
  });

  it('detects API error markers and extracts markdown-safe snippets', () => {
    expect(hasApiError('runtime emitted api error: 429 model cooldown')).toBe(true);
    expect(hasApiError('{"type":"invalid_request_error","message":"bad request"}')).toBe(true);
    expect(hasApiError('ordinary warning')).toBe(false);

    const snippet = extractApiErrorSnippet(
      `${'x'.repeat(240)}api error: 429 cooldown \u0000 payload with \`\`\` fence`
    );

    expect(snippet).not.toBeNull();
    expect(snippet?.startsWith('x'.repeat(200))).toBe(true);
    expect(snippet).toContain('api error: 429 cooldown  payload with ``\\` fence');
    expect(snippet).not.toContain('\u0000');
    expect(extractApiErrorSnippet('before invalid_request_error after')).toBe(
      'before invalid_request_error after'
    );
    expect(extractApiErrorSnippet('no api marker here')).toBeNull();
  });

  it('normalizes retry error payloads without changing quota classification', () => {
    expect(
      normalizeApiRetryErrorMessage(
        '429 {"error":{"message":"api error: 429 quota will reset after 1h"}}'
      )
    ).toBe('quota will reset after 1h');
    expect(normalizeApiRetryErrorMessage('Gemini CLI Backend Error: resource exhausted')).toBe(
      'resource exhausted'
    );

    expect(isQuotaRetryMessage('Quota will reset after 1h')).toBe(true);
    expect(isQuotaRetryMessage('model cooldown in effect')).toBe(true);
    expect(isQuotaRetryMessage('RATE_LIMIT exceeded')).toBe(true);
    expect(isQuotaRetryMessage("You've hit your Cursor usage limit")).toBe(true);
    expect(isQuotaRetryMessage('grpc_code=RESOURCE_EXHAUSTED')).toBe(true);
    expect(isQuotaRetryMessage('{"grpcCode":8}')).toBe(true);
    expect(isQuotaRetryMessage('FreeUsageLimitError')).toBe(true);
    expect(isQuotaRetryMessage('RateLimitError')).toBe(true);
    expect(isQuotaRetryMessage('{"usage":{"input_tokens":8}}')).toBe(false);
    expect(isQuotaRetryMessage(undefined)).toBe(false);
    expect(isQuotaRetryMessage('authentication failed')).toBe(false);
  });

  it('wraps CLI snippets safely for markdown code fences', () => {
    expect(toMarkdownCodeSafe('a\u0000b\n\t```')).toBe('ab\n\t``\\`');
  });

  it('formats stall warnings and progress messages exactly', () => {
    expect(buildStallWarningText(20, {})).toBe(
      `---\n\n` +
        `**Waiting for CLI response** (silent for 20s)\n\n` +
        `The process is running but not producing output yet. Model responses can delay logs, ` +
        `and short waits like this are normal. The SDK also retries automatically if the ` +
        `request briefly hits rate limiting.\n\n` +
        `Waiting...`
    );

    expect(buildStallWarningText(90, {})).toBe(
      `---\n\n` +
        `**Waiting for CLI response** (silent for 1m 30s)\n\n` +
        `The process is still waiting for a model response. Logs can sometimes show up after ` +
        `1-1.5 minutes, and that is still okay. The SDK retries automatically if the ` +
        `request hits rate limiting (error 429 / model cooldown).\n\n` +
        `If there is still no output after 2 minutes, that starts to look unusual.\n\n` +
        `You can cancel and try again later if the wait continues.`
    );

    expect(buildStallWarningText(120, { model: 'claude-sonnet', effort: 'high' })).toBe(
      `---\n\n` +
        `**Extended CLI wait** (silent for 2m)\n\n` +
        `Model **claude-sonnet** (effort: high) is still waiting to respond. Some delay is normal, ` +
        `but no logs for 2m is already unusual.\n\n` +
        `Possible causes:\n` +
        `- Rate limiting / model cooldown (429) - SDK retries automatically\n` +
        `- API server overload for this model\n` +
        `- A stalled or delayed model response\n\n` +
        `Consider canceling and trying with a different model.`
    );

    expect(buildStallProgressMessage(119, '1m 59s')).toBe(
      'Waiting for model response for 1m 59s - logs can be delayed, this is still OK'
    );
    expect(buildStallProgressMessage(120, '2m')).toBe(
      'Still waiting for model response for 2m - this is unusual'
    );
  });
});
