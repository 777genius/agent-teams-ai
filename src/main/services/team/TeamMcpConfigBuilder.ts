import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';

interface McpLaunchSpec {
  command: string;
  args: string[];
}

const MCP_SERVER_NAME = 'agent-teams';

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
  async writeConfigFile(): Promise<string> {
    const launchSpec = await resolveMcpLaunchSpec();
    const configDir = path.join(os.tmpdir(), 'claude-team-mcp');
    const configPath = path.join(configDir, `agent-teams-mcp-${randomUUID()}.json`);

    await fs.promises.mkdir(configDir, { recursive: true });
    await atomicWriteAsync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            [MCP_SERVER_NAME]: {
              command: launchSpec.command,
              args: launchSpec.args,
            },
          },
        },
        null,
        2
      )
    );

    return configPath;
  }
}
