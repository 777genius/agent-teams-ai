import { getMcpConfigsBasePath, getMcpServerBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';

export interface McpLaunchSpec {
  command: string;
  args: string[];
}

const MCP_SERVER_NAME = 'agent-teams';
const logger = createLogger('Service:TeamMcpConfigBuilder');
const MCP_CONFIG_PREFIX = 'agent-teams-mcp-';
const MCP_CONFIG_REMOVE_RETRY_DELAYS_MS = [25, 75, 150] as const;
/**
 * Stale configs older than this are removed on startup (best-effort).
 * 7 days is intentionally long: respawnAfterAuthFailure() reuses saved
 * --mcp-config paths, so shorter TTLs risk deleting configs still needed
 * by long-running or retrying sessions in other app instances.
 */
const MCP_CONFIG_STALE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type McpServerConfig = Record<string, unknown>;

function isPackagedApp(): boolean {
  try {
    const { app } = require('electron') as typeof import('electron');
    return app.isPackaged;
  } catch {
    return false;
  }
}

function getAppVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    return app.getVersion();
  } catch {
    return '0.0.0-dev';
  }
}

/**
 * In a packaged Electron build the mcp-server bundle lives under
 * `process.resourcesPath/mcp-server/index.js` (copied via extraResources).
 * This is the fallback location when the stable copy is unavailable.
 */
function getPackagedServerEntry(): string {
  return path.join(process.resourcesPath, 'mcp-server', 'index.js');
}

function getWorkspaceRoot(): string {
  return process.cwd();
}

function getWorkspaceMcpServerDir(): string {
  return path.join(getWorkspaceRoot(), 'mcp-server');
}

function getBuiltServerEntry(): string {
  return path.join(getWorkspaceMcpServerDir(), 'dist', 'index.js');
}

function getSourceServerEntry(): string {
  return path.join(getWorkspaceMcpServerDir(), 'src', 'index.ts');
}

function getWorkspaceTsxBinCandidates(): string[] {
  return [
    path.join(getWorkspaceMcpServerDir(), 'node_modules', '.bin', 'tsx'),
    path.join(getWorkspaceRoot(), 'node_modules', '.bin', 'tsx'),
  ];
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function shouldRetryMcpConfigRemoval(error: NodeJS.ErrnoException): boolean {
  return error.code === 'EPERM' || error.code === 'EBUSY';
}

async function waitForRetry(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** Check that both index.js and package.json exist in a directory. */
async function hasValidServerCopy(dir: string): Promise<boolean> {
  return (
    (await pathExists(path.join(dir, 'index.js'))) &&
    (await pathExists(path.join(dir, 'package.json')))
  );
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

/**
 * For packaged builds, copy the MCP server to a stable, writable location
 * under userData so the server runs from a non-FUSE path (fixes AppImage).
 *
 * Uses a versioned subdirectory + atomic rename to avoid partial state:
 *   userData/mcp-server/<appVersion>/index.js
 *   userData/mcp-server/<appVersion>/package.json
 *
 * Returns the resolved index.js path (stable copy or resourcesPath fallback).
 */
async function resolvePackagedServerEntry(): Promise<string> {
  const fallbackEntry = getPackagedServerEntry();
  if (!isPackagedApp()) return fallbackEntry;

  const appVersion = getAppVersion();
  const baseDir = getMcpServerBasePath();
  const finalDir = path.join(baseDir, appVersion);
  const finalEntry = path.join(finalDir, 'index.js');

  // Reuse existing valid copy
  if (await hasValidServerCopy(finalDir)) {
    return finalEntry;
  }

  // Heal invalid finalDir (partial state from previous crash)
  try {
    if ((await pathExists(finalDir)) && !(await hasValidServerCopy(finalDir))) {
      logger.warn(`Removing invalid MCP server copy at ${finalDir}`);
      await fs.promises.rm(finalDir, { recursive: true, force: true });
    }
  } catch {
    /* best-effort heal */
  }

  try {
    const sourceDir = path.join(process.resourcesPath, 'mcp-server');
    if (!(await hasValidServerCopy(sourceDir))) {
      logger.warn(`Packaged MCP server missing in resourcesPath: ${sourceDir}`);
      return fallbackEntry;
    }

    // Atomic: copy to temp dir, then rename to final
    const tmpDir = path.join(baseDir, `${appVersion}.tmp-${process.pid}-${randomUUID()}`);
    await fs.promises.mkdir(tmpDir, { recursive: true });
    await fs.promises.copyFile(path.join(sourceDir, 'index.js'), path.join(tmpDir, 'index.js'));
    await fs.promises.copyFile(
      path.join(sourceDir, 'package.json'),
      path.join(tmpDir, 'package.json')
    );

    try {
      await fs.promises.rename(tmpDir, finalDir);
    } catch {
      // finalDir appeared between our check and rename (another process won the race)
      await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      if (await hasValidServerCopy(finalDir)) {
        logger.info(`Using stable MCP server copy at ${finalDir} (concurrent copy resolved)`);
        return finalEntry;
      }
      // Neither our copy nor the winner's copy is valid — fallback
      logger.warn(`Concurrent MCP server copy failed, using resourcesPath fallback`);
      return fallbackEntry;
    }

    logger.info(`MCP server copied to stable path ${finalDir} (v${appVersion})`);
    return finalEntry;
  } catch (error) {
    logger.warn(
      `Failed to copy MCP server to stable path, using resourcesPath fallback: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return fallbackEntry;
  }
}

export async function resolveAgentTeamsMcpLaunchSpec(): Promise<McpLaunchSpec> {
  const checked: string[] = [];

  // 1. Packaged Electron app — prefer stable copy, fall back to resourcesPath
  if (isPackagedApp()) {
    const packagedEntry = await resolvePackagedServerEntry();
    checked.push(packagedEntry);
    if (await pathExists(packagedEntry)) {
      return {
        command: await resolveNodePath(),
        args: [packagedEntry],
      };
    }
    logger.warn(`Packaged MCP entry not found at ${packagedEntry}, falling back to workspace`);
  }

  // 2. Dev mode — prefer source so pnpm dev always sees current MCP tools
  const sourceEntry = getSourceServerEntry();
  checked.push(sourceEntry);
  if (await pathExists(sourceEntry)) {
    for (const tsxBin of getWorkspaceTsxBinCandidates()) {
      checked.push(tsxBin);
      if (await pathExists(tsxBin)) {
        return {
          command: tsxBin,
          args: [sourceEntry],
        };
      }
    }
  }

  // 3. Dev mode fallback — use built dist when source execution is unavailable
  const builtEntry = getBuiltServerEntry();
  checked.push(builtEntry);
  if (await pathExists(builtEntry)) {
    return {
      command: await resolveNodePath(),
      args: [builtEntry],
    };
  }

  throw new Error(
    `agent-teams-mcp entrypoint not found. Checked paths:\n${checked.map((p) => `  - ${p}`).join('\n')}`
  );
}

export class TeamMcpConfigBuilder {
  async writeConfigFile(_projectPath?: string): Promise<string> {
    const launchSpec = await resolveAgentTeamsMcpLaunchSpec();
    const configDir = getMcpConfigsBasePath();
    const configPath = path.join(
      configDir,
      `${MCP_CONFIG_PREFIX}${process.pid}-${Date.now()}-${randomUUID()}.json`
    );
    // Keep the team bootstrap config minimal: recent Claude sidechain runs can
    // lose the agent-teams tool surface when we inline large user MCP bundles
    // into the generated --mcp-config. User/project/local MCP remain loaded
    // through Claude's native settings sources.
    const generatedServers: Record<string, McpServerConfig> = {
      [MCP_SERVER_NAME]: {
        command: launchSpec.command,
        args: launchSpec.args,
      },
    };

    await fs.promises.mkdir(configDir, { recursive: true });
    await atomicWriteAsync(
      configPath,
      JSON.stringify(
        {
          mcpServers: generatedServers,
        },
        null,
        2
      )
    );

    return configPath;
  }

  /** Delete a single MCP config file (best-effort). */
  async removeConfigFile(configPath: string): Promise<void> {
    for (let attempt = 0; attempt <= MCP_CONFIG_REMOVE_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        await fs.promises.unlink(configPath);
        return;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          return;
        }
        if (
          shouldRetryMcpConfigRemoval(err) &&
          attempt < MCP_CONFIG_REMOVE_RETRY_DELAYS_MS.length
        ) {
          await waitForRetry(MCP_CONFIG_REMOVE_RETRY_DELAYS_MS[attempt]);
          continue;
        }
        if (shouldRetryMcpConfigRemoval(err)) {
          logger.debug(`Deferred MCP config cleanup for ${configPath}: ${err.message}`);
          return;
        }
        logger.warn(`Failed to remove MCP config ${configPath}: ${err.message}`);
        return;
      }
    }
  }

  /** Remove config files owned by current process (shutdown best-effort). */
  async gcOwnConfigs(): Promise<void> {
    const configDir = getMcpConfigsBasePath();
    const ownPrefix = `${MCP_CONFIG_PREFIX}${process.pid}-`;
    try {
      const entries = await fs.promises.readdir(configDir);
      await Promise.all(
        entries
          .filter((n) => n.startsWith(ownPrefix) && n.endsWith('.json'))
          .map((n) => fs.promises.unlink(path.join(configDir, n)).catch(() => {}))
      );
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        logger.warn(`Failed to GC own MCP configs: ${err.message}`);
      }
    }
  }

  /**
   * Remove stale config files older than maxAgeMs (startup GC, best-effort).
   * Risk is reduced but not eliminated for multi-instance scenarios:
   * respawnAfterAuthFailure() has its own recovery to regenerate deleted configs.
   */
  async gcStaleConfigs(maxAgeMs = MCP_CONFIG_STALE_MAX_AGE_MS): Promise<void> {
    const configDir = getMcpConfigsBasePath();
    try {
      const entries = await fs.promises.readdir(configDir);
      await Promise.all(
        entries
          .filter((n) => n.startsWith(MCP_CONFIG_PREFIX) && n.endsWith('.json'))
          .map(async (n) => {
            const fullPath = path.join(configDir, n);
            try {
              const stat = await fs.promises.stat(fullPath);
              if (Date.now() - stat.mtimeMs > maxAgeMs) {
                await fs.promises.unlink(fullPath);
              }
            } catch {
              /* ignore per-file errors */
            }
          })
      );
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        logger.warn(`Failed to GC stale MCP configs: ${err.message}`);
      }
    }
  }
}
