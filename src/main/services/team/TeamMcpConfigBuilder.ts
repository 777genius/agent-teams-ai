import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getHomeDir } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import { atomicWriteAsync } from './atomicWrite';

interface McpLaunchSpec {
  command: string;
  args: string[];
}

const MCP_SERVER_NAME = 'agent-teams';
const logger = createLogger('Service:TeamMcpConfigBuilder');
const USER_MCP_CONFIG_NAME = '.claude.json';

type McpServerConfig = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getWorkspaceRoot(): string {
  return process.cwd();
}

function getMcpServerDir(): string {
  return path.join(getWorkspaceRoot(), 'mcp-server');
}

function getBuiltServerEntry(): string {
  return path.join(getMcpServerDir(), 'dist', 'index.js');
}

function getSourceServerEntry(): string {
  return path.join(getMcpServerDir(), 'src', 'index.ts');
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

let _resolvedNodePath: string | undefined;

/**
 * Find the real `node` binary path. In Electron, process.execPath is the
 * Electron binary — NOT node — so we must resolve node separately.
 * Uses async execFile('node', ...) which is cross-platform (no /usr/bin/env dependency).
 */
async function resolveNodePath(): Promise<string> {
  if (_resolvedNodePath) return _resolvedNodePath;

  try {
    const resolved = await new Promise<string>((resolve, reject) => {
      execFile(
        'node',
        ['-e', 'process.stdout.write(process.execPath)'],
        {
          encoding: 'utf-8',
          timeout: 5000,
        },
        (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))
      );
    });
    if (resolved) {
      _resolvedNodePath = resolved;
      return _resolvedNodePath;
    }
  } catch {
    // node not found or timed out — use bare 'node' and let the OS resolve it
  }
  _resolvedNodePath = 'node';
  return _resolvedNodePath;
}

async function resolveMcpLaunchSpec(): Promise<McpLaunchSpec> {
  const sourceEntry = getSourceServerEntry();
  if (await pathExists(sourceEntry)) {
    // Prefer source in workspace/dev runs so newly added MCP tools are available
    // immediately and we do not accidentally serve a stale built dist bundle.
    return {
      command: 'pnpm',
      args: ['--dir', getMcpServerDir(), 'exec', 'tsx', sourceEntry],
    };
  }

  const builtEntry = getBuiltServerEntry();
  if (await pathExists(builtEntry)) {
    return {
      command: await resolveNodePath(),
      args: [builtEntry],
    };
  }

  throw new Error('agent-teams-mcp entrypoint not found in mcp-server package');
}

export class TeamMcpConfigBuilder {
  async writeConfigFile(_projectPath?: string): Promise<string> {
    const launchSpec = await resolveMcpLaunchSpec();
    const configDir = path.join(os.tmpdir(), 'claude-team-mcp');
    const configPath = path.join(configDir, `agent-teams-mcp-${randomUUID()}.json`);
    const userServers = await this.readUserMcpServers();
    const generatedServers: Record<string, McpServerConfig> = {
      [MCP_SERVER_NAME]: {
        command: launchSpec.command,
        args: launchSpec.args,
      },
    };
    const mergedServers = this.mergeServers(userServers, generatedServers);

    await fs.promises.mkdir(configDir, { recursive: true });
    await atomicWriteAsync(
      configPath,
      JSON.stringify(
        {
          mcpServers: mergedServers,
        },
        null,
        2
      )
    );

    return configPath;
  }

  private async readUserMcpServers(): Promise<Record<string, McpServerConfig>> {
    const configPath = path.join(getHomeDir(), USER_MCP_CONFIG_NAME);
    return this.readMcpServersFromFile(configPath, 'user');
  }

  private async readMcpServersFromFile(
    filePath: string,
    scope: 'user'
  ): Promise<Record<string, McpServerConfig>> {
    try {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const mcpServers = parsed.mcpServers;
      if (!isRecord(mcpServers)) {
        return {};
      }

      return Object.fromEntries(
        Object.entries(mcpServers).filter(([, config]) => isRecord(config))
      ) as Record<string, McpServerConfig>;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return {};
      }

      logger.warn(
        `Failed to read ${scope} MCP config from ${filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return {};
    }
  }

  private mergeServers(
    userServers: Record<string, McpServerConfig>,
    generatedServers: Record<string, McpServerConfig>
  ): Record<string, McpServerConfig> {
    const duplicates = Object.keys(userServers).filter((name) =>
      Object.hasOwn(generatedServers, name)
    );

    if (duplicates.length > 0) {
      logger.info(`Merging MCP configs with overrides for: ${duplicates.join(', ')}`);
    }

    // We inline only top-level user MCP into --mcp-config.
    // Project/local scopes are still loaded natively by Claude via
    // --setting-sources user,project,local, which preserves documented precedence:
    // local > project > user. Generated agent-teams must always win on name collision.
    return {
      ...userServers,
      ...generatedServers,
    };
  }
}
