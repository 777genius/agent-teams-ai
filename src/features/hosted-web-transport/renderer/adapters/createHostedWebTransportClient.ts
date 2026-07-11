import {
  HOSTED_WEB_API_BASE,
  HOSTED_WEB_EFFORT_LEVELS,
  HOSTED_WEB_LAST_EVENT_ID_HEADER,
  HOSTED_WEB_SSE_EVENT_TYPES,
  HOSTED_WEB_TEAM_FAST_MODES,
  HOSTED_WEB_TEAM_PROVIDER_IDS,
  HOSTED_WEB_TEAM_REVIEW_STATES,
  HOSTED_WEB_TEAM_TASK_STATUSES,
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
  type HostedWebTerminalSessionId,
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
  terminalSessionId?: HostedWebTerminalSessionId;
  webSocketUrl?: string;
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

export type HostedWebTransportErrorKind =
  | 'http'
  | 'response_validation'
  | 'sse_parse'
  | 'sse_stream';

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

const TERMINAL_WEBSOCKET_PROTOCOLS = new Set(['ws:', 'wss:']);
const TERMINAL_STREAM_PATH_PATTERN = new RegExp(
  `^${escapeRegExp(`${HOSTED_WEB_API_BASE}/terminal/`)}[^/?#]+$`
);
const HOSTED_WEB_KANBAN_STATUSES = [
  ...HOSTED_WEB_TEAM_TASK_STATUSES,
  'review',
  'approved',
] as const;

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
        hostedWebTeamsRoute(),
        buildUrl(dependencies.baseUrl, hostedWebTeamsRoute()),
        validateTeamsListResponse,
        {
          signal: dependencies.signal,
        }
      ),

    getTeamSnapshot: (teamId) =>
      requestJson<HostedWebTeamSnapshotResponse>(
        fetchImpl,
        hostedWebTeamRoute(teamId),
        buildUrl(dependencies.baseUrl, hostedWebTeamRoute(teamId)),
        validateTeamSnapshotResponse,
        { signal: dependencies.signal }
      ),

    launchTeam: (teamId, request) =>
      requestJson<HostedWebLaunchTeamResponse>(
        fetchImpl,
        hostedWebTeamLaunchRoute(teamId),
        buildUrl(dependencies.baseUrl, hostedWebTeamLaunchRoute(teamId)),
        validateLaunchTeamResponse,
        {
          method: 'POST',
          body: JSON.stringify(request),
          signal: dependencies.signal,
        }
      ),

    createTask: (teamId, request) =>
      requestJson<HostedWebCreateTaskResponse>(
        fetchImpl,
        hostedWebTeamTasksRoute(teamId),
        buildUrl(dependencies.baseUrl, hostedWebTeamTasksRoute(teamId)),
        validateCreateTaskResponse,
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
        hostedWebTerminalSessionsRoute(teamId),
        buildUrl(dependencies.baseUrl, hostedWebTerminalSessionsRoute(teamId)),
        (payload) => validateTerminalSessionResponse(payload, dependencies.baseUrl),
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
      const url = resolveTerminalWebSocketUrl({
        baseUrl: dependencies.baseUrl,
        terminalSessionId: options.terminalSessionId,
        webSocketUrl: options.webSocketUrl,
      });
      return new WebSocketImpl(url, options.protocols);
    },
  };
}

async function requestJson<T>(
  fetchImpl: HostedWebFetch,
  route: string,
  url: string,
  validate: (payload: unknown) => T,
  init: { method?: string; body?: string; signal?: AbortSignal } = {}
): Promise<T> {
  const response = await fetchImpl(url, {
    method: init.method ?? 'GET',
    headers: JSON_HEADERS,
    body: init.body,
    signal: init.signal,
  });

  if (!response.ok) {
    throw await buildHttpError(response, route);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new HostedWebTransportError('Hosted web response was not valid JSON', {
      kind: 'response_validation',
      code: hostedWebErrorCode('invalid_json_response'),
      status: response.status,
      route,
      cause,
    });
  }

  try {
    return validate(payload);
  } catch (cause) {
    throw new HostedWebTransportError('Hosted web response did not match the expected schema', {
      kind: 'response_validation',
      code: hostedWebErrorCode('invalid_response'),
      status: response.status,
      route,
      cause,
    });
  }
}

async function buildHttpError(
  response: Pick<Response, 'status' | 'text'>,
  route: string
): Promise<HostedWebTransportError> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    text = '';
  }

  const payload = parseJsonText(text);
  const errorPayload = readHostedWebErrorPayload(payload);
  const code = normalizeHostedWebErrorCode(errorPayload?.code, response.status);
  return new HostedWebTransportError(`Hosted web request failed with status ${response.status}`, {
    kind: 'http',
    code,
    status: response.status,
    route,
  });
}

function buildUrl(baseUrl: string | undefined, route: string): string {
  if (!baseUrl) {
    return route;
  }

  return `${baseUrl.replace(/\/$/, '')}${route}`;
}

function readHostedWebErrorPayload(payload: unknown): { code?: string } | null {
  if (!isRecord(payload) || !isRecord(payload.error)) {
    return null;
  }

  return {
    ...(typeof payload.error.code === 'string' ? { code: payload.error.code } : {}),
  };
}

function parseJsonText(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeHostedWebErrorCode(code: string | undefined, status: number): HostedWebErrorCode {
  const fallback = hostedWebErrorCode(`http_${status}`);
  if (!code) {
    return fallback;
  }
  const unprefixed = code.startsWith(`${HOSTED_WEB_API_BASE}/errors/`)
    ? code.slice(`${HOSTED_WEB_API_BASE}/errors/`.length)
    : code;
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(unprefixed)) {
    return fallback;
  }
  return hostedWebErrorCode(unprefixed);
}

function validateTeamsListResponse(payload: unknown): HostedWebTeamsListResponse {
  assertRecord(payload, 'response');
  assertArray(payload.teams, 'response.teams');
  for (const team of payload.teams) {
    assertTeamSummary(team, 'response.teams[]');
  }
  if (payload.degraded != null) {
    assertBoolean(payload.degraded, 'response.degraded');
  }
  return payload as unknown as HostedWebTeamsListResponse;
}

function validateTeamSnapshotResponse(payload: unknown): HostedWebTeamSnapshotResponse {
  assertRecord(payload, 'response');
  assertTeamSummary(payload.team, 'response.team');
  assertTaskSummaryArray(payload.tasks, 'response.tasks');
  assertArray(payload.kanban, 'response.kanban');
  for (const column of payload.kanban) {
    assertRecord(column, 'response.kanban[]');
    if (!isOneOf(column.status, HOSTED_WEB_KANBAN_STATUSES)) {
      throw new Error('Hosted web response.kanban[].status is invalid');
    }
    assertStringArray(column.taskIds, 'response.kanban[].taskIds');
  }
  assertNonEmptyString(payload.revision, 'response.revision');
  return payload as unknown as HostedWebTeamSnapshotResponse;
}

function validateLaunchTeamResponse(payload: unknown): HostedWebLaunchTeamResponse {
  assertRecord(payload, 'response');
  assertNonEmptyString(payload.runId, 'response.runId');
  if (
    payload.launchStatus !== 'started' &&
    payload.launchStatus !== 'already_launching' &&
    payload.launchStatus !== 'already_running'
  ) {
    throw new Error('Hosted web response.launchStatus is invalid');
  }
  return payload as unknown as HostedWebLaunchTeamResponse;
}

function validateCreateTaskResponse(payload: unknown): HostedWebCreateTaskResponse {
  assertRecord(payload, 'response');
  assertTaskSummary(payload.task, 'response.task');
  return payload as unknown as HostedWebCreateTaskResponse;
}

function validateTerminalSessionResponse(
  payload: unknown,
  baseUrl: string | undefined
): HostedWebTerminalSessionResponse {
  assertRecord(payload, 'response');
  assertNonEmptyString(payload.terminalSessionId, 'response.terminalSessionId');
  assertNonEmptyString(payload.webSocketUrl, 'response.webSocketUrl');
  assertValidTimestamp(payload.expiresAt, 'response.expiresAt');
  validateTerminalWebSocketTarget({
    baseUrl,
    terminalSessionId: payload.terminalSessionId,
    webSocketUrl: payload.webSocketUrl,
  });
  return payload as unknown as HostedWebTerminalSessionResponse;
}

function assertTeamSummary(value: unknown, fieldName: string): void {
  assertRecord(value, fieldName);
  assertNonEmptyString(value.teamId, `${fieldName}.teamId`);
  assertNonEmptyString(value.displayName, `${fieldName}.displayName`);
  assertString(value.description, `${fieldName}.description`);
  assertOptionalString(value.color, `${fieldName}.color`);
  if (value.project !== null && value.project !== undefined) {
    assertRecord(value.project, `${fieldName}.project`);
    assertRecord(value.project.workspaceRef, `${fieldName}.project.workspaceRef`);
    assertNonEmptyString(value.project.workspaceRef.id, `${fieldName}.project.workspaceRef.id`);
    assertNonEmptyString(
      value.project.workspaceRef.displayName,
      `${fieldName}.project.workspaceRef.displayName`
    );
    assertOptionalString(
      value.project.workspaceRef.repositoryLabel,
      `${fieldName}.project.workspaceRef.repositoryLabel`
    );
    assertOptionalString(
      value.project.workspaceRef.branchLabel,
      `${fieldName}.project.workspaceRef.branchLabel`
    );
  }
  assertArray(value.members, `${fieldName}.members`);
  for (const member of value.members) {
    assertRecord(member, `${fieldName}.members[]`);
    assertNonEmptyString(member.memberId, `${fieldName}.members[].memberId`);
    assertNonEmptyString(member.displayName, `${fieldName}.members[].displayName`);
    assertOptionalString(member.role, `${fieldName}.members[].role`);
    assertOptionalString(member.color, `${fieldName}.members[].color`);
    if (member.provider !== undefined) {
      assertProviderSelection(member.provider, `${fieldName}.members[].provider`);
    }
    if (member.currentTaskId !== null && member.currentTaskId !== undefined) {
      assertNonEmptyString(member.currentTaskId, `${fieldName}.members[].currentTaskId`);
    }
    assertNumber(member.taskCount, `${fieldName}.members[].taskCount`);
    if (
      member.isolation !== undefined &&
      member.isolation !== 'shared-workspace' &&
      member.isolation !== 'managed-worktree'
    ) {
      throw new Error(`Hosted web ${fieldName}.members[].isolation is invalid`);
    }
  }
  assertNumber(value.taskCount, `${fieldName}.taskCount`);
  if (value.lastActivity !== null && value.lastActivity !== undefined) {
    assertString(value.lastActivity, `${fieldName}.lastActivity`);
  }
  if (value.pendingCreate !== undefined) {
    assertBoolean(value.pendingCreate, `${fieldName}.pendingCreate`);
  }
  if (value.partialLaunchFailure !== undefined) {
    assertBoolean(value.partialLaunchFailure, `${fieldName}.partialLaunchFailure`);
  }
  assertRecord(value.runtime, `${fieldName}.runtime`);
  assertBoolean(value.runtime.isAlive, `${fieldName}.runtime.isAlive`);
  assertBoolean(value.runtime.terminalAvailable, `${fieldName}.runtime.terminalAvailable`);
  assertNumber(value.runtime.activeProcessCount, `${fieldName}.runtime.activeProcessCount`);
}

function assertTaskSummaryArray(value: unknown, fieldName: string): void {
  assertArray(value, fieldName);
  for (const task of value) {
    assertTaskSummary(task, `${fieldName}[]`);
  }
}

function assertTaskSummary(value: unknown, fieldName: string): void {
  assertRecord(value, fieldName);
  assertNonEmptyString(value.taskId, `${fieldName}.taskId`);
  assertOptionalString(value.displayId, `${fieldName}.displayId`);
  assertNonEmptyString(value.subject, `${fieldName}.subject`);
  if (!isOneOf(value.status, HOSTED_WEB_TEAM_TASK_STATUSES)) {
    throw new Error(`Hosted web ${fieldName}.status is invalid`);
  }
  assertOptionalString(value.ownerMemberId, `${fieldName}.ownerMemberId`);
  if (
    value.reviewState !== undefined &&
    !isOneOf(value.reviewState, HOSTED_WEB_TEAM_REVIEW_STATES)
  ) {
    throw new Error(`Hosted web ${fieldName}.reviewState is invalid`);
  }
  if (value.blockedBy !== undefined) {
    assertStringArray(value.blockedBy, `${fieldName}.blockedBy`);
  }
  if (value.related !== undefined) {
    assertStringArray(value.related, `${fieldName}.related`);
  }
  if (value.createdAt !== undefined) {
    assertValidTimestamp(value.createdAt, `${fieldName}.createdAt`);
  }
  if (value.updatedAt !== undefined) {
    assertValidTimestamp(value.updatedAt, `${fieldName}.updatedAt`);
  }
  if (
    value.needsClarification !== undefined &&
    value.needsClarification !== 'lead' &&
    value.needsClarification !== 'user'
  ) {
    throw new Error(`Hosted web ${fieldName}.needsClarification is invalid`);
  }
}

function assertProviderSelection(value: unknown, fieldName: string): void {
  assertRecord(value, fieldName);
  if (!isOneOf(value.providerId, HOSTED_WEB_TEAM_PROVIDER_IDS)) {
    throw new Error(`Hosted web ${fieldName}.providerId is invalid`);
  }
  assertOptionalString(value.modelId, `${fieldName}.modelId`);
  if (value.effort !== undefined && !isOneOf(value.effort, HOSTED_WEB_EFFORT_LEVELS)) {
    throw new Error(`Hosted web ${fieldName}.effort is invalid`);
  }
  if (value.fastMode !== undefined && !isOneOf(value.fastMode, HOSTED_WEB_TEAM_FAST_MODES)) {
    throw new Error(`Hosted web ${fieldName}.fastMode is invalid`);
  }
}

function resolveTerminalWebSocketUrl(options: {
  baseUrl: string | undefined;
  terminalSessionId: HostedWebTerminalSessionId | undefined;
  webSocketUrl: string | undefined;
}): string {
  if (options.terminalSessionId) {
    const url = buildWebSocketUrl(
      options.baseUrl,
      hostedWebTerminalStreamRoute(options.terminalSessionId)
    );
    validateTerminalWebSocketTarget({
      baseUrl: options.baseUrl,
      terminalSessionId: options.terminalSessionId,
      webSocketUrl: url,
    });
    return url;
  }

  if (!options.webSocketUrl) {
    throw new HostedWebTransportError('Hosted web terminal stream target is missing', {
      kind: 'response_validation',
      code: hostedWebErrorCode('invalid_terminal_websocket_target'),
    });
  }

  validateTerminalWebSocketTarget({
    baseUrl: options.baseUrl,
    terminalSessionId: undefined,
    webSocketUrl: options.webSocketUrl,
  });
  return options.webSocketUrl;
}

function validateTerminalWebSocketTarget(options: {
  baseUrl: string | undefined;
  terminalSessionId: HostedWebTerminalSessionId | undefined;
  webSocketUrl: string;
}): void {
  const parsed = parseTerminalWebSocketUrl(options.webSocketUrl, options.baseUrl);
  if (!parsed || !TERMINAL_WEBSOCKET_PROTOCOLS.has(parsed.protocol)) {
    throw invalidTerminalWebSocketTargetError();
  }

  if (
    !isAbsoluteUrl(options.webSocketUrl) &&
    (!options.webSocketUrl.startsWith('/') || options.webSocketUrl.startsWith('//'))
  ) {
    throw invalidTerminalWebSocketTargetError();
  }

  const expectedOrigin = getTrustedHttpOrigin(options.baseUrl);
  if (expectedOrigin && webSocketOriginToHttpOrigin(parsed) !== expectedOrigin) {
    throw invalidTerminalWebSocketTargetError();
  }

  if (!expectedOrigin && isAbsoluteUrl(options.webSocketUrl)) {
    throw invalidTerminalWebSocketTargetError();
  }

  const expectedPath = options.terminalSessionId
    ? hostedWebTerminalStreamRoute(options.terminalSessionId)
    : null;
  if (parsed.search || parsed.hash) {
    throw invalidTerminalWebSocketTargetError();
  }
  if (
    expectedPath
      ? parsed.pathname !== expectedPath
      : !TERMINAL_STREAM_PATH_PATTERN.test(parsed.pathname)
  ) {
    throw invalidTerminalWebSocketTargetError();
  }
}

function hostedWebTerminalStreamRoute(sessionId: HostedWebTerminalSessionId): string {
  return `${HOSTED_WEB_API_BASE}/terminal/${encodeURIComponent(sessionId)}`;
}

function buildWebSocketUrl(baseUrl: string | undefined, route: string): string {
  const origin = getTrustedHttpOrigin(baseUrl);
  if (!origin) {
    return route;
  }
  const url = new URL(route, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function parseTerminalWebSocketUrl(value: string, baseUrl: string | undefined): URL | null {
  try {
    if (isAbsoluteUrl(value)) {
      return new URL(value);
    }
    const origin = getTrustedHttpOrigin(baseUrl);
    return origin
      ? new URL(value, origin.replace(/^http/, 'ws'))
      : new URL(value, 'ws://localhost');
  } catch {
    return null;
  }
}

function getTrustedHttpOrigin(baseUrl: string | undefined): string | null {
  if (baseUrl && isAbsoluteUrl(baseUrl)) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.origin;
    }
  }

  const locationOrigin =
    typeof globalThis.location?.origin === 'string' ? globalThis.location.origin : null;
  if (locationOrigin && isAbsoluteUrl(locationOrigin)) {
    const parsed = new URL(locationOrigin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.origin;
    }
  }

  return null;
}

function webSocketOriginToHttpOrigin(url: URL): string {
  const normalized = new URL(url.toString());
  normalized.protocol = normalized.protocol === 'wss:' ? 'https:' : 'http:';
  normalized.pathname = '/';
  normalized.search = '';
  normalized.hash = '';
  return normalized.origin;
}

function invalidTerminalWebSocketTargetError(): HostedWebTransportError {
  return new HostedWebTransportError('Hosted web terminal stream target is not allowed', {
    kind: 'response_validation',
    code: hostedWebErrorCode('invalid_terminal_websocket_target'),
  });
}

function assertRecord(value: unknown, fieldName: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Hosted web ${fieldName} must be an object`);
  }
}

function assertArray(value: unknown, fieldName: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Hosted web ${fieldName} must be an array`);
  }
}

function assertString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`Hosted web ${fieldName} must be a string`);
  }
}

function assertOptionalString(value: unknown, fieldName: string): void {
  if (value !== undefined) {
    assertString(value, fieldName);
  }
}

function assertNonEmptyString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Hosted web ${fieldName} must be a non-empty string`);
  }
}

function assertStringArray(value: unknown, fieldName: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Hosted web ${fieldName} must be a string array`);
  }
}

function assertBoolean(value: unknown, fieldName: string): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Hosted web ${fieldName} must be a boolean`);
  }
}

function assertNumber(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Hosted web ${fieldName} must be a finite number`);
  }
}

function assertValidTimestamp(value: unknown, fieldName: string): asserts value is string {
  assertNonEmptyString(value, fieldName);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`Hosted web ${fieldName} must be a valid timestamp`);
  }
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values
): value is Values[number] {
  return typeof value === 'string' && allowed.includes(value);
}
