import { createHash } from 'node:crypto';

import {
  applyApiAuthReference,
  cancelApiProfileChanges,
  configureApiProfileChanges,
  scheduleApiProfileChange,
} from '@features/local-http-auth/main';
import { buildOpenCodeAppProfileScope } from '@main/services/team/opencode/bridge/OpenCodeMcpBridgeEnv';

import {
  BOUND_CONTROL_AUTH_TOKEN_ENV,
  BOUND_CONTROL_CONTEXT_ENV,
  BOUND_CONTROL_URL_ENV,
} from '../../contracts';
import { BoundControlContext } from '../BoundControlContext';
import { configureDesktopMcpEnvironment } from '../desktopMcpEnvironment';
import { ExternalAgentConnection } from '../ExternalAgentConnection';
import { registerBoundControlHttp } from '../registerBoundControlHttp';

import type { AppConnectionContext, ExternalAgentConnectionApi } from '../../contracts';
import type { NativeRendererCdp } from '../NativeRendererCdp';
import type { WebContents } from 'electron';
import type { FastifyInstance, FastifyRequest } from 'fastify';

interface Dependencies {
  appInstanceId: string;
  userDataPath: string;
  cdp: NativeRendererCdp;
  getRoot(): string;
  getMainContents(): WebContents | null;
  getCdpEnabled(): boolean;
  getAppVersion(): string;
  isLocalContext(): boolean;
  getControlUrl(): string | null;
  getControlAuthToken(): string | null;
  startControl(): Promise<void>;
  reconfigureRoot(): Promise<void> | void;
  mcp: {
    getCurrentHandle(): { url: string; generation: number } | null;
    ensureStarted(): Promise<unknown>;
    assertNoLiveConsumers?(): Promise<void>;
    stop(options?: { preventRestart?: boolean }): Promise<void>;
    appContext: { bind(env: Record<string, string | undefined>, httpEnabled: boolean): () => void };
  };
  httpEnabled: boolean;
  hasTeamManagement?(): boolean;
  assertNoLiveRuntimeConsumers?(): void;
}

export interface DesktopExternalAgentConnection extends ExternalAgentConnectionApi {
  registerHttp(app: FastifyInstance): void;
  withExpectedContext<T>(expected: AppConnectionContext, operation: () => Promise<T>): Promise<T>;
  assertLaunchAdmission(): void;
  updateRoot(applyConfig: () => void, request?: FastifyRequest): Promise<void>;
  changeContext(operation: () => Promise<void> | void, request?: FastifyRequest): Promise<void>;
  closeAdmission(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Owns desktop authority; provider adapters consume the same existing MCP supervisor. */
export function createDesktopExternalAgentConnection(
  deps: Dependencies
): DesktopExternalAgentConnection {
  const context = new BoundControlContext(deps.appInstanceId, deps.getRoot());
  const profileFingerprint = createHash('sha256').update(deps.userDataPath).digest('hex');
  let tail = Promise.resolve();
  let stopping = false;
  let profileTransitionFailed = false;
  let boundControlUrl: string | null = null;
  let shutdownStop: Promise<void> | null = null;
  let shutdownDrain: Promise<void> | null = null;
  let revokeAuthority: (() => void) | null = null;
  // A closed MCP context is stable only after the whole non-local transition settled successfully.
  let settledNonLocalContext: { identity: string; authority: (() => void) | null } | null = null;
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
  const bindAuthority = (): void => {
    revokeAuthority?.();
    const root = deps.getRoot();
    const identity = {
      AGENT_TEAMS_MCP_CLAUDE_DIR: root,
      CLAUDE_TEAM_APP_INSTANCE_ID: deps.appInstanceId,
      CLAUDE_TEAM_APP_PROFILE_SCOPE: buildOpenCodeAppProfileScope(deps.userDataPath, root),
    };
    revokeAuthority = deps.mcp.appContext.bind(identity, deps.httpEnabled);
  };
  bindAuthority();
  const revokeEnvironment = configureDesktopMcpEnvironment(
    () => {
      const controlUrl = deps.getControlUrl();
      const controlAuthToken = deps.getControlAuthToken();
      const root = deps.getRoot();
      if (
        stopping ||
        !context.isOpen ||
        !deps.isLocalContext() ||
        !controlUrl ||
        !controlAuthToken
      ) {
        throw new Error('Desktop MCP control context is unavailable');
      }
      // This factory is invoked only for a new owned child, never for discovery reads.
      boundControlUrl = controlUrl;
      const environment = {
        [BOUND_CONTROL_URL_ENV]: controlUrl,
        [BOUND_CONTROL_AUTH_TOKEN_ENV]: controlAuthToken,
        [BOUND_CONTROL_CONTEXT_ENV]: JSON.stringify(context.snapshot()),
        AGENT_TEAMS_MCP_CLAUDE_DIR: deps.getRoot(),
        CLAUDE_TEAM_APP_INSTANCE_ID: deps.appInstanceId,
        AGENT_TEAMS_MCP_HTTP_OWNER_PID: String(process.pid),
        CLAUDE_TEAM_APP_PROFILE_SCOPE: buildOpenCodeAppProfileScope(
          deps.userDataPath,
          deps.getRoot()
        ),
      };
      applyApiAuthReference(environment, root, controlUrl);
      return Object.freeze(environment);
    },
    () =>
      !stopping &&
      context.isOpen &&
      deps.isLocalContext() &&
      !!deps.getControlUrl() &&
      !!deps.getControlAuthToken()
  );
  const connection = new ExternalAgentConnection({
    ...deps,
    context,
    getProfileFingerprint: () => profileFingerprint,
    getBoundControlUrl: () => boundControlUrl,
    startControl: async () => {
      if (stopping || !deps.httpEnabled) throw new Error('Desktop MCP HTTP connection is disabled');
      await deps.startControl();
      if (deps.mcp.getCurrentHandle() && boundControlUrl !== deps.getControlUrl()) {
        await deps.mcp.assertNoLiveConsumers?.();
        deps.assertNoLiveRuntimeConsumers?.();
        await context.closeAdmission();
        await deps.mcp.stop();
        if (stopping) throw new Error('App connection is shutting down');
        context.rebind(deps.getRoot());
      }
    },
  });
  configureApiProfileChanges(
    () => undefined,
    () => {
      profileTransitionFailed = true;
      settledNonLocalContext = null;
      connection.reportProfileTransitionFailure();
      // BoundControlContext closes admission synchronously; owner shutdown separately joins its drain.
      // Do not call the desktop closeAdmission wrapper: it joins the current profile tail.
      void context.closeAdmission();
    }
  );
  const restoreLocalContext = async () => {
    await deps.reconfigureRoot();
    if (stopping) throw new Error('App connection is shutting down');
    bindAuthority();
    context.rebind(deps.getRoot());
    return connection.retryConnection();
  };
  const retryConnection = () =>
    serialize(async () => {
      if (profileTransitionFailed) return connection.getConnectionInfo();
      if (!stopping && deps.isLocalContext() && !context.isOpen) return restoreLocalContext();
      return connection.retryConnection();
    });
  const assertChangeAllowed = async (): Promise<void> => {
    if (profileTransitionFailed)
      throw new Error('The app profile transition failed. Restart the app.');
    if (stopping) throw new Error('App connection is shutting down');
    await deps.mcp.assertNoLiveConsumers?.();
    deps.assertNoLiveRuntimeConsumers?.();
  };
  const change = (
    operation: () => Promise<void> | void,
    rootChanged: boolean,
    rejectBeforeMutation: (reason: unknown) => never
  ) =>
    serialize(async () => {
      // Recheck under the same exclusive section as the first context mutation.
      try {
        await assertChangeAllowed();
      } catch (error) {
        rejectBeforeMutation(error);
      }
      // From the first mutation onward, a prior settled closure cannot authorize restoration.
      settledNonLocalContext = null;
      await context.closeAdmission();
      if (stopping) throw new Error('App connection is shutting down');
      await deps.mcp.stop();
      if (stopping) throw new Error('App connection is shutting down');
      revokeAuthority?.();
      revokeAuthority = null;
      await operation();
      if (rootChanged) await deps.reconfigureRoot();
      if (stopping) throw new Error('App connection is shutting down');
      bindAuthority();
      if (deps.isLocalContext()) context.rebind(deps.getRoot());
    });
  const scheduleChange = (
    operation: () => Promise<void> | void,
    rootChanged: boolean,
    request?: FastifyRequest
  ): Promise<void> => {
    const identity = (): string => {
      const handle = deps.mcp.getCurrentHandle();
      return JSON.stringify([
        context.snapshot(),
        deps.getRoot(),
        deps.isLocalContext(),
        boundControlUrl,
        deps.getControlUrl(),
        deps.getControlAuthToken(),
        handle ? [handle.url, handle.generation] : null,
      ]);
    };
    let assertUnchanged = (): void => {
      throw new Error('App context was not captured');
    };
    const transition = scheduleApiProfileChange(
      (rejectBeforeMutation) => change(operation, rootChanged, rejectBeforeMutation),
      request,
      {
        beforePause: () =>
          serialize(async () => {
            await assertChangeAllowed();
            const previous = identity(),
              authority = revokeAuthority,
              wasOpen = context.isOpen;
            const stableNonLocalClosure =
              !wasOpen &&
              !deps.isLocalContext() &&
              settledNonLocalContext?.identity === previous &&
              settledNonLocalContext.authority === authority;
            assertUnchanged = () => {
              if (
                stopping ||
                context.isOpen !== wasOpen ||
                (!wasOpen && !stableNonLocalClosure) ||
                authority !== revokeAuthority ||
                previous !== identity()
              )
                throw new Error('App context changed before profile rejection restoration');
            };
          }),
        assertUnchanged: () => assertUnchanged(),
        afterResume: async () => {
          if (deps.isLocalContext()) await connection.retryConnection();
        },
        onSuccess: () => {
          settledNonLocalContext =
            !deps.isLocalContext() && !context.isOpen
              ? { identity: identity(), authority: revokeAuthority }
              : null;
        },
      }
    );
    void transition.settled.catch(() => undefined);
    return transition.result;
  };
  const closeAdmission = (): Promise<void> => {
    stopping = true;
    shutdownDrain ??= Promise.all([context.closeAdmission(), cancelApiProfileChanges()]).then(
      () => undefined
    );
    return shutdownDrain;
  };
  return {
    async withExpectedContext(expected, operation) {
      if (!deps.isLocalContext()) throw new Error('APP_CONTEXT_MISMATCH: Local context required');
      const release = context.admit(expected);
      try {
        return await operation();
      } finally {
        release();
      }
    },
    assertLaunchAdmission() {
      if (stopping || !context.isOpen) {
        throw new Error('App connection is changing context. Retry the team launch.');
      }
    },
    closeAdmission,
    getConnectionInfo: () => connection.getConnectionInfo(),
    retryConnection,
    updateRoot: (applyConfig, request) => scheduleChange(applyConfig, true, request),
    changeContext: (operation, request) => scheduleChange(operation, false, request),
    registerHttp(app) {
      registerBoundControlHttp(app, context);
      app.get('/api/app/connection', () => connection.getConnectionInfo());
      app.post('/api/app/connection/retry', () => retryConnection());
    },
    shutdown() {
      void closeAdmission();
      revokeAuthority?.();
      revokeAuthority = null;
      // Teardown cannot wait behind a hung admitted request or lifecycle operation.
      shutdownStop ??= deps.mcp.stop({ preventRestart: true }).finally(revokeEnvironment);
      return shutdownStop;
    },
  };
}
