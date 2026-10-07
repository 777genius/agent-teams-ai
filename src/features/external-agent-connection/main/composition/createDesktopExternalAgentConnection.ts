import { createHash } from 'node:crypto';

import { buildOpenCodeAppProfileScope } from '@main/services/team/opencode/bridge/OpenCodeMcpBridgeEnv';

import { BOUND_CONTROL_CONTEXT_ENV, BOUND_CONTROL_URL_ENV } from '../../contracts';
import { BoundControlContext } from '../BoundControlContext';
import { configureDesktopMcpEnvironment } from '../desktopMcpEnvironment';
import { ExternalAgentConnection } from '../ExternalAgentConnection';
import { registerBoundControlHttp } from '../registerBoundControlHttp';

import type { ExternalAgentConnectionApi } from '../../contracts';
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
    stop(options?: { preventRestart?: boolean }): Promise<void>;
    appContext: { bind(env: Record<string, string | undefined>, httpEnabled: boolean): () => void };
  };
  httpEnabled: boolean;
}

export interface DesktopExternalAgentConnection extends ExternalAgentConnectionApi {
  registerHttp(app: FastifyInstance): void;
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
    return Object.freeze({
      [BOUND_CONTROL_URL_ENV]: controlUrl,
      [BOUND_CONTROL_CONTEXT_ENV]: JSON.stringify(context.snapshot()),
      AGENT_TEAMS_MCP_CLAUDE_DIR: deps.getRoot(),
    });
  });
  const connection = new ExternalAgentConnection({
    ...deps,
    context,
    getProfileFingerprint: () => profileFingerprint,
    startControl: async () => {
      if (stopping || !deps.httpEnabled) throw new Error('Desktop MCP HTTP connection is disabled');
      await deps.startControl();
    },
  });
  const retryConnection = () =>
    serialize(async () => {
      if (!stopping && deps.isLocalContext() && !context.isOpen) {
        await deps.reconfigureRoot();
        bindAuthority();
        context.rebind(deps.getRoot());
      }
      return connection.retryConnection();
    });
  const change = (operation: () => Promise<void> | void, rootChanged: boolean) =>
    serialize(async () => {
      if (stopping) throw new Error('App connection is shutting down');
      await context.closeAdmission();
      await deps.mcp.stop();
      revokeAuthority?.();
      revokeAuthority = null;
      await operation();
      if (rootChanged) await deps.reconfigureRoot();
      bindAuthority();
      if (!stopping && deps.isLocalContext()) {
        context.rebind(deps.getRoot());
        await connection.retryConnection();
      }
      // A failed operation leaves admission closed until an explicit recovery.
    });
  const closeAdmission = (): Promise<void> => {
    stopping = true;
    shutdownDrain ??= context.closeAdmission();
    return shutdownDrain;
  };
  return {
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
      const drained = closeAdmission();
      return serialize(async () => {
        await drained;
        revokeAuthority?.();
        revokeAuthority = null;
        await deps.mcp.stop({ preventRestart: true });
        revokeEnvironment();
      });
    },
  };
}
