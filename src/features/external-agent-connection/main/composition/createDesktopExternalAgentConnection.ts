import { createHash } from 'node:crypto';

import { buildOpenCodeAppProfileScope } from '@main/services/team/opencode/bridge/OpenCodeMcpBridgeEnv';

import { BOUND_CONTROL_CONTEXT_ENV, BOUND_CONTROL_URL_ENV } from '../../contracts';
import { BoundControlContext } from '../BoundControlContext';
import { configureDesktopMcpEnvironment } from '../desktopMcpEnvironment';
import { ExternalAgentConnection } from '../ExternalAgentConnection';
import { registerBoundControlHttp } from '../registerBoundControlHttp';

import type { AppConnectionContext, ExternalAgentConnectionApi } from '../../contracts';
import type { NativeRendererCdp } from '../NativeRendererCdp';
import type { WebContents } from 'electron';
import type { FastifyInstance } from 'fastify';

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
  updateRoot(applyConfig: () => void): Promise<void>;
  changeContext(operation: () => Promise<void> | void): Promise<void>;
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
  let boundControlUrl: string | null = null;
  let shutdownStop: Promise<void> | null = null;
  let shutdownDrain: Promise<void> | null = null;
  let revokeAuthority: (() => void) | null = null;
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
  const revokeEnvironment = configureDesktopMcpEnvironment(() => {
    const controlUrl = deps.getControlUrl();
    if (stopping || !context.isOpen || !deps.isLocalContext() || !controlUrl) {
      throw new Error('Desktop MCP control context is unavailable');
    }
    // This factory is invoked only for a new owned child, never for discovery reads.
    context.transportReplaced();
    boundControlUrl = controlUrl;
    return Object.freeze({
      [BOUND_CONTROL_URL_ENV]: controlUrl,
      [BOUND_CONTROL_CONTEXT_ENV]: JSON.stringify(context.snapshot()),
      AGENT_TEAMS_MCP_CLAUDE_DIR: deps.getRoot(),
      CLAUDE_TEAM_APP_INSTANCE_ID: deps.appInstanceId,
      AGENT_TEAMS_MCP_HTTP_OWNER_PID: String(process.pid),
      CLAUDE_TEAM_APP_PROFILE_SCOPE: buildOpenCodeAppProfileScope(
        deps.userDataPath,
        deps.getRoot()
      ),
    });
  });
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
  const restoreLocalContext = async () => {
    await deps.reconfigureRoot();
    if (stopping) throw new Error('App connection is shutting down');
    bindAuthority();
    context.rebind(deps.getRoot());
    return connection.retryConnection();
  };
  const retryConnection = () =>
    serialize(async () => {
      if (!stopping && deps.isLocalContext() && !context.isOpen) return restoreLocalContext();
      return connection.retryConnection();
    });
  const change = (operation: () => Promise<void> | void, rootChanged: boolean) =>
    serialize(async () => {
      if (stopping) throw new Error('App connection is shutting down');
      await deps.mcp.assertNoLiveConsumers?.();
      deps.assertNoLiveRuntimeConsumers?.();
      await context.closeAdmission();
      if (stopping) throw new Error('App connection is shutting down');
      await deps.mcp.stop();
      if (stopping) throw new Error('App connection is shutting down');
      revokeAuthority?.();
      revokeAuthority = null;
      try {
        await operation();
        if (rootChanged) await deps.reconfigureRoot();
        if (stopping) throw new Error('App connection is shutting down');
        bindAuthority();
        if (deps.isLocalContext()) {
          context.rebind(deps.getRoot());
          await connection.retryConnection();
        }
      } catch (error) {
        // Restore the actual local root only; a partial remote transition remains closed.
        if (!stopping && deps.isLocalContext()) await restoreLocalContext().catch(() => undefined);
        throw error;
      }
    });
  const closeAdmission = (): Promise<void> => {
    stopping = true;
    shutdownDrain ??= context.closeAdmission();
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
    updateRoot: (applyConfig) => change(applyConfig, true),
    changeContext: (operation) => change(operation, false),
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
