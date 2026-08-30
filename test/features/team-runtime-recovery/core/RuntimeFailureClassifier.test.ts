import {
  classifyRuntimeFailure,
  extractRuntimeFailureStatusCode,
} from '@features/team-runtime-recovery';
import { describe, expect, it } from 'vitest';

import type { RuntimeFailureSignal } from '@features/team-runtime-recovery';

function signal(overrides: Partial<RuntimeFailureSignal> = {}): RuntimeFailureSignal {
  return {
    id: 'failure-1',
    source: 'agent_error_mailbox',
    phase: 'terminal',
    observedAt: '2026-07-16T10:00:00.000Z',
    contextId: 'local',
    teamName: 'test-team',
    memberName: 'bob',
    targetKind: 'member',
    detail: 'API Error: 529 overloaded_error',
    ...overrides,
  };
}

describe('classifyRuntimeFailure', () => {
  it.each([
    ['API Error: 529 overloaded_error', undefined, 'provider_overloaded', 'retry_transient'],
    [
      'bob hit an error. API Error: API Error: 529 {"type":"overloaded_error"}',
      undefined,
      'provider_overloaded',
      'retry_transient',
    ],
    ['API Error: 502 bad gateway', undefined, 'backend_error', 'retry_transient'],
    ['API Error: 503 service unavailable', undefined, 'provider_overloaded', 'retry_transient'],
    ['API Error: 504 gateway timeout', undefined, 'backend_error', 'retry_transient'],
    ['API Error: 408 request timeout', undefined, 'request_timeout', 'retry_transient'],
    ['API Error: 409 lock timeout', undefined, 'request_conflict', 'retry_transient'],
    ['APIConnectionError: ECONNRESET', undefined, 'network_error', 'retry_transient'],
    ['Codex native exec timed out', undefined, 'codex_native_timeout', 'retry_transient'],
    ['API Error: 400 invalid request', undefined, 'client_error', 'manual'],
    ['API Error: 404 model not found', undefined, 'client_error', 'manual'],
    ['API Error: 422 invalid input', undefined, 'client_error', 'manual'],
    ['API Error: 401 invalid API key', undefined, 'auth_error', 'manual'],
    ['API Error: 403 forbidden', undefined, 'auth_error', 'manual'],
    ['stream error: refresh_token_reused', undefined, 'auth_error', 'manual'],
    ['run codex_login to continue', undefined, 'auth_error', 'manual'],
    ['ENOSPC: no space left on device', undefined, 'filesystem_error', 'manual'],
    ['unexpected tool execution error', undefined, 'unknown', 'manual'],
  ] as const)('%s => %s/%s', (detail, statusCode, reasonCode, disposition) => {
    expect(classifyRuntimeFailure(signal({ detail, statusCode }))).toMatchObject({
      reasonCode,
      disposition,
    });
  });

  it('classifies codex refresh-token failures as auth errors even when redaction erases the marker', () => {
    // The secret redactor rewrites "token: <word>" sequences, so the phrase
    // "Failed to refresh token:" no longer exists in normalizedDetail — the
    // classifier must match the raw detail to avoid an endless retry loop.
    const classified = classifyRuntimeFailure(
      signal({ detail: 'Failed to refresh token: unexpected status 400 Bad Request' })
    );
    expect(classified).toMatchObject({
      reasonCode: 'auth_error',
      disposition: 'manual',
      actionRequired: true,
    });
  });

  it.each([
    ['Failed to refresh token: API Error: 503', 'provider_overloaded', 'retry_transient'],
    ['Failed to refresh token: API Error: 500 internal error', 'backend_error', 'retry_transient'],
    ['Failed to refresh token: API Error: 429 too many requests', 'rate_limited', 'manual'],
    ['Failed to refresh token: fetch failed', 'network_error', 'retry_transient'],
    ['Failed to refresh token: ETIMEDOUT', 'network_error', 'retry_transient'],
  ] as const)(
    'keeps a transient refresh-endpoint outage recoverable: %s => %s/%s',
    (detail, reasonCode, disposition) => {
      // A bare "failed to refresh token" carrying transient transport evidence is an
      // outage of the refresh endpoint, not a dead grant. Classifying it as auth_error
      // would leave the teammate stranded with no recovery job.
      expect(classifyRuntimeFailure(signal({ detail }))).toMatchObject({
        reasonCode,
        disposition,
      });
    }
  );

  it('still classifies refresh-token reuse as terminal auth even behind a transient status', () => {
    // The kill-loop signature must stay terminal: re-running the same exec replays the
    // revoked refresh token and re-trips OpenAI's reuse detection.
    expect(
      classifyRuntimeFailure(
        signal({ detail: 'Failed to refresh token: refresh_token_reused (API Error: 503)' })
      )
    ).toMatchObject({
      reasonCode: 'auth_error',
      disposition: 'manual',
      actionRequired: true,
    });
  });

  it('observes active SDK retry without scheduling an outer retry', () => {
    expect(classifyRuntimeFailure(signal({ phase: 'sdk_retrying' }))).toMatchObject({
      disposition: 'observe_only',
    });
  });

  it('leaves protocol proof recovery to member-work-sync', () => {
    expect(
      classifyRuntimeFailure(signal({ detail: 'protocol_proof_missing: visible reply required' }))
    ).toMatchObject({
      reasonCode: 'protocol_proof_missing',
      disposition: 'observe_only',
    });
  });

  it('only schedules rate limits when a reliable reset is present', () => {
    expect(classifyRuntimeFailure(signal({ detail: 'API Error: 429 rate limit' }))).toMatchObject({
      reasonCode: 'rate_limited',
      disposition: 'manual',
    });
    expect(
      classifyRuntimeFailure(
        signal({ detail: 'API Error: 429 rate limit', resetAt: '2026-07-16T10:30:00.000Z' })
      )
    ).toMatchObject({
      reasonCode: 'rate_limited',
      disposition: 'retry_at_reset',
      retryAt: '2026-07-16T10:30:00.000Z',
    });
  });

  it('redacts secrets before the detail reaches persistence', () => {
    const classified = classifyRuntimeFailure(
      signal({
        detail:
          'API Error: 529 api_key=secret-value authorization: bearer private {"apiKey":"custom-private-value","authorization":"Bearer json-private"}',
      })
    );
    expect(classified.normalizedDetail).not.toContain('secret-value');
    expect(classified.normalizedDetail).not.toContain('private');
    expect(classified.normalizedDetail).not.toContain('custom-private-value');
    expect(classified.normalizedDetail).not.toContain('json-private');
    expect(classified.normalizedDetail).toContain('[redacted]');
  });

  it('extracts a nested human wrapper status code without anchoring', () => {
    expect(
      extractRuntimeFailureStatusCode('bob hit a mailbox error. API Error: API Error: 529 {...}')
    ).toBe(529);
  });

  it('extracts a structured provider status without confusing a four-digit provider code', () => {
    expect(
      classifyRuntimeFailure(
        signal({ detail: '{"error":{"status":529,"code":"1305","message":"overloaded"}}' })
      )
    ).toMatchObject({
      disposition: 'retry_transient',
      reasonCode: 'provider_overloaded',
      statusCode: 529,
    });
  });

  it.each([
    ['API Error: 529 capacity exceeded', 529, 'provider_overloaded', 'retry_transient'],
    ['API Error: 404 service unavailable', 404, 'client_error', 'manual'],
    ['API Error: 400 network error', 400, 'client_error', 'manual'],
  ] as const)(
    'uses the reliable HTTP status when text conflicts: %s',
    (detail, statusCode, reasonCode, disposition) => {
      expect(classifyRuntimeFailure(signal({ detail, statusCode }))).toMatchObject({
        reasonCode,
        disposition,
      });
    }
  );

  it('keeps explicit 429 under reset-aware rate-limit policy even with overload text', () => {
    expect(
      classifyRuntimeFailure(
        signal({
          detail: 'overloaded_error',
          statusCode: 429,
          resetAt: '2026-07-16T10:30:00.000Z',
        })
      )
    ).toMatchObject({
      reasonCode: 'rate_limited',
      disposition: 'retry_at_reset',
    });
  });
});
