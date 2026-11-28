import {
  isLoginRequest,
  isMonitorRequest,
  isProjectRequest,
  monitorFailure,
} from '../../contracts';
import { createProjectMonitor } from '../../core/application/projectMonitor';
import { projectRepositories } from '../adapters/output/projectRepositories';
import { githubCredentialStore } from '../infrastructure/githubCredentialStore';
import { githubLoginConfiguration } from '../infrastructure/githubLoginConfiguration';

import { createGitHubAccounts } from './githubAccounts';
import { createGitHubReaders } from './githubReaders';

import type {
  MonitorResponse,
  MonitorResult,
  ProjectRequest,
  RepositoryStatus,
} from '../../contracts';
import type { ProjectContext } from '../adapters/output/projectRepositories';

export interface PrMonitorFeature {
  read(request: unknown): Promise<MonitorResponse>;
  login(request: unknown): Promise<import('../../contracts').LoginResponse>;
  consent(request: unknown, enabled: boolean): Promise<MonitorResult<RepositoryStatus>>;
  reset(): void;
  dispose(): void;
}

export function createPrMonitorFeature(
  getContext: () => ProjectContext,
  options: {
    vault: Parameters<typeof githubCredentialStore>[0];
    configuration?:
      | import('../../core/application/deviceAuthorization').GitHubLoginConfiguration
      | null;
    issuer?: import('../../core/application/deviceAuthorization').DeviceIssuer;
  }
): PrMonitorFeature {
  const readers = createGitHubReaders();
  const projects = projectRepositories(getContext);
  const accounts = createGitHubAccounts({
    readers,
    store: githubCredentialStore(options.vault),
    configuration:
      options.configuration === undefined ? githubLoginConfiguration() : options.configuration,
    issuer: options.issuer,
  });
  const feature = createProjectMonitor({
    projects,
    connectAccount: accounts.connect,
    login: {
      available: accounts.flow.configured,
      permissionNotice: accounts.flow.permissionNotice,
    },
  });
  let loginOwner: { scope: object; projectId: string; attemptId: string } | null = null;
  const reset = () => {
    loginOwner = null;
    accounts.flow.cancel();
    feature.reset();
  };
  const unavailable = () => monitorFailure('unknown', 'Could not load pull requests. Try again.');
  return {
    async read(request) {
      if (!isMonitorRequest(request))
        return monitorFailure('invalid_request', 'Invalid pull request selection.');
      try {
        if (request.operation === 'describe') return await feature.describe(request);
        const signal = AbortSignal.timeout(45_000);
        return request.operation === 'list'
          ? await feature.list(request, signal)
          : await feature.get(request, signal);
      } catch {
        return unavailable();
      }
    },
    async login(request) {
      if (!isLoginRequest(request))
        return monitorFailure('invalid_request', 'Invalid GitHub sign-in request.');
      const result = await projects.resolve(request);
      if (!result.ok) return result;
      const scope = result.value.scope;
      if (projects.currentScope() !== scope)
        return monitorFailure('aborted', 'The project context changed.');
      try {
        if (request.operation === 'sign-out') {
          reset();
          await accounts.signOut();
          return { ok: true, value: null };
        }
        if (request.operation === 'begin') {
          reset();
          const result = await accounts.beginLogin();
          if (projects.currentScope() !== scope) {
            reset();
            return monitorFailure('aborted', 'The project context changed.');
          }
          if (result.ok)
            loginOwner = { scope, projectId: request.projectId, attemptId: result.value.attemptId };
          return result;
        }
        if (
          !loginOwner ||
          loginOwner.scope !== scope ||
          loginOwner.projectId !== request.projectId ||
          loginOwner.attemptId !== request.attemptId
        )
          return monitorFailure('aborted', 'This GitHub sign-in is no longer active.');
        if (request.operation === 'cancel') {
          reset();
          return { ok: true, value: null };
        }
        const owner = loginOwner;
        const result = await accounts.flow.poll(request.attemptId);
        if (loginOwner !== owner || projects.currentScope() !== scope)
          return monitorFailure('aborted', 'GitHub sign-in was cancelled.');
        if (result.ok && result.value.status === 'connected') {
          loginOwner = null;
          const connection = await feature.connect(request);
          if (!connection.ok) return connection;
        }
        return result;
      } catch {
        return unavailable();
      }
    },
    async consent(request, enabled) {
      if (!isProjectRequest(request))
        return monitorFailure('invalid_request', 'Invalid project selection.');
      try {
        return enabled
          ? await feature.connect(request as ProjectRequest)
          : await feature.disconnect(request as ProjectRequest);
      } catch {
        return unavailable();
      }
    },
    reset,
    dispose() {
      reset();
      accounts.dispose();
      readers.dispose();
    },
  };
}
