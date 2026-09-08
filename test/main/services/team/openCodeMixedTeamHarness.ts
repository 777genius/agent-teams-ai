import * as path from 'node:path';

import Fastify from 'fastify';

import { registerTeamRoutes } from '../../../../src/main/http/teams';
import { OpenCodeBridgeCommandClient } from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandClient';
import {
  createOpenCodeBridgeCommandLeaseStore,
  createOpenCodeBridgeCommandLedgerStore,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandLedgerStore';
import {
  createOpenCodeBridgeClientIdentity,
  OpenCodeBridgeCommandHandshakePort,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeHandshakeClient';
import { OpenCodeReadinessBridge } from '../../../../src/main/services/team/opencode/bridge/OpenCodeReadinessBridge';
import { OpenCodeStateChangingBridgeCommandService } from '../../../../src/main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';
import { OpenCodeRuntimeLaunchAuthorityWriter } from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeLaunchAuthorityWriter';
import { OpenCodeRuntimeManifestEvidenceReader } from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { OpenCodeTeamRuntimeAdapter } from '../../../../src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter';
import { TeamRuntimeAdapterRegistry } from '../../../../src/main/services/team/runtime/TeamRuntimeAdapter';
import { resolveAgentTeamsMcpLaunchSpec } from '../../../../src/main/services/team/TeamMcpConfigBuilder';
import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import { getTeamsBasePath } from '../../../../src/main/utils/pathDecoder';

import { buildLiveTeamControlApiServices } from './openCodeLiveTestHarness';

import type { HttpServices } from '../../../../src/main/http';

// Preserve wrapper-owned HOME/XDG and expose cleanup evidence; generic harness overrides HOME.
export async function createMixedHarness(tempDir: string, claudeRoot: string) {
  const svc = new TeamProvisioningService();
  const app = Fastify({ logger: false });
  registerTeamRoutes(app, buildLiveTeamControlApiServices(svc) as HttpServices);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Control API unavailable');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  svc.setControlApiBaseUrlResolver(async () => baseUrl);
  const mcp = await resolveAgentTeamsMcpLaunchSpec();
  // Wrapper already allowlists process.env and provides isolated HOME/XDG paths.
  const bridgeClient = new OpenCodeBridgeCommandClient({
    binaryPath: process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH!,
    tempDirectory: path.join(tempDir, 'bridge-input'),
    env: {
      ...process.env,
      AGENT_TEAMS_MCP_CLAUDE_DIR: claudeRoot,
      CLAUDE_TEAM_CONTROL_URL: baseUrl,
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: mcp.command,
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: mcp.args[0] ?? '',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: JSON.stringify(mcp.args),
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON: JSON.stringify(mcp.env ?? {}),
    },
  });
  const clientIdentity = createOpenCodeBridgeClientIdentity({
    appVersion: '1.3.0-e2e',
    gitSha: null,
    buildId: 'full-team-proof',
  });
  const stateChangingCommands = new OpenCodeStateChangingBridgeCommandService({
    expectedClientIdentity: clientIdentity,
    handshakePort: new OpenCodeBridgeCommandHandshakePort({ bridge: bridgeClient, clientIdentity }),
    leaseStore: createOpenCodeBridgeCommandLeaseStore({
      filePath: path.join(tempDir, 'leases.json'),
    }),
    ledger: createOpenCodeBridgeCommandLedgerStore({ filePath: path.join(tempDir, 'ledger.json') }),
    bridge: bridgeClient,
    manifestReader: new OpenCodeRuntimeManifestEvidenceReader({
      teamsBasePath: getTeamsBasePath(),
    }),
    launchAuthorityWriter: new OpenCodeRuntimeLaunchAuthorityWriter({
      teamsBasePath: getTeamsBasePath(),
    }),
  });
  const readiness = new OpenCodeReadinessBridge(bridgeClient, {
    stateChangingCommands,
    timeoutMs: 180_000,
    launchTimeoutMs: 180_000,
    reconcileTimeoutMs: 90_000,
    stopTimeoutMs: 90_000,
  });
  svc.setRuntimeAdapterRegistry(
    new TeamRuntimeAdapterRegistry([new OpenCodeTeamRuntimeAdapter(readiness)])
  );
  return {
    svc,
    bridgeClient,
    readiness,
    close: async () => {
      svc.setControlApiBaseUrlResolver(null);
      await app.close();
    },
  };
}
