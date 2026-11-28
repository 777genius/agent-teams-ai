import type {
  PullRequestPage,
  PullRequestSnapshot,
  ReaderError,
  RepositoryKey,
} from '@pr-monitor/core';

export const PR_MONITOR_CHANNEL = 'pr-monitor:read';
export const PR_MONITOR_CONSENT_CHANNEL = 'pr-monitor:consent';
export const PR_MONITOR_LOGIN_CHANNEL = 'pr-monitor:login';
export const PR_MONITOR_ROUTE = '/api/pr-monitor/read';

export interface ProjectRequest {
  readonly contextId: string;
  readonly projectId: string;
}
export interface RepositoryStatus {
  readonly repository: RepositoryKey;
  readonly connected: boolean;
  readonly accountKind?: 'cli' | 'device';
  readonly login?: { readonly available: boolean; readonly permissionNotice: string };
}
export type MonitorError = Omit<ReaderError, 'kind'> & {
  readonly kind:
    | ReaderError['kind']
    | 'consent_required'
    | 'unsupported'
    | 'cli_unavailable'
    | 'sign_in_required'
    | 'not_configured';
};
export type MonitorResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: MonitorError };
export type MonitorRequest = ProjectRequest &
  (
    | { readonly operation: 'describe' }
    | { readonly operation: 'list'; readonly page?: number }
    | { readonly operation: 'get'; readonly number: number }
  );
export type MonitorResponse = MonitorResult<
  RepositoryStatus | PullRequestPage | PullRequestSnapshot
>;
export interface DeviceLogin {
  readonly attemptId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: string;
  readonly intervalMs: number;
}
export type LoginProgress =
  | { readonly status: 'pending'; readonly retryAt: string }
  | { readonly status: 'connected' };
export type LoginRequest = ProjectRequest &
  (
    | { readonly operation: 'begin' }
    | { readonly operation: 'sign-out' }
    | { readonly operation: 'poll'; readonly attemptId: string }
    | { readonly operation: 'cancel'; readonly attemptId: string }
  );
export type LoginResponse = MonitorResult<DeviceLogin | LoginProgress | null>;
export interface PrMonitorApi {
  beginLogin(request: ProjectRequest): Promise<MonitorResult<DeviceLogin>>;
  pollLogin(
    request: ProjectRequest & { readonly attemptId: string }
  ): Promise<MonitorResult<LoginProgress>>;
  cancelLogin(
    request: ProjectRequest & { readonly attemptId: string }
  ): Promise<MonitorResult<null>>;
  signOut(request: ProjectRequest): Promise<MonitorResult<null>>;
  describe(request: ProjectRequest): Promise<MonitorResult<RepositoryStatus>>;
  connect(request: ProjectRequest): Promise<MonitorResult<RepositoryStatus>>;
  disconnect(request: ProjectRequest): Promise<MonitorResult<RepositoryStatus>>;
  list(
    request: ProjectRequest & { readonly page?: number }
  ): Promise<MonitorResult<PullRequestPage>>;
  get(
    request: ProjectRequest & { readonly number: number }
  ): Promise<MonitorResult<PullRequestSnapshot>>;
}

export function monitorFailure(
  kind: MonitorError['kind'],
  message: string
): { readonly ok: false; readonly error: MonitorError } {
  return { ok: false, error: { kind, message, retryAt: null } };
}

export function isProjectRequest(value: unknown): value is ProjectRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  return ['contextId', 'projectId'].every(
    (key) =>
      typeof request[key] === 'string' &&
      request[key].length > 0 &&
      request[key].length <= 512 &&
      !/[\u0000\r\n]/.test(request[key])
  );
}

export function isMonitorRequest(value: unknown): value is MonitorRequest {
  if (!isProjectRequest(value)) return false;
  const request = value as ProjectRequest & Record<string, unknown>;
  if (request.operation === 'describe') return true;
  if (request.operation === 'list')
    return (
      request.page === undefined ||
      (Number.isSafeInteger(request.page) &&
        Number(request.page) >= 1 &&
        Number(request.page) <= 1000)
    );
  return (
    request.operation === 'get' &&
    Number.isSafeInteger(request.number) &&
    Number(request.number) >= 1
  );
}

export function isLoginRequest(value: unknown): value is LoginRequest {
  if (!isProjectRequest(value)) return false;
  const request = value as ProjectRequest & Record<string, unknown>;
  if (request.operation === 'begin' || request.operation === 'sign-out') return true;
  return (
    (request.operation === 'poll' || request.operation === 'cancel') &&
    typeof request.attemptId === 'string' &&
    /^[a-z\d-]{1,64}$/i.test(request.attemptId)
  );
}
