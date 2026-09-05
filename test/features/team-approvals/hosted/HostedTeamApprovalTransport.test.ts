import {
  HOSTED_TEAM_APPROVAL_DECISION_ROUTE,
  HOSTED_TEAM_APPROVAL_PAGE_ROUTE,
  HOSTED_TEAM_APPROVAL_PREVIEW_ROUTE,
  HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
  parseHostedTeamApprovalGeneration,
  parseHostedTeamApprovalId,
  parseHostedTeamApprovalIdempotencyKey,
  parseHostedTeamApprovalPreviewRef,
} from '@features/team-approvals/contracts';
import {
  createHostedTeamApprovalTransport,
  type HostedTeamApprovalFetchPort,
  type HostedTeamApprovalHttpResponse,
  type HostedTeamApprovalTransport,
} from '@features/team-approvals/renderer';
import { parseRunId, parseTeamId } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const runId = parseRunId(`run_${'d'.repeat(32)}`);
const approvalId = parseHostedTeamApprovalId(`approval_${'b'.repeat(32)}`);
const generation = parseHostedTeamApprovalGeneration('generation_transport-1');
const replacementGeneration = parseHostedTeamApprovalGeneration('generation_transport-2');
const previewRef = parseHostedTeamApprovalPreviewRef('approval_preview_transport-1');
const idempotencyKey = parseHostedTeamApprovalIdempotencyKey('approval-decision-transport-1');
const csrfToken = 'c'.repeat(43);

type Operation = 'page' | 'preview' | 'decision';

function pageRequest() {
  return {
    schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
    teamId,
    expectedRunId: runId,
    cursor: null,
    limit: 25,
  };
}

function previewRequest() {
  return {
    schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
    teamId,
    expectedRunId: runId,
    approvalId,
    expectedGeneration: generation,
    previewRef,
  };
}

function decisionCommand() {
  return {
    schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
    teamId,
    expectedRunId: runId,
    approvalId,
    expectedGeneration: generation,
    idempotencyKey,
    decision: 'allow' as const,
  };
}

function page() {
  return {
    schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
    kind: 'approval_page' as const,
    teamId,
    items: [],
    nextCursor: null,
    truncated: false,
    budget: {
      itemLimit: 25,
      byteLimit: 128 * 1024,
      timeLimitMs: 250,
      usedItems: 0,
      usedBytes: 0,
      elapsedMs: 1,
    },
  };
}

function preview() {
  return {
    schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
    kind: 'approval_preview' as const,
    teamId,
    runId,
    approvalId,
    generation,
    content: 'safe preview',
    byteLength: 12,
    truncated: false,
    isBinary: false,
  };
}

function receipt() {
  return {
    schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
    outcome: 'committed' as const,
    teamId,
    runId,
    approvalId,
    generation,
    decision: 'allow' as const,
  };
}

function successBody(operation: Operation): unknown {
  switch (operation) {
    case 'page':
      return page();
    case 'preview':
      return preview();
    case 'decision':
      return receipt();
  }
}

function response(status: number, body: unknown): HostedTeamApprovalHttpResponse {
  return Object.freeze({
    status,
    json: vi.fn(() => Promise.resolve(body)),
  });
}

function transportFor(
  httpResponse: HostedTeamApprovalHttpResponse,
  getCsrfToken: () => string | null = () => csrfToken
) {
  const fetch = vi.fn<HostedTeamApprovalFetchPort>(() => Promise.resolve(httpResponse));
  return {
    fetch,
    transport: createHostedTeamApprovalTransport({ fetch, getCsrfToken }),
  };
}

function invoke(
  transport: HostedTeamApprovalTransport,
  operation: Operation,
  signal?: AbortSignal
) {
  const options = signal === undefined ? undefined : { signal };
  switch (operation) {
    case 'page':
      return transport.getPage(pageRequest(), options);
    case 'preview':
      return transport.getPreview(previewRequest(), options);
    case 'decision':
      return transport.decide(decisionCommand(), options);
  }
}

function errorEnvelope(
  reason: string,
  metadata: {
    readonly retryAfterMs?: number;
    readonly currentGeneration?: typeof generation;
    readonly resolvedDecision?: 'allow' | 'deny';
  } = {}
) {
  const code = reason.endsWith('_invalid')
    ? 'invalid_request'
    : reason.endsWith('_not_found') || reason === 'team_not_found'
      ? 'not_found'
      : reason === 'team_approval_unavailable'
        ? 'unavailable'
        : 'conflict';
  return {
    schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
    kind: 'error' as const,
    error: {
      code,
      reason,
      ...(metadata.retryAfterMs === undefined ? {} : { retryAfterMs: metadata.retryAfterMs }),
    },
    retryable: code === 'unavailable',
    ...(metadata.currentGeneration === undefined
      ? {}
      : { currentGeneration: metadata.currentGeneration }),
    ...(metadata.resolvedDecision === undefined
      ? {}
      : { resolvedDecision: metadata.resolvedDecision }),
  };
}

const errorCases = [
  {
    operation: 'page',
    status: 400,
    reason: 'approval_page_request_invalid',
    body: errorEnvelope('approval_page_request_invalid'),
    expected: { kind: 'invalid_request' },
  },
  {
    operation: 'page',
    status: 404,
    reason: 'team_not_found',
    body: errorEnvelope('team_not_found'),
    expected: { kind: 'not_found' },
  },
  {
    operation: 'page',
    status: 503,
    reason: 'team_approval_unavailable',
    body: errorEnvelope('team_approval_unavailable', { retryAfterMs: 2_500 }),
    expected: { kind: 'unavailable', retryAfterMs: 2_500 },
  },
  {
    operation: 'preview',
    status: 400,
    reason: 'approval_preview_request_invalid',
    body: errorEnvelope('approval_preview_request_invalid'),
    expected: { kind: 'invalid_request' },
  },
  {
    operation: 'preview',
    status: 404,
    reason: 'approval_not_found',
    body: errorEnvelope('approval_not_found'),
    expected: { kind: 'not_found' },
  },
  {
    operation: 'preview',
    status: 409,
    reason: 'stale_generation',
    body: errorEnvelope('stale_generation', { currentGeneration: replacementGeneration }),
    expected: { kind: 'stale_generation', currentGeneration: replacementGeneration },
  },
  {
    operation: 'preview',
    status: 503,
    reason: 'team_approval_unavailable',
    body: errorEnvelope('team_approval_unavailable', { retryAfterMs: 2_500 }),
    expected: { kind: 'unavailable', retryAfterMs: 2_500 },
  },
  {
    operation: 'decision',
    status: 400,
    reason: 'approval_decision_invalid',
    body: errorEnvelope('approval_decision_invalid'),
    expected: { kind: 'invalid_request' },
  },
  {
    operation: 'decision',
    status: 404,
    reason: 'approval_not_found',
    body: errorEnvelope('approval_not_found'),
    expected: { kind: 'not_found' },
  },
  {
    operation: 'decision',
    status: 409,
    reason: 'stale_generation',
    body: errorEnvelope('stale_generation', { currentGeneration: replacementGeneration }),
    expected: { kind: 'stale_generation', currentGeneration: replacementGeneration },
  },
  {
    operation: 'decision',
    status: 409,
    reason: 'approval_already_resolved',
    body: errorEnvelope('approval_already_resolved', {
      currentGeneration: replacementGeneration,
      resolvedDecision: 'deny',
    }),
    expected: {
      kind: 'already_resolved',
      generation: replacementGeneration,
      decision: 'deny',
    },
  },
  {
    operation: 'decision',
    status: 409,
    reason: 'idempotency_mismatch',
    body: errorEnvelope('idempotency_mismatch'),
    expected: { kind: 'conflict', reason: 'idempotency_mismatch' },
  },
  {
    operation: 'decision',
    status: 410,
    reason: 'approval_expired',
    body: errorEnvelope('approval_expired'),
    expected: { kind: 'expired' },
  },
  {
    operation: 'decision',
    status: 503,
    reason: 'team_approval_unavailable',
    body: errorEnvelope('team_approval_unavailable', { retryAfterMs: 2_500 }),
    expected: { kind: 'unavailable', retryAfterMs: 2_500 },
  },
] as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('hosted team approval renderer transport', () => {
  it.each(['page', 'preview', 'decision'] as const)(
    'fails closed before the %s POST when the in-memory CSRF token is absent or invalid',
    async (operation) => {
      const tokenSources: Array<() => string | null> = [
        () => null,
        () => 'c'.repeat(31),
        () => `${'c'.repeat(32)}\n`,
        () => {
          throw new Error('csrf memory unavailable');
        },
      ];

      for (const getCsrfToken of tokenSources) {
        const { fetch, transport } = transportFor(
          response(200, successBody(operation)),
          getCsrfToken
        );
        await expect(invoke(transport, operation)).resolves.toEqual({ kind: 'unavailable' });
        expect(fetch).not.toHaveBeenCalled();
      }
    }
  );

  it('attaches the current token to every POST without persisting it or including it in bodies/results', async () => {
    const fetch = vi.fn<HostedTeamApprovalFetchPort>((route) => {
      if (route === HOSTED_TEAM_APPROVAL_PAGE_ROUTE) return Promise.resolve(response(200, page()));
      if (route === HOSTED_TEAM_APPROVAL_PREVIEW_ROUTE) {
        return Promise.resolve(response(200, preview()));
      }
      return Promise.resolve(response(200, receipt()));
    });
    const storageSet = vi.spyOn(Storage.prototype, 'setItem');
    try {
      const transport = createHostedTeamApprovalTransport({ fetch, getCsrfToken: () => csrfToken });
      const results = await Promise.all([
        transport.getPage(pageRequest()),
        transport.getPreview(previewRequest()),
        transport.decide(decisionCommand()),
      ]);

      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls.map(([route]) => route)).toEqual([
        HOSTED_TEAM_APPROVAL_PAGE_ROUTE,
        HOSTED_TEAM_APPROVAL_PREVIEW_ROUTE,
        HOSTED_TEAM_APPROVAL_DECISION_ROUTE,
      ]);
      for (const [, init] of fetch.mock.calls) {
        expect(init).toMatchObject({
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'x-agent-teams-csrf': csrfToken,
          },
        });
        expect(init.body).not.toContain(csrfToken);
      }
      expect(JSON.stringify(results)).not.toContain(csrfToken);
      expect(storageSet).not.toHaveBeenCalled();
    } finally {
      storageSet.mockRestore();
    }
  });

  it.each(errorCases)(
    'maps only the exact $operation $status/$reason pair',
    async ({ operation, status, body, expected }) => {
      const { transport } = transportFor(response(status, body));
      await expect(invoke(transport, operation)).resolves.toEqual(expected);
    }
  );

  it.each(['request-threw', 'response-lost'] as const)(
    'performs exactly one decision POST when the %s outcome is ambiguous',
    async (failure) => {
      const fetch = vi.fn<HostedTeamApprovalFetchPort>(() => {
        if (failure === 'request-threw') return Promise.reject(new Error('connection reset'));
        return Promise.resolve({
          status: 200,
          json: () => Promise.reject(new Error('response body lost')),
        });
      });
      const transport = createHostedTeamApprovalTransport({ fetch, getCsrfToken: () => csrfToken });

      await expect(transport.decide(decisionCommand())).resolves.toEqual({ kind: 'unavailable' });
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledWith(
        HOSTED_TEAM_APPROVAL_DECISION_ROUTE,
        expect.objectContaining({ method: 'POST' })
      );
    }
  );

  it.each(errorCases)(
    'maps a mismatched $operation status for $reason to unavailable',
    async ({ operation, status, body }) => {
      const mismatchedStatus = status === 400 ? 404 : 400;
      const { transport } = transportFor(response(mismatchedStatus, body));
      await expect(invoke(transport, operation)).resolves.toEqual({ kind: 'unavailable' });
    }
  );

  it.each(['page', 'preview'] as const)(
    'returns cancelled when a %s request aborts before the deferred POST resolves',
    async (operation) => {
      const pendingResponse = deferred<HostedTeamApprovalHttpResponse>();
      const fetch = vi.fn<HostedTeamApprovalFetchPort>(() => pendingResponse.promise);
      const transport = createHostedTeamApprovalTransport({ fetch, getCsrfToken: () => csrfToken });
      const controller = new AbortController();
      const result = invoke(transport, operation, controller.signal);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

      controller.abort();
      const resolvedResponse = response(200, successBody(operation));
      pendingResponse.resolve(resolvedResponse);

      await expect(result).resolves.toEqual({ kind: 'cancelled' });
      expect(resolvedResponse.json).not.toHaveBeenCalled();
    }
  );

  it.each(['page', 'preview'] as const)(
    'returns cancelled when a %s request aborts while response JSON is deferred',
    async (operation) => {
      const pendingJson = deferred<unknown>();
      const json = vi.fn(() => pendingJson.promise);
      const fetch = vi.fn<HostedTeamApprovalFetchPort>(() =>
        Promise.resolve({ status: 200, json })
      );
      const transport = createHostedTeamApprovalTransport({ fetch, getCsrfToken: () => csrfToken });
      const controller = new AbortController();
      const result = invoke(transport, operation, controller.signal);
      await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());

      controller.abort();
      pendingJson.resolve(successBody(operation));

      await expect(result).resolves.toEqual({ kind: 'cancelled' });
    }
  );
});
