import { monitorFailure } from '../../contracts';

import type { MonitorResult, ProjectRequest, RepositoryStatus } from '../../contracts';
import type {
  PullRequestPage,
  PullRequestReader,
  PullRequestSnapshot,
  RepositoryKey,
} from '@pr-monitor/core';

export interface ProjectRepositorySource {
  resolve(
    request: ProjectRequest
  ): Promise<MonitorResult<{ repository: RepositoryKey; scope: object }>>;
  currentScope(): object;
}
export interface MonitorAccount {
  readonly kind: 'cli' | 'device';
  createReader(repository: RepositoryKey): PullRequestReader | Promise<PullRequestReader>;
  isCurrent(signal: AbortSignal): Promise<boolean>;
}
export interface ProjectMonitorDependencies {
  readonly projects: ProjectRepositorySource;
  readonly connectAccount: (signal: AbortSignal) => Promise<MonitorResult<MonitorAccount>>;
  readonly login?: RepositoryStatus['login'];
}

/** Host policy only: project membership and explicit use of a native GitHub account. */
export function createProjectMonitor(deps: ProjectMonitorDependencies) {
  interface Lease {
    readonly abort: AbortController;
    readonly account: MonitorAccount;
    reader?: Promise<PullRequestReader>;
  }
  const grants = new Map<string, Lease>();
  const pendingConnections = new Map<string, AbortController>();
  let grantedScope: object | undefined;
  const reset = () => {
    for (const connection of pendingConnections.values()) connection.abort();
    pendingConnections.clear();
    for (const lease of grants.values()) lease.abort.abort();
    grants.clear();
    grantedScope = undefined;
  };
  const key = (request: ProjectRequest, repository: RepositoryKey): string =>
    JSON.stringify([
      request.projectId,
      repository.owner.toLowerCase(),
      repository.repo.toLowerCase(),
    ]);
  const changed = () =>
    monitorFailure('invalid_request', 'The project context changed. Open Pull Requests again.');

  function currentScope() {
    const scope = deps.projects.currentScope();
    if (grantedScope !== scope) {
      reset();
      grantedScope = scope;
    }
    return scope;
  }

  async function repository(request: ProjectRequest) {
    const scope = currentScope();
    const result = await deps.projects.resolve(request);
    if (deps.projects.currentScope() !== scope || (result.ok && result.value.scope !== scope))
      return changed();
    return result;
  }

  function status(
    request: ProjectRequest,
    repository: RepositoryKey
  ): MonitorResult<RepositoryStatus> {
    const lease = grants.get(key(request, repository));
    return {
      ok: true,
      value: {
        repository,
        connected: lease !== undefined,
        accountKind: lease?.account.kind,
        login: deps.login,
      },
    };
  }

  async function describe(request: ProjectRequest): Promise<MonitorResult<RepositoryStatus>> {
    const result = await repository(request);
    return result.ok ? status(request, result.value.repository) : result;
  }

  async function consent(
    request: ProjectRequest,
    enabled: boolean
  ): Promise<MonitorResult<RepositoryStatus>> {
    const scope = currentScope();
    const intentKey = JSON.stringify([request.contextId, request.projectId]);
    const connection = new AbortController();
    pendingConnections.get(intentKey)?.abort();
    pendingConnections.set(intentKey, connection);
    const connectSignal = AbortSignal.any([connection.signal, AbortSignal.timeout(30_000)]);
    const current = () =>
      deps.projects.currentScope() === scope &&
      grantedScope === scope &&
      pendingConnections.get(intentKey) === connection &&
      !connectSignal.aborted;
    try {
      const result = await repository(request);
      if (!current()) return changed();
      if (!result.ok) return result;
      const repoKey = key(request, result.value.repository);
      grants.get(repoKey)?.abort.abort();
      grants.delete(repoKey);
      if (enabled) {
        const connected = await deps.connectAccount(connectSignal);
        if (!current()) return changed();
        if (!connected.ok) return connected;
        grants.set(repoKey, { abort: new AbortController(), account: connected.value });
      }
      return status(request, result.value.repository);
    } finally {
      connection.abort();
      if (pendingConnections.get(intentKey) === connection) pendingConnections.delete(intentKey);
    }
  }

  function accessLost(response: MonitorResult<PullRequestPage | PullRequestSnapshot>): boolean {
    if (!response.ok)
      return ['unauthorized', 'forbidden', 'not_found'].includes(response.error.kind);
    return (
      'issues' in response.value &&
      response.value.issues.some(
        (issue) => issue.code === 'unauthorized' || issue.code === 'forbidden'
      )
    );
  }

  async function read<T extends PullRequestPage | PullRequestSnapshot>(
    request: ProjectRequest,
    signal: AbortSignal | undefined,
    operation: (
      reader: PullRequestReader,
      repo: RepositoryKey,
      signal: AbortSignal
    ) => Promise<MonitorResult<T>>
  ): Promise<MonitorResult<T>> {
    const result = await repository(request);
    if (!result.ok) return result;
    const { scope, repository: repo } = result.value;
    const repoKey = key(request, repo);
    const lease = grants.get(repoKey);
    if (!lease)
      return monitorFailure(
        'consent_required',
        'Choose Connect GitHub to read pull requests for this repository.'
      );
    const combined = signal ? AbortSignal.any([signal, lease.abort.signal]) : lease.abort.signal;
    const current = () =>
      !combined.aborted && deps.projects.currentScope() === scope && grants.get(repoKey) === lease;
    const initialAccount = await lease.account.isCurrent(combined);
    if (!current()) return changed();
    if (!initialAccount) {
      lease.abort.abort();
      grants.delete(repoKey);
      return monitorFailure(
        'sign_in_required',
        'The GitHub account changed or expired. Connect GitHub again.'
      );
    }
    lease.reader ??= Promise.resolve(lease.account.createReader(repo));
    const reader = await lease.reader;
    if (!current()) return changed();
    const response = await operation(reader, repo, combined);
    if (!current()) return changed();
    const finalAccount = await lease.account.isCurrent(combined);
    if (!current()) return changed();
    if (!finalAccount || accessLost(response)) {
      lease.abort.abort();
      grants.delete(repoKey);
      return monitorFailure(
        'sign_in_required',
        'GitHub access changed or expired. Check repository access, then connect GitHub again.'
      );
    }
    return response;
  }

  return {
    describe,
    connect: (request: ProjectRequest) => consent(request, true),
    disconnect: (request: ProjectRequest) => consent(request, false),
    list: (
      request: ProjectRequest & { page?: number },
      signal?: AbortSignal
    ): Promise<MonitorResult<PullRequestPage>> =>
      read(request, signal, (reader, repo, combined) =>
        reader.list({ repository: repo, page: request.page, signal: combined })
      ),
    get: (
      request: ProjectRequest & { number: number },
      signal?: AbortSignal
    ): Promise<MonitorResult<PullRequestSnapshot>> =>
      read(request, signal, (reader, repo, combined) =>
        reader.get({ pullRequest: { repository: repo, number: request.number }, signal: combined })
      ),
    reset,
    dispose: reset,
  };
}
