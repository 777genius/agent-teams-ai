import {
  createDesktopExternalAgentConnection,
  ExternalAgentRunService,
  type NativeRendererCdp,
  prepareNativeAgentRun,
} from '@features/external-agent-connection/main';
import { buildMemberWorkSyncRuntimeTurnSettledEnvironment } from '@features/member-work-sync/main';
import { CodexBinaryResolver } from '@main/services/infrastructure/codexAppServer/CodexBinaryResolver';
import { ConfigManager } from '@main/services/infrastructure/ConfigManager';
import { applyAgentTeamsMcpAppContext } from '@main/services/runtime/agentTeamsMcpLaunchEnv';
import { agentTeamsMcpHttpServer } from '@main/services/team/AgentTeamsMcpHttpServer';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import {
  isOpenCodeMcpHttpBridgeEnabled,
  mergeOpenCodeLocalMcpChildEnvironment,
} from '@main/services/team/opencode/bridge/OpenCodeMcpBridgeEnv';
import { getClaudeBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import { app, type WebContents } from 'electron';

import {
  composeTeamPromptManagement,
  type TeamPromptManagementData,
  type TeamPromptManagementLifecycle,
} from './startTeamPromptManagement';

import type { CodexAccountSnapshotDto } from '@features/codex-account/contracts';
import type { TeamPromptManagement } from '@features/team-prompt-management/main';
import type { CliInstallerService } from '@main/services/infrastructure/CliInstallerService';
import type { TeamChangeEvent } from '@shared/types';

const configManager = ConfigManager.getInstance();

/** App-shell dependencies stay at the composition boundary, outside connection policy. */
export function composeExternalAgentConnection(options: {
  appInstanceId: string;
  nativeRun: [
    status: Pick<CliInstallerService, 'getProviderStatus'>,
    account: () => Promise<CodexAccountSnapshotDto> | undefined,
  ];
  cdp: NativeRendererCdp;
  getMainContents(): WebContents | null;
  isLocalContext(): boolean;
  getControlUrl(): string | null;
  startControl(): Promise<void>;
  reconfigureRoot(): Promise<void>;
  hasLiveRuntimeConsumers?(): boolean;
  teamManagement?: [
    data: TeamPromptManagementData,
    lifecycle: TeamPromptManagementLifecycle,
    emit: (event: TeamChangeEvent) => void,
  ];
}) {
  let teamPromptManagement: TeamPromptManagement | undefined;
  const connection = createDesktopExternalAgentConnection({
    ...options,
    hasTeamManagement: () => Boolean(teamPromptManagement),
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
  if (options.teamManagement) {
    const [data, lifecycle, emit] = options.teamManagement;
    teamPromptManagement = composeTeamPromptManagement(data, lifecycle, connection, emit);
  }
  const directRun = new ExternalAgentRunService({
    async getAvailability() {
      const [codex, anthropic] = await Promise.all([
        CodexBinaryResolver.resolve().catch(() => null),
        ClaudeBinaryResolver.resolveNative().catch(() => null),
      ]);
      return { codex: Boolean(codex), anthropic: Boolean(anthropic) };
    },
    getConnectionInfo: connection.getConnectionInfo,
    withExpectedContext: connection.withExpectedContext,
    getProviderStatus: (providerId) => options.nativeRun[0].getProviderStatus(providerId),
    getCodexLaunchAllowed: async () => (await options.nativeRun[1]())?.launchAllowed === true,
    prepare: (provider, connectionInfo) =>
      prepareNativeAgentRun(provider, connectionInfo, {
        controlUrl: options.getControlUrl(),
        claudeDir: getClaudeBasePath(),
      }),
  });
  return {
    ...connection,
    directRun,
    teamPromptManagement,
    async updateRoot(applyConfig: () => void) {
      await directRun.stopCurrent();
      return connection.updateRoot(applyConfig);
    },
    async changeContext(operation: () => Promise<void> | void) {
      await directRun.stopCurrent();
      return connection.changeContext(operation);
    },
    async closeAdmission() {
      const drain = connection.closeAdmission();
      try {
        await directRun.shutdown();
      } finally {
        await drain;
      }
    },
    async shutdown() {
      try {
        await directRun.shutdown();
      } finally {
        await connection.shutdown();
      }
    },
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
