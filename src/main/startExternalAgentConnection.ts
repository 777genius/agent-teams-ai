import {
  createDesktopExternalAgentConnection,
  type NativeRendererCdp,
} from '@features/external-agent-connection/main';
import { buildMemberWorkSyncRuntimeTurnSettledEnvironment } from '@features/member-work-sync/main';
import { ConfigManager } from '@main/services/infrastructure/ConfigManager';
import { applyAgentTeamsMcpAppContext } from '@main/services/runtime/agentTeamsMcpLaunchEnv';
import { agentTeamsMcpHttpServer } from '@main/services/team/AgentTeamsMcpHttpServer';
import {
  isOpenCodeMcpHttpBridgeEnabled,
  mergeOpenCodeLocalMcpChildEnvironment,
} from '@main/services/team/opencode/bridge/OpenCodeMcpBridgeEnv';
import { getClaudeBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import { app, type WebContents } from 'electron';

const configManager = ConfigManager.getInstance();

/** App-shell dependencies stay at the composition boundary, outside connection policy. */
export function composeExternalAgentConnection(options: {
  appInstanceId: string;
  cdp: NativeRendererCdp;
  getMainContents(): WebContents | null;
  isLocalContext(): boolean;
  getControlUrl(): string | null;
  startControl(): Promise<void>;
  reconfigureRoot(): Promise<void>;
  hasLiveRuntimeConsumers?(): boolean;
}) {
  const connection = createDesktopExternalAgentConnection({
    ...options,
    userDataPath: app.getPath('userData'),
    getRoot: getClaudeBasePath,
    getCdpEnabled: () => configManager.getConfig().general.externalAgentCdpEnabled === true,
    getAppVersion: () => app.getVersion(),
    mcp: agentTeamsMcpHttpServer,
    httpEnabled: isOpenCodeMcpHttpBridgeEnabled(),
    assertNoLiveRuntimeConsumers: () => {
      if (isOpenCodeMcpHttpBridgeEnabled() && options.hasLiveRuntimeConsumers?.()) {
        throw new Error('Stop teams using MCP before changing the app root or context.');
      }
    },
  });
  return {
    ...connection,
    async start(): Promise<void> {
      if (!isOpenCodeMcpHttpBridgeEnabled() && configManager.getConfig().httpServer?.enabled) {
        await options.startControl().catch(() => undefined);
      }
      await connection.retryConnection();
    },
  };
}

/** Refresh only main-owned command copies; running agents retain their original context. */
export async function refreshDesktopBridgeEnvironment(env: NodeJS.ProcessEnv): Promise<void> {
  const root = getClaudeBasePath();
  const authority = agentTeamsMcpHttpServer.appContext.read(root);
  if (env.AGENT_TEAMS_MCP_CLAUDE_DIR !== root) {
    // Never retain an old-root spool when initialization of the new one fails.
    delete env.AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT;
    const turnEnvironment = await buildMemberWorkSyncRuntimeTurnSettledEnvironment({
      teamsBasePath: getTeamsBasePath(),
      provider: 'opencode',
    });
    if (getClaudeBasePath() !== root) throw new Error('App root changed during bridge preparation');
    Object.assign(env, turnEnvironment);
  }
  if (authority) {
    mergeOpenCodeLocalMcpChildEnvironment(env, {
      CLAUDE_TEAM_APP_INSTANCE_ID: authority.CLAUDE_TEAM_APP_INSTANCE_ID!,
      CLAUDE_TEAM_APP_PROFILE_SCOPE: authority.CLAUDE_TEAM_APP_PROFILE_SCOPE!,
      AGENT_TEAMS_MCP_CLAUDE_DIR: root,
    });
  }
  applyAgentTeamsMcpAppContext(env, root);
}
