import {
  HOSTED_MEMBER_LOG_MAX_PAGE_BYTES,
  HOSTED_MEMBER_LOG_MAX_PAGE_TIME_MS,
  HOSTED_MEMBER_LOG_PAGE_HTTP_PATH,
  HOSTED_MEMBER_LOG_SCHEMA_VERSION,
  type HostedMemberLogEntry,
  type HostedMemberLogPage,
  hostedMemberLogPageByteLength,
  parseHostedMemberLogEntryId,
  parseHostedMemberLogSelectionId,
  parseHostedMemberLogSourceGeneration,
} from '@features/member-log-stream/contracts/hosted';
import {
  createHostedMemberLogTransport,
  type HostedMemberLogHttpResponse,
} from '@features/member-log-stream/renderer/hosted';
import { parseMemberId, parseRevision, parseTeamId } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId(`team_${'c'.repeat(32)}`);
const memberId = parseMemberId(`member_${'d'.repeat(32)}`);
const revision = parseRevision('revision_member-log-transport');
const sourceGeneration = parseHostedMemberLogSourceGeneration('generation_member-log-transport');
const selectionId = parseHostedMemberLogSelectionId(`member_log_selection_${'e'.repeat(32)}`);
const csrfToken = 'a'.repeat(32);

function entry(index: number, text = `safe entry ${index}`): HostedMemberLogEntry {
  return {
    teamId,
    memberId,
    entryId: parseHostedMemberLogEntryId(`member_log_${index.toString(16).padStart(32, '0')}`),
    level: 'info',
    occurredAtMs: index,
    text,
  };
}

function page(entries: readonly HostedMemberLogEntry[] = [entry(1)]): HostedMemberLogPage {
  let usedBytes = 0;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate: HostedMemberLogPage = {
      schemaVersion: HOSTED_MEMBER_LOG_SCHEMA_VERSION,
      kind: 'member_log_page',
      selectionId,
      teamId,
      memberId,
      sourceGeneration,
      revision,
      entries,
      nextCursor: null,
      truncated: false,
      truncationReasons: [],
      budget: {
        itemLimit: 25,
        byteLimit: HOSTED_MEMBER_LOG_MAX_PAGE_BYTES,
        timeLimitMs: HOSTED_MEMBER_LOG_MAX_PAGE_TIME_MS,
        usedItems: entries.length,
        usedBytes,
        elapsedMs: 1,
      },
    };
    const measured = hostedMemberLogPageByteLength(candidate);
    if (measured === usedBytes) return candidate;
    usedBytes = measured;
  }
  throw new Error('member-log-test-page-byte-budget-did-not-converge');
}

function response(body: unknown, status = 200): HostedMemberLogHttpResponse {
  return { status, json: vi.fn(async () => body) };
}

function request() {
  return {
    schemaVersion: HOSTED_MEMBER_LOG_SCHEMA_VERSION,
    selectionId,
    cursor: null,
    expectedSourceGeneration: null,
    limit: 25,
  };
}

describe('hosted member-log transport', () => {
  it('uses only the feature-owned same-origin no-store route with an in-memory CSRF token', async () => {
    const fetch = vi.fn(async () => response(page()));
    const transport = createHostedMemberLogTransport({ fetch, getCsrfToken: () => csrfToken });

    await expect(transport.getPage(request())).resolves.toMatchObject({
      kind: 'success',
      page: { entries: [entry(1)] },
    });
    expect(fetch).toHaveBeenCalledWith(HOSTED_MEMBER_LOG_PAGE_HTTP_PATH, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-agent-teams-csrf': csrfToken,
      },
      body: JSON.stringify(request()),
    });
    expect(HOSTED_MEMBER_LOG_PAGE_HTTP_PATH).toMatch(/^\//);
  });

  it('rejects private fields and unredacted sensitive text before the renderer can receive it', async () => {
    const privateFieldFetch = vi.fn(async () =>
      response({ ...page(), entries: [{ ...entry(1), privateLocation: 'opaque-source-location' }] })
    );
    const privateFieldTransport = createHostedMemberLogTransport({
      fetch: privateFieldFetch,
      getCsrfToken: () => csrfToken,
    });
    await expect(privateFieldTransport.getPage(request())).resolves.toEqual({
      kind: 'unavailable',
    });

    const secret = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('_');
    const unsafePage = page([{ ...entry(1), text: `token=${secret}` }]);
    const secretFetch = vi.fn(async () => response(unsafePage));
    const secretTransport = createHostedMemberLogTransport({
      fetch: secretFetch,
      getCsrfToken: () => csrfToken,
    });
    await expect(secretTransport.getPage(request())).resolves.toEqual({ kind: 'unavailable' });
  });

  it('maps only the typed stale-generation response and keeps missing tokens offline', async () => {
    const replacement = parseHostedMemberLogSourceGeneration('generation_member-log-replacement');
    const fetch = vi.fn(async () =>
      response(
        {
          schemaVersion: HOSTED_MEMBER_LOG_SCHEMA_VERSION,
          kind: 'error',
          error: { code: 'conflict', reason: 'stale_generation' },
          retryable: false,
          currentSourceGeneration: replacement,
        },
        409
      )
    );
    const transport = createHostedMemberLogTransport({ fetch, getCsrfToken: () => csrfToken });
    await expect(transport.getPage(request())).resolves.toEqual({
      kind: 'stale_generation',
      currentSourceGeneration: replacement,
    });

    const missingTokenFetch = vi.fn();
    const missingTokenTransport = createHostedMemberLogTransport({
      fetch: missingTokenFetch,
      getCsrfToken: () => null,
    });
    await expect(missingTokenTransport.getPage(request())).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(missingTokenFetch).not.toHaveBeenCalled();
  });

  it('fails closed when any error status, code, reason, retryability, or metadata tuple differs', async () => {
    const replacement = parseHostedMemberLogSourceGeneration('generation_member-log-replacement');
    const staleGeneration = {
      schemaVersion: HOSTED_MEMBER_LOG_SCHEMA_VERSION,
      kind: 'error',
      error: { code: 'conflict', reason: 'stale_generation' },
      retryable: false,
      currentSourceGeneration: replacement,
    };
    const cases: readonly { readonly status: number; readonly body: unknown }[] = [
      { status: 404, body: staleGeneration },
      {
        status: 409,
        body: { ...staleGeneration, error: { code: 'not_found', reason: 'stale_generation' } },
      },
      {
        status: 409,
        body: { ...staleGeneration, error: { code: 'conflict', reason: 'member_log_not_found' } },
      },
      { status: 409, body: { ...staleGeneration, retryable: true } },
      {
        status: 409,
        body: {
          schemaVersion: HOSTED_MEMBER_LOG_SCHEMA_VERSION,
          kind: 'error',
          error: { code: 'conflict', reason: 'stale_generation' },
          retryable: false,
        },
      },
      {
        status: 400,
        body: {
          schemaVersion: HOSTED_MEMBER_LOG_SCHEMA_VERSION,
          kind: 'error',
          error: { code: 'invalid_request', reason: 'member_log_page_request_invalid' },
          retryable: false,
          currentSourceGeneration: replacement,
        },
      },
      {
        status: 409,
        body: {
          ...staleGeneration,
          error: {
            code: 'conflict',
            reason: 'stale_generation',
            diagnosticId: 'member-log-diagnostic',
          },
        },
      },
      {
        status: 503,
        body: {
          schemaVersion: HOSTED_MEMBER_LOG_SCHEMA_VERSION,
          kind: 'error',
          error: {
            code: 'unavailable',
            reason: 'member_log_unavailable',
            retryAfterMs: 25,
          },
          retryable: false,
        },
      },
    ];

    for (const testCase of cases) {
      const transport = createHostedMemberLogTransport({
        fetch: vi.fn(async () => response(testCase.body, testCase.status)),
        getCsrfToken: () => csrfToken,
      });
      await expect(transport.getPage(request())).resolves.toEqual({ kind: 'unavailable' });
    }
  });

  it('does not start or retain a cancelled browser request', async () => {
    const fetch = vi.fn(async () => response(page()));
    const controller = new AbortController();
    controller.abort();
    const transport = createHostedMemberLogTransport({ fetch, getCsrfToken: () => csrfToken });

    await expect(transport.getPage(request(), { signal: controller.signal })).resolves.toEqual({
      kind: 'cancelled',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when an injected fetch port yields a malformed response', async () => {
    const fetch = vi.fn(async () => null as never);
    const transport = createHostedMemberLogTransport({ fetch, getCsrfToken: () => csrfToken });

    await expect(transport.getPage(request())).resolves.toEqual({ kind: 'unavailable' });
  });
});
