import {
  HOSTED_PERMISSIONS,
  HOSTED_ROLES,
  type HostedPermission,
  type HostedRole,
  type HostedWorkspaceId,
} from '../../contracts';

const ROLE_PERMISSION_MATRIX: Readonly<Record<HostedRole, readonly HostedPermission[]>> =
  Object.freeze({
    owner: HOSTED_PERMISSIONS,
    admin: Object.freeze<HostedPermission[]>([
      'hosted.query',
      'hosted.events',
      'hosted.command',
      'hosted.manage',
      'workspace.manage',
    ]),
    member: Object.freeze<HostedPermission[]>(['hosted.query', 'hosted.events', 'hosted.command']),
    viewer: Object.freeze<HostedPermission[]>(['hosted.query', 'hosted.events']),
  });

export function isHostedRole(value: unknown): value is HostedRole {
  return typeof value === 'string' && HOSTED_ROLES.includes(value as HostedRole);
}

export function permissionsForRole(role: HostedRole): readonly HostedPermission[] {
  return ROLE_PERMISSION_MATRIX[role];
}

export function roleAllows(role: HostedRole, permission: HostedPermission): boolean {
  return ROLE_PERMISSION_MATRIX[role].includes(permission);
}

export interface HostedHttpRequest {
  readonly ip: string;
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly query: unknown;
  readonly params: unknown;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>> & {
    readonly cookie?: string;
    readonly origin?: string;
    readonly 'sec-fetch-site'?: string;
  };
}

export interface HostedHttpReply {
  readonly sent: boolean;
  readonly raw: {
    once(event: 'close', listener: () => void): unknown;
  };
  code(statusCode: number): HostedHttpReply;
  send(payload?: unknown): unknown;
  header(name: string, value: unknown): HostedHttpReply;
  headers(values: Readonly<Record<string, unknown>>): HostedHttpReply;
  redirect(url: string): unknown;
}

export interface HostedHttpApplication {
  hasContentTypeParser(contentType: string): boolean;
  addContentTypeParser(
    contentType: string,
    options: { readonly parseAs: 'string' },
    parser: (
      request: unknown,
      body: unknown,
      done: (error: Error | null, value: unknown) => void
    ) => void
  ): void;
  addHook(
    name: 'preHandler',
    handler: (request: HostedHttpRequest, reply: HostedHttpReply) => Promise<void>
  ): void;
  addHook(
    name: 'onSend',
    handler: (
      request: HostedHttpRequest,
      reply: HostedHttpReply,
      payload: unknown
    ) => Promise<unknown>
  ): void;
  addHook(
    name: 'onResponse',
    handler: (request: HostedHttpRequest, reply: HostedHttpReply) => Promise<void>
  ): void;
  get(
    route: string,
    handler: (request: HostedHttpRequest, reply: HostedHttpReply) => unknown
  ): void;
  post(
    route: string,
    handler: (request: HostedHttpRequest, reply: HostedHttpReply) => unknown
  ): void;
}

export const SESSION_COOKIE = '__Host-agent-teams-session';
export const DEVICE_COOKIE = '__Host-agent-teams-device';
export const OIDC_ATTEMPT_COOKIE = '__Host-agent-teams-oidc-attempt';
export const OIDC_STATE_COOKIE = '__Host-agent-teams-oidc-state';
export const OIDC_LOGIN_WINDOW_MS = 60_000;
export const OIDC_LOGIN_LIMIT_PER_SOURCE = 30;
export const OIDC_LOGIN_SOURCE_CAPACITY = 4_096;
export const OIDC_BACKCHANNEL_LIMIT_PER_SOURCE = 120;
export const OIDC_BACKCHANNEL_GLOBAL_LIMIT = 600;
export const OIDC_BACKCHANNEL_MAX_CONCURRENCY = 8;

export interface AdmissionWindow {
  startedAt: number;
  count: number;
}

export function admitFixedWindow(
  admission: Map<string, AdmissionWindow>,
  source: string,
  now: number,
  limit: number
): boolean {
  const existing = admission.get(source);
  if (existing && now - existing.startedAt < OIDC_LOGIN_WINDOW_MS) {
    if (existing.count >= limit) return false;
    admission.set(source, { startedAt: existing.startedAt, count: existing.count + 1 });
    return true;
  }
  if (admission.size >= OIDC_LOGIN_SOURCE_CAPACITY) {
    for (const [key, window] of admission) {
      if (now - window.startedAt >= OIDC_LOGIN_WINDOW_MS) admission.delete(key);
    }
    if (admission.size >= OIDC_LOGIN_SOURCE_CAPACITY && !admission.has(source)) return false;
  }
  admission.set(source, { startedAt: now, count: 1 });
  return true;
}

export function parseCookies(header: string | undefined): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!cookies.has(name) && /^[A-Za-z0-9._~-]*$/.test(value)) cookies.set(name, value);
  }
  return cookies;
}

export function cookie(
  name: string,
  value: string,
  options: {
    readonly maxAge: number;
    readonly secure: boolean;
    readonly sameSite: 'Strict' | 'Lax';
  }
): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    options.secure ? 'Secure' : '',
    `SameSite=${options.sameSite}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`,
  ]
    .filter(Boolean)
    .join('; ');
}

export function clearCookie(name: string, secure: boolean): string {
  return cookie(name, '', { maxAge: 0, secure, sameSite: 'Strict' });
}

export function bodyRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function safeReturnTo(value: unknown, publicOrigin: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 1024 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#')
  ) {
    return '/';
  }
  try {
    return new URL(value, publicOrigin).origin === publicOrigin ? value : '/';
  } catch {
    return '/';
  }
}

export type HostedHttpAuthorization =
  | { readonly kind: 'public' }
  | { readonly kind: 'forbidden' }
  | {
      readonly kind: 'authenticated';
      readonly permission: HostedPermission;
      readonly csrfRequired: boolean;
      readonly workspaceRequired: boolean;
      readonly teamWorkspaceRequired?: true;
    };

const PUBLIC_AUTH_ROUTES = new Set([
  'GET /api/auth/status',
  'POST /api/auth/personal/pair',
  'GET /api/auth/oidc/login',
  'GET /api/auth/oidc/callback',
  'POST /api/auth/oidc/backchannel-logout',
]);

const WORKSPACE_QUERY_PATHS = Object.freeze([
  /^\/api\/projects\/[^/]+\/search$/,
  /^\/api\/projects\/[^/]+\/sessions$/,
  /^\/api\/projects\/[^/]+\/sessions-paginated$/,
  /^\/api\/projects\/[^/]+\/sessions\/[^/]+$/,
  /^\/api\/projects\/[^/]+\/sessions\/[^/]+\/(?:groups|metrics|waterfall)$/,
  /^\/api\/projects\/[^/]+\/sessions\/[^/]+\/subagents\/[^/]+$/,
  /^\/api\/worktrees\/[^/]+\/sessions$/,
]);

const DEPLOYMENT_QUERY_PATHS = new Set([
  '/api/config',
  '/api/dashboard/recent-projects',
  '/api/projects',
  '/api/repository-groups',
  '/api/search',
  '/api/version',
]);

const WORKSPACE_QUERY_POST_PATH = /^\/api\/projects\/[^/]+\/sessions-by-ids$/;
const WORKSPACE_CONFIG_MUTATION_PATH =
  /^\/api\/config\/(?:pin-session|unpin-session|hide-session|unhide-session|hide-sessions|unhide-sessions)$/;
const HOSTED_TASK_BOARD_PAGE_PATH = '/api/hosted/v1/team-task-board/page';
const HOSTED_TASK_BOARD_MUTATION_PATH = '/api/hosted/v1/team-task-board/mutations';
const HOSTED_MEMBER_LOG_PAGE_PATH = '/api/hosted/v1/member-log/page';
const HOSTED_TEAM_APPROVAL_QUERY_PATHS = new Set([
  '/api/hosted/v1/team-approvals/page',
  '/api/hosted/v1/team-approvals/preview',
]);
const HOSTED_TEAM_APPROVAL_DECISION_PATH = '/api/hosted/v1/team-approvals/decisions';
const HOSTED_OPERATIONS_DIAGNOSTICS_PATH = '/api/hosted/v1/operations/diagnostics';
const HOSTED_COORDINATION_EVENTS_PATH = '/api/hosted/v1/events';
const HOSTED_LIFECYCLE_COMMAND_PATHS = new Set([
  '/api/hosted/v1/team-lifecycle/launch',
  '/api/hosted/v1/team-lifecycle/cancel',
  '/api/hosted/v1/team-lifecycle/stop',
  '/api/hosted/v1/team-lifecycle/recover',
]);

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function canonicalAuthorizationPath(requestTarget: string): string | null {
  const rawPath = requestTarget.split('?', 1)[0] ?? requestTarget;
  if (
    !rawPath.startsWith('/') ||
    rawPath.startsWith('//') ||
    rawPath.includes('\\') ||
    rawPath.includes('#') ||
    hasControlCharacter(rawPath)
  ) {
    return null;
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (
    !decodedPath.startsWith('/') ||
    decodedPath.startsWith('//') ||
    decodedPath.includes('\\') ||
    decodedPath.includes('?') ||
    decodedPath.includes('#') ||
    hasControlCharacter(decodedPath)
  ) {
    return null;
  }
  return new URL(decodedPath, 'https://hosted-authorization.invalid').pathname;
}

/**
 * Complete fail-closed policy for the legacy Fastify route surface.
 *
 * Route-specific registrations remain responsible for input validation. This
 * classifier owns only authentication, CSRF, role and workspace admission.
 * New `/api` routes are denied until this inventory explicitly classifies
 * them. Method alone never grants admission.
 */
export function classifyHostedHttpAuthorization(
  methodValue: string,
  pathValue: string
): HostedHttpAuthorization {
  const method = methodValue.toUpperCase();
  const path = canonicalAuthorizationPath(pathValue);
  if (path === null) return Object.freeze({ kind: 'forbidden' });
  if (PUBLIC_AUTH_ROUTES.has(`${method} ${path}`)) return Object.freeze({ kind: 'public' });
  // The exact API root is reserved too. Treating only `/api/*` as protected
  // would let a newly registered `/api` handler bypass the fail-closed
  // inventory while every child route remained protected.
  if (path !== '/api' && !path.startsWith('/api/')) {
    return Object.freeze({ kind: 'public' });
  }

  if ((path === '/api/events' || path === HOSTED_COORDINATION_EVENTS_PATH) && method === 'GET') {
    return Object.freeze({
      kind: 'authenticated',
      permission: 'hosted.events',
      csrfRequired: false,
      workspaceRequired: false,
    });
  }

  if (
    method === 'GET' &&
    (DEPLOYMENT_QUERY_PATHS.has(path) ||
      WORKSPACE_QUERY_PATHS.some((pattern) => pattern.test(path)))
  ) {
    return Object.freeze({
      kind: 'authenticated',
      permission: 'hosted.query',
      csrfRequired: false,
      workspaceRequired: WORKSPACE_QUERY_PATHS.some((pattern) => pattern.test(path)),
    });
  }

  if (path === '/api/auth/logout' || path === '/api/auth/personal/forget-device') {
    return Object.freeze({
      kind: 'authenticated',
      permission: 'hosted.query',
      csrfRequired: true,
      workspaceRequired: false,
    });
  }

  if (
    method === 'POST' &&
    (WORKSPACE_QUERY_POST_PATH.test(path) || path === '/api/teams/lifecycle/read')
  ) {
    return Object.freeze({
      kind: 'authenticated',
      permission: 'hosted.query',
      csrfRequired: true,
      workspaceRequired: WORKSPACE_QUERY_POST_PATH.test(path),
    });
  }

  if (
    method === 'POST' &&
    (path === HOSTED_TASK_BOARD_PAGE_PATH || path === HOSTED_TASK_BOARD_MUTATION_PATH)
  ) {
    return Object.freeze({
      kind: 'authenticated',
      permission: path === HOSTED_TASK_BOARD_PAGE_PATH ? 'hosted.query' : 'hosted.command',
      csrfRequired: true,
      workspaceRequired: false,
      teamWorkspaceRequired: true,
    });
  }

  if (method === 'POST' && path === HOSTED_MEMBER_LOG_PAGE_PATH) {
    return Object.freeze({
      kind: 'authenticated',
      permission: 'hosted.query',
      csrfRequired: true,
      workspaceRequired: false,
    });
  }

  if (method === 'POST' && HOSTED_TEAM_APPROVAL_QUERY_PATHS.has(path)) {
    return Object.freeze({
      kind: 'authenticated',
      permission: 'hosted.query',
      csrfRequired: true,
      workspaceRequired: false,
      teamWorkspaceRequired: true,
    });
  }

  if (method === 'POST' && path === HOSTED_TEAM_APPROVAL_DECISION_PATH) {
    return Object.freeze({
      kind: 'authenticated',
      permission: 'hosted.command',
      csrfRequired: true,
      workspaceRequired: false,
      teamWorkspaceRequired: true,
    });
  }

  if (method === 'POST' && HOSTED_LIFECYCLE_COMMAND_PATHS.has(path)) {
    return Object.freeze({
      kind: 'authenticated',
      permission: 'hosted.command',
      csrfRequired: true,
      workspaceRequired: false,
      teamWorkspaceRequired: true,
    });
  }

  if (method === 'POST' && path === HOSTED_OPERATIONS_DIAGNOSTICS_PATH) {
    return Object.freeze({
      kind: 'authenticated',
      permission: 'hosted.query',
      csrfRequired: true,
      workspaceRequired: false,
    });
  }

  if (method === 'POST' && WORKSPACE_CONFIG_MUTATION_PATH.test(path)) {
    return Object.freeze({
      kind: 'authenticated',
      permission: 'hosted.command',
      csrfRequired: true,
      workspaceRequired: true,
    });
  }

  return Object.freeze({ kind: 'forbidden' });
}

const OMIT_HOSTED_VALUE = Symbol('omit-hosted-value');
const WORKSPACE_ID_KEYS = new Set(['id', 'projectId', 'workspaceId', 'worktreeId', 'repositoryId']);
const PRIVATE_HOST_KEYS = new Set([
  'cwd',
  'gitBranch',
  'gitDir',
  'gitRemote',
  'homeDirectory',
  'identity',
  'localRoot',
  'mainGitDir',
  'origin',
  'originUrl',
  'remoteUrl',
  'remotes',
  'repo',
  'repoPath',
  'repository',
  'repositoryIdentity',
  'repositoryPath',
  'repositoryUrl',
  'rootPath',
  'runtimeRoot',
  'worktreePath',
]);
const PATH_KEYS = new Set([
  'associatedPaths',
  'claudeRootPath',
  'filePath',
  'fullPath',
  'path',
  'primaryPath',
  'projectPath',
]);

export interface HostedWorkspaceProjectionEntry {
  readonly workspaceId: HostedWorkspaceId;
  readonly runtimeWorkspaceId: string;
}

export interface HostedWorkspaceProjectionScope {
  readonly grantedByRuntime: ReadonlyMap<string, HostedWorkspaceProjectionEntry>;
  readonly grantedByPublic: ReadonlyMap<string, HostedWorkspaceProjectionEntry>;
  readonly registeredByRuntime: ReadonlyMap<string, HostedWorkspaceId>;
  readonly registeredPublicIds: ReadonlySet<string>;
}

export function createHostedWorkspaceProjectionScope(
  grants: readonly HostedWorkspaceProjectionEntry[],
  workspaces: readonly HostedWorkspaceProjectionEntry[]
): HostedWorkspaceProjectionScope {
  return Object.freeze({
    grantedByRuntime: new Map(grants.map((grant) => [grant.runtimeWorkspaceId, grant])),
    grantedByPublic: new Map(grants.map((grant) => [grant.workspaceId, grant])),
    registeredByRuntime: new Map(
      workspaces.map((workspace) => [workspace.runtimeWorkspaceId, workspace.workspaceId])
    ),
    registeredPublicIds: new Set(workspaces.map((workspace) => workspace.workspaceId)),
  });
}

function looksLikePrivateHostString(value: string): boolean {
  return (
    /(?:^|[\s"'`(=])\/(?!\/)[^\s"'`]+/u.test(value) ||
    /(?:^|[\s"'`(=])\\\\[^\\\s]+\\/u.test(value) ||
    /(?:^|[\s"'`(=])[A-Za-z]:[\\/]/u.test(value) ||
    /[a-z][a-z0-9+.-]*:\/\/\S+/iu.test(value) ||
    /(?:^|\s)[^@\s]+@[^:\s]+:\S+/u.test(value)
  );
}

function projectHostedValue(
  value: unknown,
  scope: HostedWorkspaceProjectionScope,
  key?: string
): unknown | typeof OMIT_HOSTED_VALUE {
  if (typeof value === 'string') {
    const grant = scope.grantedByRuntime.get(value);
    if (grant) return grant.workspaceId;
    if (scope.grantedByPublic.has(value)) return value;
    if (scope.registeredByRuntime.has(value) || scope.registeredPublicIds.has(value)) {
      return OMIT_HOSTED_VALUE;
    }
    return looksLikePrivateHostString(value) ||
      (key !== undefined && (PATH_KEYS.has(key) || PRIVATE_HOST_KEYS.has(key)))
      ? OMIT_HOSTED_VALUE
      : value;
  }
  if (value === null || ['number', 'boolean', 'undefined'].includes(typeof value)) return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => projectHostedValue(item, scope, key))
      .filter((item) => item !== OMIT_HOSTED_VALUE);
  }
  if (typeof value !== 'object') return OMIT_HOSTED_VALUE;
  const source = value as Record<string, unknown>;
  for (const identifierKey of WORKSPACE_ID_KEYS) {
    const identifier = source[identifierKey];
    if (
      typeof identifier === 'string' &&
      (scope.registeredByRuntime.has(identifier) || scope.registeredPublicIds.has(identifier)) &&
      !scope.grantedByRuntime.has(identifier) &&
      !scope.grantedByPublic.has(identifier)
    ) {
      return OMIT_HOSTED_VALUE;
    }
  }
  const projected: Record<string, unknown> = {};
  for (const [sourceKey, sourceValue] of Object.entries(source)) {
    if (PRIVATE_HOST_KEYS.has(sourceKey)) continue;
    const projectedKey =
      scope.grantedByRuntime.get(sourceKey)?.workspaceId ??
      (scope.registeredByRuntime.has(sourceKey) ? null : sourceKey);
    if (projectedKey === null) continue;
    const projectedValue = projectHostedValue(sourceValue, scope, sourceKey);
    if (projectedValue !== OMIT_HOSTED_VALUE && projectedValue !== undefined) {
      projected[projectedKey] = projectedValue;
    }
  }
  return projected;
}

export function projectHostedPayload(
  payload: unknown,
  scope: HostedWorkspaceProjectionScope
): unknown {
  const projected = projectHostedValue(payload, scope);
  return projected === OMIT_HOSTED_VALUE ? null : projected;
}
