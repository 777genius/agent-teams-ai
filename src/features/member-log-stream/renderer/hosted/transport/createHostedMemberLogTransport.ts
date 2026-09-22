import {
  type GetHostedMemberLogPageResult,
  HOSTED_MEMBER_LOG_PAGE_HTTP_PATH,
  type HostedMemberLogErrorEnvelope,
  type HostedMemberLogPageRequest,
  parseHostedMemberLogErrorEnvelope,
  parseHostedMemberLogPage,
  parseHostedMemberLogPageRequest,
} from '../../../contracts/hosted';

import type {
  HostedMemberLogHttpRequestInit,
  HostedMemberLogHttpResponse,
  HostedMemberLogTransport,
  HostedMemberLogTransportDependencies,
  HostedMemberLogTransportOptions,
} from '../ports/HostedMemberLogRendererPorts';

const JSON_HEADERS = Object.freeze({
  Accept: 'application/json',
  'Content-Type': 'application/json',
});
const CSRF_HEADER = 'x-agent-teams-csrf';
const CSRF_TOKEN = /^[A-Za-z0-9_-]{32,512}$/;

interface UnavailableResult {
  readonly kind: 'unavailable';
  readonly retryAfterMs?: number;
}

interface ExpectedErrorTuple {
  readonly status: number;
  readonly code: HostedMemberLogErrorEnvelope['error']['code'];
  readonly reason: string;
  readonly retryable: boolean;
  readonly currentSourceGeneration: 'required' | 'forbidden';
  readonly retryAfterMs: 'optional' | 'forbidden';
}

const INVALID_REQUEST_ERROR = Object.freeze({
  status: 400,
  code: 'invalid_request',
  reason: 'member_log_page_request_invalid',
  retryable: false,
  currentSourceGeneration: 'forbidden',
  retryAfterMs: 'forbidden',
} satisfies ExpectedErrorTuple);

const NOT_FOUND_ERROR = Object.freeze({
  status: 404,
  code: 'not_found',
  reason: 'member_log_not_found',
  retryable: false,
  currentSourceGeneration: 'forbidden',
  retryAfterMs: 'forbidden',
} satisfies ExpectedErrorTuple);

const STALE_GENERATION_ERROR = Object.freeze({
  status: 409,
  code: 'conflict',
  reason: 'stale_generation',
  retryable: false,
  currentSourceGeneration: 'required',
  retryAfterMs: 'forbidden',
} satisfies ExpectedErrorTuple);

const UNAVAILABLE_ERROR = Object.freeze({
  status: 503,
  code: 'unavailable',
  reason: 'member_log_unavailable',
  retryable: true,
  currentSourceGeneration: 'forbidden',
  retryAfterMs: 'optional',
} satisfies ExpectedErrorTuple);

function unavailable(retryAfterMs?: number): UnavailableResult {
  return retryAfterMs === undefined
    ? Object.freeze({ kind: 'unavailable' })
    : Object.freeze({ kind: 'unavailable', retryAfterMs });
}

function readCsrfToken(dependencies: HostedMemberLogTransportDependencies): string | null {
  try {
    const value: unknown = dependencies.getCsrfToken();
    return typeof value === 'string' && CSRF_TOKEN.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function readJson(response: HostedMemberLogHttpResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readStatus(response: HostedMemberLogHttpResponse): number | null {
  try {
    const status = response.status;
    return Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null;
  } catch {
    return null;
  }
}

function requestInit(
  body: string,
  options?: HostedMemberLogTransportOptions
): HostedMemberLogHttpRequestInit {
  return Object.freeze({
    method: 'POST' as const,
    credentials: 'include' as const,
    cache: 'no-store' as const,
    headers: Object.freeze({ ...JSON_HEADERS }),
    body,
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  });
}

/** Maps an error only when the response exactly matches this route's public error contract. */
function matchesErrorTuple(
  status: number,
  envelope: HostedMemberLogErrorEnvelope,
  expected: ExpectedErrorTuple
): boolean {
  const hasCurrentSourceGeneration = envelope.currentSourceGeneration !== undefined;
  const hasRetryAfterMs = envelope.error.retryAfterMs !== undefined;
  return (
    status === expected.status &&
    envelope.error.code === expected.code &&
    envelope.error.reason === expected.reason &&
    envelope.retryable === expected.retryable &&
    envelope.error.diagnosticId === undefined &&
    hasCurrentSourceGeneration === (expected.currentSourceGeneration === 'required') &&
    (expected.retryAfterMs === 'optional' || !hasRetryAfterMs)
  );
}

function mapPageError(status: number, value: unknown): GetHostedMemberLogPageResult {
  const envelope = parseHostedMemberLogErrorEnvelope(value);
  if (!envelope.ok) return unavailable();
  if (matchesErrorTuple(status, envelope.value, INVALID_REQUEST_ERROR)) {
    return Object.freeze({ kind: 'invalid_request' });
  }
  if (matchesErrorTuple(status, envelope.value, NOT_FOUND_ERROR)) {
    return Object.freeze({ kind: 'not_found' });
  }
  if (matchesErrorTuple(status, envelope.value, STALE_GENERATION_ERROR)) {
    return Object.freeze({
      kind: 'stale_generation',
      currentSourceGeneration: envelope.value.currentSourceGeneration as NonNullable<
        HostedMemberLogErrorEnvelope['currentSourceGeneration']
      >,
    });
  }
  return matchesErrorTuple(status, envelope.value, UNAVAILABLE_ERROR)
    ? unavailable(envelope.value.error.retryAfterMs)
    : unavailable();
}

/** Creates an injected, browser-only same-origin transport with no durable client state. */
export function createHostedMemberLogTransport(
  dependencies: HostedMemberLogTransportDependencies
): HostedMemberLogTransport {
  const send = async (
    body: string,
    options: HostedMemberLogTransportOptions | undefined,
    csrfToken: string
  ): Promise<HostedMemberLogHttpResponse> =>
    dependencies.fetch(HOSTED_MEMBER_LOG_PAGE_HTTP_PATH, {
      ...requestInit(body, options),
      headers: Object.freeze({ ...JSON_HEADERS, [CSRF_HEADER]: csrfToken }),
    });

  return Object.freeze({
    async getPage(
      requestValue: HostedMemberLogPageRequest,
      options?: HostedMemberLogTransportOptions
    ): Promise<GetHostedMemberLogPageResult> {
      const request = parseHostedMemberLogPageRequest(requestValue);
      if (!request.ok) return Object.freeze({ kind: 'invalid_request' });
      if (options?.signal?.aborted) return Object.freeze({ kind: 'cancelled' });
      const csrfToken = readCsrfToken(dependencies);
      if (csrfToken === null) return unavailable();

      let response: HostedMemberLogHttpResponse;
      try {
        response = await send(JSON.stringify(request.value), options, csrfToken);
      } catch {
        return options?.signal?.aborted ? Object.freeze({ kind: 'cancelled' }) : unavailable();
      }
      if (options?.signal?.aborted) return Object.freeze({ kind: 'cancelled' });
      const value = await readJson(response);
      if (options?.signal?.aborted) return Object.freeze({ kind: 'cancelled' });
      const status = readStatus(response);
      if (status === null) return unavailable();
      if (status !== 200) return mapPageError(status, value);
      const page = parseHostedMemberLogPage(value, request.value);
      return page.ok ? Object.freeze({ kind: 'success', page: page.value }) : unavailable();
    },
  });
}
