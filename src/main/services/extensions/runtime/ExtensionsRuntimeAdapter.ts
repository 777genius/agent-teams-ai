import { buildProviderAwareCliEnv } from '@main/services/runtime/providerAwareCliEnv';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { getConfiguredCliFlavor } from '@main/services/team/cliFlavor';
import { execCli } from '@main/utils/childProcess';
import { CLI_NOT_FOUND_MESSAGE } from '@shared/constants/cli';

import { McpConfigStateReader } from './McpConfigStateReader';
import { parseMcpDiagnosticsJsonOutput, parseMcpDiagnosticsOutput } from './mcpDiagnosticsParser';
import { parseInstalledMcpJsonOutput } from './mcpRuntimeJson';

import type { CliFlavor } from '@shared/types';
import type { InstalledMcpEntry, McpServerDiagnostic } from '@shared/types/extensions';

const MCP_LIST_TIMEOUT_MS = 15_000;
const MCP_DIAGNOSE_TIMEOUT_MS = 60_000;

async function buildManagementCliEnvForBinary(binaryPath: string): Promise<NodeJS.ProcessEnv> {
  const { env } = await buildProviderAwareCliEnv({
    binaryPath,
    connectionMode: 'augment',
  });
  return env;
}

export interface ExtensionsRuntimeAdapter {
  readonly flavor: CliFlavor;
  buildManagementCliEnv(binaryPath: string): Promise<NodeJS.ProcessEnv>;
  getInstalledMcp(projectPath?: string): Promise<InstalledMcpEntry[]>;
  diagnoseMcp(projectPath?: string): Promise<McpServerDiagnostic[]>;
}

export class ClaudeExtensionsAdapter implements ExtensionsRuntimeAdapter {
  readonly flavor = 'claude' as const;

  constructor(private readonly stateReader = new McpConfigStateReader()) {}

  async buildManagementCliEnv(binaryPath: string): Promise<NodeJS.ProcessEnv> {
    return buildManagementCliEnvForBinary(binaryPath);
  }

  async getInstalledMcp(projectPath?: string): Promise<InstalledMcpEntry[]> {
    return this.stateReader.readInstalled(projectPath);
  }

  async diagnoseMcp(projectPath?: string): Promise<McpServerDiagnostic[]> {
    const binaryPath = await ClaudeBinaryResolver.resolve();
    if (!binaryPath) {
      throw new Error(CLI_NOT_FOUND_MESSAGE);
    }

    const env = await this.buildManagementCliEnv(binaryPath);
    const { stdout, stderr } = await execCli(binaryPath, ['mcp', 'list'], {
      timeout: MCP_DIAGNOSE_TIMEOUT_MS,
      cwd: projectPath,
      env,
    });

    return parseMcpDiagnosticsOutput([stdout, stderr].filter(Boolean).join('\n'));
  }
}

export class MultimodelExtensionsAdapter implements ExtensionsRuntimeAdapter {
  readonly flavor = 'agent_teams_orchestrator' as const;

  async buildManagementCliEnv(binaryPath: string): Promise<NodeJS.ProcessEnv> {
    return buildManagementCliEnvForBinary(binaryPath);
  }

  async getInstalledMcp(projectPath?: string): Promise<InstalledMcpEntry[]> {
    const binaryPath = await ClaudeBinaryResolver.resolve();
    if (!binaryPath) {
      throw new Error(CLI_NOT_FOUND_MESSAGE);
    }

    const env = await this.buildManagementCliEnv(binaryPath);
    const { stdout } = await execCli(binaryPath, ['mcp', 'list', '--json'], {
      timeout: MCP_LIST_TIMEOUT_MS,
      cwd: projectPath,
      env,
    });

    return parseInstalledMcpJsonOutput(stdout);
  }

  async diagnoseMcp(projectPath?: string): Promise<McpServerDiagnostic[]> {
    const binaryPath = await ClaudeBinaryResolver.resolve();
    if (!binaryPath) {
      throw new Error(CLI_NOT_FOUND_MESSAGE);
    }

    const env = await this.buildManagementCliEnv(binaryPath);
    const { stdout } = await execCli(binaryPath, ['mcp', 'diagnose', '--json'], {
      timeout: MCP_DIAGNOSE_TIMEOUT_MS,
      cwd: projectPath,
      env,
    });

    return parseMcpDiagnosticsJsonOutput(stdout);
  }
}

class RuntimeSwitchingExtensionsAdapter implements ExtensionsRuntimeAdapter {
  constructor(
    private readonly claudeAdapter: ClaudeExtensionsAdapter,
    private readonly multimodelAdapter: MultimodelExtensionsAdapter
  ) {}

  private getActiveAdapter(): ExtensionsRuntimeAdapter {
    return getConfiguredCliFlavor() === 'claude' ? this.claudeAdapter : this.multimodelAdapter;
  }

  get flavor(): CliFlavor {
    return this.getActiveAdapter().flavor;
  }

  buildManagementCliEnv(binaryPath: string): Promise<NodeJS.ProcessEnv> {
    return this.getActiveAdapter().buildManagementCliEnv(binaryPath);
  }

  getInstalledMcp(projectPath?: string): Promise<InstalledMcpEntry[]> {
    return this.getActiveAdapter().getInstalledMcp(projectPath);
  }

  diagnoseMcp(projectPath?: string): Promise<McpServerDiagnostic[]> {
    return this.getActiveAdapter().diagnoseMcp(projectPath);
  }
}

export function createExtensionsRuntimeAdapter(): ExtensionsRuntimeAdapter {
  return new RuntimeSwitchingExtensionsAdapter(
    new ClaudeExtensionsAdapter(),
    new MultimodelExtensionsAdapter()
  );
}
