import { execCli } from '@main/utils/childProcess';
import { buildMergedCliPath } from '@main/utils/cliPathMerge';
import { ensureMinimumNodeOldSpaceOptions } from '@main/utils/nodeOptions';
import {
  getClaudeBasePath,
  getMcpConfigsBasePath,
  getMcpServerBasePath,
} from '@main/utils/pathDecoder';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import { createLogger } from '@shared/utils/logger';
import { resolveTeamMemberMcpScopes } from '@shared/utils/teamMemberMcpPolicy';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { McpConfigStateReader } from '../extensions/runtime/McpConfigStateReader';

import { atomicWriteAsync, renamePathWithRetry } from './atomicWrite';

import type { TeamMemberMcpPolicy, TeamMemberMcpScope } from '@shared/types';

export interface McpLaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpLaunchSpecResolveProgress {
  phase: string;
  message: string;
}

export interface McpLaunchSpecResolveOptions {
  onProgress?: (progress: McpLaunchSpecResolveProgress) => void;
}

interface WriteMcpConfigOptions {
  mcpPolicy?: TeamMemberMcpPolicy;
  controlApiBaseUrl?: string | null;
}

const MCP_SERVER_NAME = 'agent-teams';
const MCP_CLAUDE_DIR_ENV = 'AGENT_TEAMS_MCP_CLAUDE_DIR';
const MCP_CONTROL_URL_ENV = 'CLAUDE_TEAM_CONTROL_URL';
const ELECTRON_RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE';
const logger = createLogger('Service:TeamMcpConfigBuilder');
const MCP_CONFIG_PREFIX = 'agent-teams-mcp-';
const MCP_CONFIG_REMOVE_RETRY_DELAYS_MS = [25, 75, 150] as const;
const NODE_RUNTIME_PROBE_TIMEOUT_MS = 5_000;
const ELECTRON_NODE_RUNTIME_PROBE_TIMEOUT_MS = 5_000;
// The packaged Electron runtime can lag the source toolchain patch version,
// so MCP launch validation pins the Node 24 runtime line, not .node-version.
const MIN_MCP_NODE_MAJOR_VERSION = 24;
const MAX_MCP_NODE_MAJOR_VERSION = 25;
const NODE_RUNTIME_PROBE_SCRIPT =
  'process.stdout.write(JSON.stringify({execPath:process.execPath,version:process.versions.node}))';
/**
 * Stale configs older than this are removed on startup (best-effort).
 * 7 days is intentionally long: respawnAfterAuthFailure() reuses saved
 * --mcp-config paths, so shorter TTLs risk deleting configs still needed
 * by long-running or retrying sessions in other app instances.
 */
const MCP_CONFIG_STALE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type McpServerConfig = Record<string, unknown>;

interface NodeRuntimeProbeMetadata {
  path: string;
  version: string;
}

const MCP_CONFIG_SCOPE_PRECEDENCE: readonly TeamMemberMcpScope[] = ['user', 'project', 'local'];

function isPackagedApp(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    return app.isPackaged;
  } catch {
    return false;
  }
}

function normalizeMcpServerNodeOptions(config: McpServerConfig): McpServerConfig {
  const env = config.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return config;
  }

  const nodeOptions = (env as Record<string, unknown>).NODE_OPTIONS;
  if (typeof nodeOptions !== 'string') {
    return config;
  }

  const normalizedNodeOptions = ensureMinimumNodeOldSpaceOptions(nodeOptions);
  if (!normalizedNodeOptions || normalizedNodeOptions === nodeOptions) {
    return config;
  }

  return {
    ...config,
    env: {
      ...(env as Record<string, unknown>),
      NODE_OPTIONS: normalizedNodeOptions,
    },
  };
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

function shouldUsePackagedElectronNodeRuntime(): boolean {
  return (
    isPackagedApp() && typeof process.execPath === 'string' && process.execPath.trim().length > 0
  );
}

function getPackagedElectronNodeEnv(): Record<string, string> {
  return {
    [ELECTRON_RUN_AS_NODE_ENV]: '1',
  };
}

function buildPackagedElectronNodeLaunchSpec(entry: string): McpLaunchSpec {
  return {
    command: process.execPath.trim(),
    args: [entry],
    env: getPackagedElectronNodeEnv(),
  };
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

function getWorkspaceTsxPackageJsonCandidates(): string[] {
  return [
    path.join(getWorkspaceMcpServerDir(), 'node_modules', 'tsx', 'package.json'),
    path.join(getWorkspaceRoot(), 'node_modules', 'tsx', 'package.json'),
  ];
}

function resolvePackageBin(
  packageJsonPath: string,
  binName: string,
  packageJsonRaw: string
): string | null {
  const packageJson = JSON.parse(packageJsonRaw) as { bin?: string | Record<string, string> };
  const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.[binName];
  if (!bin) return null;
  return path.resolve(path.dirname(packageJsonPath), bin);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveWorkspaceTsxCli(checked: string[]): Promise<string | null> {
  for (const packageJsonPath of getWorkspaceTsxPackageJsonCandidates()) {
    checked.push(packageJsonPath);
    if (!(await pathExists(packageJsonPath))) {
      continue;
    }

    try {
      const tsxCli = resolvePackageBin(
        packageJsonPath,
        'tsx',
        await fs.promises.readFile(packageJsonPath, 'utf8')
      );
      if (!tsxCli) {
        logger.warn(`tsx package has no bin.tsx entry at ${packageJsonPath}`);
        continue;
      }

      checked.push(tsxCli);
      if (await pathExists(tsxCli)) {
        return tsxCli;
      }
    } catch (error) {
      logger.warn(
        `Failed to resolve tsx CLI from ${packageJsonPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return null;
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
let _packagedElectronNodeRuntimeProbe: { ok: true } | { ok: false; error: unknown } | undefined;

export function clearResolvedNodePathForTests(): void {
  _resolvedNodePath = undefined;
  _packagedElectronNodeRuntimeProbe = undefined;
}

function emitProgress(
  options: McpLaunchSpecResolveOptions | undefined,
  phase: string,
  message: string
): void {
  options?.onProgress?.({ phase, message });
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function looksLikeNodeBinaryPath(candidate: string | undefined): candidate is string {
  if (!candidate?.trim()) {
    return false;
  }
  return /^node(?:-\d+)?(?:\.exe)?$/i.test(path.basename(candidate.trim()));
}

function getNodeRuntimeCommandCandidates(): string[] {
  const candidates = [
    process.env.NODE_BINARY,
    'node',
    process.env.npm_node_execpath,
    looksLikeNodeBinaryPath(process.execPath) ? process.execPath : undefined,
  ];
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const normalized = candidate?.trim();
    if (!normalized || seen.has(normalized)) {
      return [];
    }
    seen.add(normalized);
    return [normalized];
  });
}

function shouldPreferShellNodeProbe(): boolean {
  if (process.platform === 'win32') {
    return false;
  }

  const pathValue = process.env.PATH?.trim();
  if (!pathValue) {
    return true;
  }

  const minimalGuiPathEntries = new Set(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  const entries = pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return (
    entries.length > 0 && entries.every((entry) => minimalGuiPathEntries.has(path.resolve(entry)))
  );
}

function mergePathValues(...values: (string | undefined)[]): string | undefined {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const value of values) {
    if (!value) {
      continue;
    }
    for (const segment of value.split(path.delimiter)) {
      if (!segment || seen.has(segment)) {
        continue;
      }
      seen.add(segment);
      merged.push(segment);
    }
  }
  return merged.length > 0 ? merged.join(path.delimiter) : undefined;
}

function parseNodeMajorVersion(version: string): number | null {
  const match = /^v?(\d+)(?:\.|$)/.exec(version.trim());
  if (!match) {
    return null;
  }

  const major = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(major) ? major : null;
}

function parseNodeRuntimeProbeMetadata(stdout: string, command: string): NodeRuntimeProbeMetadata {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`${command} did not report Node.js runtime metadata`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`${command} reported invalid Node.js runtime metadata`);
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`${command} reported invalid Node.js runtime metadata`);
  }

  const metadata = parsed as { execPath?: unknown; version?: unknown };
  const resolvedPath = typeof metadata.execPath === 'string' ? metadata.execPath.trim() : '';
  if (!resolvedPath) {
    throw new Error(`${command} did not report process.execPath`);
  }

  const version = typeof metadata.version === 'string' ? metadata.version.trim() : '';
  if (!version) {
    throw new Error(`${command} did not report process.versions.node`);
  }

  return { path: resolvedPath, version };
}

function assertSupportedMcpNodeRuntime(command: string, metadata: NodeRuntimeProbeMetadata): void {
  const major = parseNodeMajorVersion(metadata.version);
  if (major === null || major < MIN_MCP_NODE_MAJOR_VERSION || major >= MAX_MCP_NODE_MAJOR_VERSION) {
    throw new Error(
      `${command} resolved ${metadata.path} with Node.js ${metadata.version}; Agent Teams MCP requires Node.js 24.x`
    );
  }
}

function isWriteMcpConfigOptions(value: unknown): value is WriteMcpConfigOptions {
  return (
    value !== null &&
    typeof value === 'object' &&
    ('mcpPolicy' in value || 'controlApiBaseUrl' in value)
  );
}

function buildNodeResolveEnv(shellEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...shellEnv,
  };
  const mergedPath = mergePathValues(shellEnv.PATH, buildMergedCliPath(), process.env.PATH);
  if (mergedPath) {
    env.PATH = mergedPath;
  }
  return env;
}

async function probeNodeRuntimePath(
  env: NodeJS.ProcessEnv
): Promise<{ ok: true; path: string } | { ok: false; error: unknown }> {
  let lastError: unknown = null;
  for (const command of getNodeRuntimeCommandCandidates()) {
    try {
      const { stdout } = await execCli(command, ['-e', NODE_RUNTIME_PROBE_SCRIPT], {
        encoding: 'utf-8',
        timeout: NODE_RUNTIME_PROBE_TIMEOUT_MS,
        env,
      });
      const metadata = parseNodeRuntimeProbeMetadata(stdout, command);
      assertSupportedMcpNodeRuntime(command, metadata);
      return { ok: true, path: metadata.path };
    } catch (error) {
      lastError = error;
    }
  }
  return { ok: false, error: lastError ?? 'no Node.js candidates were available' };
}

async function probePackagedElectronNodeRuntime(
  options?: McpLaunchSpecResolveOptions
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  if (_packagedElectronNodeRuntimeProbe) {
    return _packagedElectronNodeRuntimeProbe;
  }

  emitProgress(options, 'electron-node-runtime', 'Checking bundled Electron Node runtime...');
  try {
    const { stdout } = await execCli(process.execPath.trim(), ['-e', NODE_RUNTIME_PROBE_SCRIPT], {
      encoding: 'utf-8',
      timeout: ELECTRON_NODE_RUNTIME_PROBE_TIMEOUT_MS,
      env: {
        ...process.env,
        ...getPackagedElectronNodeEnv(),
      },
    });
    const metadata = parseNodeRuntimeProbeMetadata(stdout, process.execPath.trim());
    assertSupportedMcpNodeRuntime(process.execPath.trim(), metadata);
    _packagedElectronNodeRuntimeProbe = { ok: true };
  } catch (error) {
    _packagedElectronNodeRuntimeProbe = { ok: false, error };
  }
  return _packagedElectronNodeRuntimeProbe;
}

async function probeShellNodeRuntimePath(
  options?: McpLaunchSpecResolveOptions
): Promise<{ ok: true; path: string } | { ok: false; error: unknown }> {
  let shellEnv: NodeJS.ProcessEnv = {};
  try {
    shellEnv = await resolveInteractiveShellEnv({
      source: 'mcp-node-runtime',
      onProgress: options?.onProgress
        ? ({ phase, message }) => emitProgress(options, `shell-${phase}`, message)
        : undefined,
    });
  } catch (error) {
    logger.warn(`Failed to resolve shell env before Node.js lookup: ${stringifyError(error)}`);
  }

  return probeNodeRuntimePath(buildNodeResolveEnv(shellEnv));
}

/**
 * Find the real `node` binary path. In Electron, process.execPath is the
 * Electron binary — NOT node — so we must resolve node separately.
 * Uses the user's shell/enriched PATH so packaged GUI launches do not depend
 * on the minimal Finder/Dock PATH.
 */
async function resolveNodePath(options?: McpLaunchSpecResolveOptions): Promise<string> {
  if (_resolvedNodePath) return _resolvedNodePath;

  emitProgress(options, 'node-runtime', 'Resolving Node.js runtime for MCP server...');
  const preferShellNodeProbe = shouldPreferShellNodeProbe();
  if (preferShellNodeProbe && !process.env.NODE_BINARY?.trim()) {
    emitProgress(options, 'node-runtime-shell-fallback', 'Trying login shell Node.js runtime...');
    const shellProbe = await probeShellNodeRuntimePath(options);
    if (shellProbe.ok) {
      _resolvedNodePath = shellProbe.path;
      emitProgress(options, 'node-runtime-found', 'Using resolved Node.js runtime...');
      return _resolvedNodePath;
    }
  }

  const fastProbe = await probeNodeRuntimePath(buildNodeResolveEnv({}));
  if (fastProbe.ok) {
    _resolvedNodePath = fastProbe.path;
    emitProgress(options, 'node-runtime-found', 'Using resolved Node.js runtime...');
    return _resolvedNodePath;
  }

  if (!preferShellNodeProbe) {
    emitProgress(options, 'node-runtime-shell-fallback', 'Trying login shell Node.js runtime...');
    const shellProbe = await probeShellNodeRuntimePath(options);
    if (shellProbe.ok) {
      _resolvedNodePath = shellProbe.path;
      emitProgress(options, 'node-runtime-found', 'Using resolved Node.js runtime...');
      return _resolvedNodePath;
    }

    emitProgress(options, 'node-runtime-missing', 'Node.js runtime for MCP server was not found.');
    throw new Error(
      `Node.js runtime for Agent Teams MCP was not found. Ensure Node.js is installed and available from the login shell PATH. Last error: ${
        shellProbe.error ? stringifyError(shellProbe.error) : stringifyError(fastProbe.error)
      }`
    );
  }

  emitProgress(options, 'node-runtime-missing', 'Node.js runtime for MCP server was not found.');
  throw new Error(
    `Node.js runtime for Agent Teams MCP was not found. Ensure Node.js is installed and available from the login shell PATH. Last error: ${stringifyError(
      fastProbe.error
    )}`
  );
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
async function resolvePackagedServerEntry(options?: McpLaunchSpecResolveOptions): Promise<string> {
  const fallbackEntry = getPackagedServerEntry();
  if (!isPackagedApp()) return fallbackEntry;

  emitProgress(options, 'packaged-server', 'Checking packaged MCP server...');
  const appVersion = getAppVersion();
  const baseDir = getMcpServerBasePath();
  const finalDir = path.join(baseDir, appVersion);
  const finalEntry = path.join(finalDir, 'index.js');

  // Reuse existing valid copy
  if (await hasValidServerCopy(finalDir)) {
    emitProgress(options, 'packaged-server-reuse', 'Using cached MCP server copy...');
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

    emitProgress(options, 'packaged-server-copy', 'Copying MCP server to app data...');
    // Atomic: copy to temp dir, then rename to final
    const tmpDir = path.join(baseDir, `${appVersion}.tmp-${process.pid}-${randomUUID()}`);
    await fs.promises.mkdir(tmpDir, { recursive: true });
    await fs.promises.copyFile(path.join(sourceDir, 'index.js'), path.join(tmpDir, 'index.js'));
    await fs.promises.copyFile(
      path.join(sourceDir, 'package.json'),
      path.join(tmpDir, 'package.json')
    );

    try {
      await renamePathWithRetry(tmpDir, finalDir);
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
    emitProgress(options, 'packaged-server-ready', 'MCP server copy is ready...');
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

export async function resolveAgentTeamsMcpLaunchSpec(
  options: McpLaunchSpecResolveOptions = {}
): Promise<McpLaunchSpec> {
  const checked: string[] = [];

  // 1. Packaged Electron app — prefer stable copy, fall back to resourcesPath
  if (isPackagedApp()) {
    const packagedEntry = await resolvePackagedServerEntry(options);
    checked.push(packagedEntry);
    if (await pathExists(packagedEntry)) {
      if (shouldUsePackagedElectronNodeRuntime()) {
        const electronProbe = await probePackagedElectronNodeRuntime(options);
        if (electronProbe.ok) {
          emitProgress(
            options,
            'electron-node-runtime-found',
            'Using bundled Electron Node runtime...'
          );
          return buildPackagedElectronNodeLaunchSpec(packagedEntry);
        }
        logger.warn(
          `Bundled Electron Node runtime is unavailable for Agent Teams MCP; falling back to Node.js runtime: ${stringifyError(
            electronProbe.error
          )}`
        );
        emitProgress(
          options,
          'electron-node-runtime-fallback',
          'Bundled Electron Node runtime unavailable, resolving Node.js fallback...'
        );
      }
      return {
        command: await resolveNodePath(options),
        args: [packagedEntry],
      };
    }
    logger.warn(`Packaged MCP entry not found at ${packagedEntry}, falling back to workspace`);
  }

  // 2. Dev mode — prefer source so pnpm dev always sees current MCP tools
  const sourceEntry = getSourceServerEntry();
  emitProgress(options, 'source-entry', 'Checking MCP source entry...');
  checked.push(sourceEntry);
  if (await pathExists(sourceEntry)) {
    emitProgress(options, 'tsx-runner', 'Resolving MCP TypeScript runner...');
    const tsxCli = await resolveWorkspaceTsxCli(checked);
    if (tsxCli) {
      return {
        command: await resolveNodePath(options),
        args: [tsxCli, sourceEntry],
      };
    }
  }

  // 3. Dev mode fallback — use built dist when source execution is unavailable
  const builtEntry = getBuiltServerEntry();
  emitProgress(options, 'built-entry', 'Checking built MCP server entry...');
  checked.push(builtEntry);
  if (await pathExists(builtEntry)) {
    return {
      command: await resolveNodePath(options),
      args: [builtEntry],
    };
  }

  throw new Error(
    `agent-teams-mcp entrypoint not found. Checked paths:\n${checked.map((p) => `  - ${p}`).join('\n')}`
  );
}

export class TeamMcpConfigBuilder {
  async writeConfigFile(projectPath?: string, options?: WriteMcpConfigOptions): Promise<string>;
  async writeConfigFile(projectPath?: string, mcpPolicy?: TeamMemberMcpPolicy): Promise<string>;
  async writeConfigFile(
    projectPath?: string,
    optionsOrPolicy?: WriteMcpConfigOptions | TeamMemberMcpPolicy
  ): Promise<string> {
    const launchSpec = await resolveAgentTeamsMcpLaunchSpec();
    const configDir = getMcpConfigsBasePath();
    const configPath = path.join(
      configDir,
      `${MCP_CONFIG_PREFIX}${process.pid}-${Date.now()}-${randomUUID()}.json`
    );
    const options = isWriteMcpConfigOptions(optionsOrPolicy)
      ? optionsOrPolicy
      : ({
          mcpPolicy: optionsOrPolicy,
        } satisfies WriteMcpConfigOptions);
    const mcpPolicy = options.mcpPolicy;
    const controlApiBaseUrl =
      options.controlApiBaseUrl?.trim() || process.env[MCP_CONTROL_URL_ENV]?.trim() || '';
    // Keep the team bootstrap config minimal: recent Claude sidechain runs can
    // lose the agent-teams tool surface when we inline large user MCP bundles
    // into the generated --mcp-config. User/project/local MCP remain loaded
    // through Claude's native settings sources.
    const generatedServers: Record<string, McpServerConfig> = Object.create(null);
    generatedServers[MCP_SERVER_NAME] = normalizeMcpServerNodeOptions({
      command: launchSpec.command,
      args: launchSpec.args,
      enabled: true,
      env: {
        ...launchSpec.env,
        [MCP_CLAUDE_DIR_ENV]: getClaudeBasePath(),
        ...(controlApiBaseUrl ? { [MCP_CONTROL_URL_ENV]: controlApiBaseUrl } : {}),
      },
    });
    if (mcpPolicy?.mode === 'strictAllowlist') {
      for (const [name, config] of Object.entries(
        await this.readAllowlistedServers(projectPath, mcpPolicy)
      )) {
        generatedServers[name] = config;
      }
    }

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

  private async readAllowlistedServers(
    projectPath: string | undefined,
    policy: TeamMemberMcpPolicy
  ): Promise<Record<string, McpServerConfig>> {
    const allowlist = new Set(
      (policy.serverNames ?? [])
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => name.toLowerCase())
    );
    if (allowlist.size === 0) {
      return {};
    }

    const scopes = resolveTeamMemberMcpScopes(policy);
    const entries = await new McpConfigStateReader().readConfigured(projectPath);
    const byScope = new Map<TeamMemberMcpScope, typeof entries>();
    for (const scope of MCP_CONFIG_SCOPE_PRECEDENCE) {
      byScope.set(scope, []);
    }
    for (const entry of entries) {
      if (!scopes[entry.scope]) {
        continue;
      }
      byScope.get(entry.scope)?.push(entry);
    }

    const selected: Record<string, McpServerConfig> = Object.create(null);
    for (const scope of MCP_CONFIG_SCOPE_PRECEDENCE) {
      for (const entry of byScope.get(scope) ?? []) {
        if (entry.name.toLowerCase() === MCP_SERVER_NAME) {
          continue;
        }
        if (allowlist.has(entry.name.toLowerCase())) {
          selected[entry.name] = normalizeMcpServerNodeOptions(entry.config);
        }
      }
    }
    return selected;
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
