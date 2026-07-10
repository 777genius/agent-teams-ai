import {
  HOSTED_WEB_LAST_EVENT_ID_HEADER,
  HOSTED_WEB_SSE_EVENT_TYPES,
  type HostedWebCreateTaskRequest,
  type HostedWebCreateTaskResponse,
  type HostedWebErrorCode,
  hostedWebErrorCode,
  type HostedWebEvent,
  type HostedWebEventCursor,
  type HostedWebLaunchTeamRequest,
  type HostedWebLaunchTeamResponse,
  hostedWebTeamEventsRoute,
  type HostedWebTeamId,
  hostedWebTeamLaunchRoute,
  hostedWebTeamRoute,
  type HostedWebTeamsListResponse,
  type HostedWebTeamSnapshotResponse,
  hostedWebTeamsRoute,
  hostedWebTeamTasksRoute,
  type HostedWebTerminalSessionRequest,
  type HostedWebTerminalSessionResponse,
  hostedWebTerminalSessionsRoute,
  parseHostedWebSseEvent,
} from '@features/hosted-web-transport/contracts';

export interface HostedWebEventSubscription {
  close(): void;
  getLastEventId(): HostedWebEventCursor | null;
}

export interface HostedWebEventHandlers {
  onEvent(event: HostedWebEvent): void;
  onCursor?(cursor: HostedWebEventCursor): void;
  onParseError?(error: HostedWebTransportError): void;
  onStreamError?(error: HostedWebTransportError): void;
  onError?(error: HostedWebTransportError): void;
}

export interface HostedWebEventSubscriptionOptions {
  teamId: HostedWebTeamId;
  resumeAfterEventId?: HostedWebEventCursor;
}

export interface HostedWebTerminalStreamOptions {
  webSocketUrl: string;
  protocols?: string | string[];
}

export interface HostedWebTransportClient {
  listTeams(): Promise<HostedWebTeamsListResponse>;
  getTeamSnapshot(teamId: HostedWebTeamId): Promise<HostedWebTeamSnapshotResponse>;
  launchTeam(
    teamId: HostedWebTeamId,
    request: HostedWebLaunchTeamRequest
  ): Promise<HostedWebLaunchTeamResponse>;
  createTask(
    teamId: HostedWebTeamId,
    request: HostedWebCreateTaskRequest
  ): Promise<HostedWebCreateTaskResponse>;
  subscribeToTeamEvents(
    options: HostedWebEventSubscriptionOptions,
    handlers: HostedWebEventHandlers
  ): HostedWebEventSubscription;
  createTerminalSession(
    teamId: HostedWebTeamId,
    request: HostedWebTerminalSessionRequest
  ): Promise<HostedWebTerminalSessionResponse>;
  openTerminalStream(options: HostedWebTerminalStreamOptions): WebSocket;
}

export type HostedWebFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<Pick<Response, 'ok' | 'status' | 'json' | 'text'>>;

export type HostedWebEventSourceConstructor = new (
  url: string
) => Pick<EventSource, 'addEventListener' | 'close'>;

export type HostedWebSocketConstructor = new (
  url: string,
  protocols?: string | string[]
) => WebSocket;

export interface HostedWebTransportClientDependencies {
  baseUrl?: string;
  fetch?: HostedWebFetch;
  EventSource?: HostedWebEventSourceConstructor;
  WebSocket?: HostedWebSocketConstructor;
  signal?: AbortSignal;
}

export type HostedWebTransportErrorKind = 'http' | 'sse_parse' | 'sse_stream';

export class HostedWebTransportError extends Error {
  readonly kind: HostedWebTransportErrorKind;
  readonly code: HostedWebErrorCode;
  readonly status?: number;
  readonly route?: string;

  constructor(
    message: string,
    options: {
      kind: HostedWebTransportErrorKind;
      code: HostedWebErrorCode;
      status?: number;
      route?: string;
      cause?: unknown;
    }
  ) {
    super(message, { cause: options.cause });
    this.name = 'HostedWebTransportError';
    this.kind = options.kind;
    this.code = options.code;
    this.status = options.status;
    this.route = options.route;
  }
}

const JSON_HEADERS = {
  accept: 'application/json',
  'content-type': 'application/json',
};

export function createHostedWebTransportClient(
  dependencies: HostedWebTransportClientDependencies = {}
): HostedWebTransportClient {
  const fetchImpl: HostedWebFetch | undefined =
    dependencies.fetch ??
    (globalThis.fetch ? (input, init) => globalThis.fetch(input, init as RequestInit) : undefined);
  if (!fetchImpl) {
    throw new Error('Hosted web transport requires a fetch implementation');
  }

  return {
    listTeams: () =>
      requestJson<HostedWebTeamsListResponse>(
        fetchImpl,
        buildUrl(dependencies.baseUrl, hostedWebTeamsRoute()),
        {
          signal: dependencies.signal,
        }
      ),

    getTeamSnapshot: (teamId) =>
      requestJson<HostedWebTeamSnapshotResponse>(
        fetchImpl,
        buildUrl(dependencies.baseUrl, hostedWebTeamRoute(teamId)),
        { signal: dependencies.signal }
      ),

    launchTeam: (teamId, request) =>
      requestJson<HostedWebLaunchTeamResponse>(
        fetchImpl,
        buildUrl(dependencies.baseUrl, hostedWebTeamLaunchRoute(teamId)),
        {
          method: 'POST',
          body: JSON.stringify(request),
          signal: dependencies.signal,
        }
      ),

    createTask: (teamId, request) =>
      requestJson<HostedWebCreateTaskResponse>(
        fetchImpl,
        buildUrl(dependencies.baseUrl, hostedWebTeamTasksRoute(teamId)),
        {
          method: 'POST',
          body: JSON.stringify(request),
          signal: dependencies.signal,
        }
      ),

    subscribeToTeamEvents: (options, handlers) => {
      const EventSourceImpl = dependencies.EventSource ?? globalThis.EventSource;
      if (!EventSourceImpl) {
        throw new Error('Hosted web transport requires EventSource for state events');
      }

      let lastEventId: HostedWebEventCursor | null = options.resumeAfterEventId ?? null;
      const source = new EventSourceImpl(
        buildUrl(
          dependencies.baseUrl,
          hostedWebTeamEventsRoute(options.teamId, { cursor: options.resumeAfterEventId })
        )
      );

      for (const eventType of HOSTED_WEB_SSE_EVENT_TYPES) {
        source.addEventListener(eventType, (event: Event) => {
          const messageEvent = event as MessageEvent<string>;
          const nativeLastEventId =
            typeof messageEvent.lastEventId === 'string' && messageEvent.lastEventId.length > 0
              ? messageEvent.lastEventId
              : undefined;
          try {
            const parsed = parseHostedWebSseEvent(eventType, messageEvent.data, {
              lastEventId: nativeLastEventId,
            });
            lastEventId = parsed.eventId;
            handlers.onCursor?.(parsed.eventId);
            handlers.onEvent(parsed);
          } catch (error) {
            const routedError = new HostedWebTransportError('Hosted web event parse failed', {
              kind: 'sse_parse',
              code: hostedWebErrorCode('sse_parse_failed'),
              route: hostedWebTeamEventsRoute(options.teamId),
              cause: error,
            });
            (handlers.onParseError ?? handlers.onError)?.(routedError);
          }
        });
      }

      source.addEventListener('error', () => {
        const error = new HostedWebTransportError(
          `Hosted web event stream failed; reconnect uses SSE ${HOSTED_WEB_LAST_EVENT_ID_HEADER} after server id fields or cursor query on a fresh subscription`,
          {
            kind: 'sse_stream',
            code: hostedWebErrorCode('sse_stream_failed'),
            route: hostedWebTeamEventsRoute(options.teamId, {
              cursor: lastEventId ?? undefined,
            }),
          }
        );
        (handlers.onStreamError ?? handlers.onError)?.(error);
      });

      return {
        close: () => source.close(),
        getLastEventId: () => lastEventId,
      };
    },

    createTerminalSession: (teamId, request) =>
      requestJson<HostedWebTerminalSessionResponse>(
        fetchImpl,
        buildUrl(dependencies.baseUrl, hostedWebTerminalSessionsRoute(teamId)),
        {
          method: 'POST',
          body: JSON.stringify(request),
          signal: dependencies.signal,
        }
      ),

    openTerminalStream: (options) => {
      const WebSocketImpl = dependencies.WebSocket ?? globalThis.WebSocket;
      if (!WebSocketImpl) {
        throw new Error('Hosted web terminal transport requires WebSocket');
      }
      return new WebSocketImpl(options.webSocketUrl, options.protocols);
    },
  };
}

async function requestJson<T>(
  fetchImpl: HostedWebFetch,
  url: string,
  init: { method?: string; body?: string; signal?: AbortSignal } = {}
): Promise<T> {
  const response = await fetchImpl(url, {
    method: init.method ?? 'GET',
    headers: JSON_HEADERS,
    body: init.body,
    signal: init.signal,
  });

  if (!response.ok) {
    throw await buildHttpError(response, url);
  }

  return (await response.json()) as T;
}

async function buildHttpError(
  response: Pick<Response, 'status' | 'json' | 'text'>,
  route: string
): Promise<HostedWebTransportError> {
  try {
    const payload = (await response.json()) as unknown;
    const errorPayload = readHostedWebErrorPayload(payload);
    const code = errorPayload?.code
      ? hostedWebErrorCode(errorPayload.code)
      : hostedWebErrorCode(`http_${response.status}`);
    return new HostedWebTransportError(
      errorPayload?.message ?? `Hosted web request failed with ${response.status}`,
      { kind: 'http', code, status: response.status, route }
    );
  } catch (cause) {
    const text = await response.text();
    return new HostedWebTransportError(
      text || `Hosted web request failed with ${response.status}`,
      {
        kind: 'http',
        code: hostedWebErrorCode(`http_${response.status}`),
        status: response.status,
        route,
        cause,
      }
    );
  }
}

function buildUrl(baseUrl: string | undefined, route: string): string {
  if (!baseUrl) {
    return route;
  }

  return `${baseUrl.replace(/\/$/, '')}${route}`;
}

function readHostedWebErrorPayload(payload: unknown): { code?: string; message?: string } | null {
  if (!isRecord(payload) || !isRecord(payload.error)) {
    return null;
  }

  return {
    ...(typeof payload.error.code === 'string' ? { code: payload.error.code } : {}),
    ...(typeof payload.error.message === 'string' ? { message: payload.error.message } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
