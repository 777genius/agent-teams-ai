import { agentTeamsMcpHttpServer } from '@main/services/team/AgentTeamsMcpHttpServer';
import { renamePathWithRetry } from '@main/services/team/atomicWrite';
import { getClaudeBasePath, getMcpServerBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

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

const logger = createLogger('Runtime:AgentTeamsMcpLaunchEnv');

const MCP_COMMAND_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND';
const MCP_ENTRY_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY';
const MCP_ARGS_JSON_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON';
const MCP_ENV_JSON_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON';
const ELECTRON_RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE';

export type AgentTeamsMcpLaunchEnv = Record<string, string | undefined>;

export function isPackagedAgentTeamsMcpApp(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    return app.isPackaged;
  } catch {
    return false;
  }
}

export async function agentTeamsMcpPathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function getWorkspaceRoot(): string {
  return process.cwd();
}

function getWorkspaceMcpServerDir(): string {
  return path.join(getWorkspaceRoot(), 'mcp-server');
}

export function getAgentTeamsMcpBuiltEntry(): string {
  return path.join(getWorkspaceMcpServerDir(), 'dist', 'index.js');
}

export function getAgentTeamsMcpSourceEntry(): string {
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
  return bin ? path.resolve(path.dirname(packageJsonPath), bin) : null;
}

export async function resolveAgentTeamsMcpWorkspaceTsxCli(
  checked: string[]
): Promise<string | null> {
  for (const packageJsonPath of getWorkspaceTsxPackageJsonCandidates()) {
    checked.push(packageJsonPath);
    if (!(await agentTeamsMcpPathExists(packageJsonPath))) continue;

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
      if (await agentTeamsMcpPathExists(tsxCli)) return tsxCli;
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

function getAppVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    return app.getVersion();
  } catch {
    return '0.0.0-dev';
  }
}

function getPackagedServerEntry(): string {
  return path.join(process.resourcesPath, 'mcp-server', 'index.js');
}

async function hasValidServerCopy(dir: string): Promise<boolean> {
  return (
    (await agentTeamsMcpPathExists(path.join(dir, 'index.js'))) &&
    (await agentTeamsMcpPathExists(path.join(dir, 'package.json')))
  );
}

async function resolvePackagedServerEntry(options?: McpLaunchSpecResolveOptions): Promise<string> {
  const fallbackEntry = getPackagedServerEntry();
  if (!isPackagedAgentTeamsMcpApp()) return fallbackEntry;

  options?.onProgress?.({ phase: 'packaged-server', message: 'Checking packaged MCP server...' });
  const appVersion = getAppVersion();
  const baseDir = getMcpServerBasePath();
  const finalDir = path.join(baseDir, appVersion);
  const finalEntry = path.join(finalDir, 'index.js');
  if (await hasValidServerCopy(finalDir)) {
    options?.onProgress?.({
      phase: 'packaged-server-reuse',
      message: 'Using cached MCP server copy...',
    });
    return finalEntry;
  }

  try {
    if ((await agentTeamsMcpPathExists(finalDir)) && !(await hasValidServerCopy(finalDir))) {
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

    options?.onProgress?.({
      phase: 'packaged-server-copy',
      message: 'Copying MCP server to app data...',
    });
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
      await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      if (await hasValidServerCopy(finalDir)) {
        logger.info(`Using stable MCP server copy at ${finalDir} (concurrent copy resolved)`);
        return finalEntry;
      }
      logger.warn(`Concurrent MCP server copy failed, using resourcesPath fallback`);
      return fallbackEntry;
    }

    logger.info(`MCP server copied to stable path ${finalDir} (v${appVersion})`);
    options?.onProgress?.({
      phase: 'packaged-server-ready',
      message: 'MCP server copy is ready...',
    });
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

export async function resolvePackagedAgentTeamsMcpEntry(
  options: McpLaunchSpecResolveOptions = {}
): Promise<string | null> {
  if (!isPackagedAgentTeamsMcpApp()) return null;
  const entry = await resolvePackagedServerEntry(options);
  return (await agentTeamsMcpPathExists(entry)) ? entry : null;
}

async function resolveDefaultAgentTeamsMcpLaunchSpec(): Promise<McpLaunchSpec> {
  const module = await import('@main/services/team/TeamMcpConfigBuilder');
  return module.resolveAgentTeamsMcpLaunchSpec();
}

async function resolveDefaultPackagedAgentTeamsMcpEntry(): Promise<string | null> {
  const module = await import('@main/services/team/TeamMcpConfigBuilder');
  return module.resolvePackagedAgentTeamsMcpEntry();
}

/** Project existing app authority only; never resolve or start a server on a read. */
export function applyAgentTeamsMcpAppContext(
  env: AgentTeamsMcpLaunchEnv,
  claudeBasePath: string = getClaudeBasePath(),
  controlApiBaseUrl: string | null | undefined = process.env.CLAUDE_TEAM_CONTROL_URL
): void {
  const current = agentTeamsMcpHttpServer.appContext.read(claudeBasePath);
  // Only the current Host can select a remote endpoint; never retain shell hints.
  delete env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL;
  delete env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL_HASH;
  delete env.CLAUDE_TEAM_APP_INSTANCE_ID;
  delete env.CLAUDE_TEAM_APP_PROFILE_SCOPE;
  if (current) {
    Object.assign(env, current);
  }
  const rawChildEnv = env[MCP_ENV_JSON_ENV]?.trim();
  const parsed: unknown = rawChildEnv ? JSON.parse(rawChildEnv) : {};
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((value) => typeof value !== 'string')
  ) {
    throw new Error('Agent Teams MCP child environment must be a JSON object of strings');
  }
  const childEnv = { ...parsed } as Record<string, string>;
  if (current) {
    for (const key of ['CLAUDE_TEAM_APP_INSTANCE_ID', 'CLAUDE_TEAM_APP_PROFILE_SCOPE']) {
      if (childEnv[key] !== undefined && childEnv[key] !== current[key]) {
        throw new Error('Foreign Host MCP child context');
      }
    }
    if (
      childEnv.AGENT_TEAMS_MCP_CLAUDE_DIR !== undefined &&
      childEnv.AGENT_TEAMS_MCP_CLAUDE_DIR !== claudeBasePath
    ) {
      throw new Error('Foreign Host MCP child root');
    }
    childEnv.CLAUDE_TEAM_APP_INSTANCE_ID = current.CLAUDE_TEAM_APP_INSTANCE_ID!;
    childEnv.CLAUDE_TEAM_APP_PROFILE_SCOPE = current.CLAUDE_TEAM_APP_PROFILE_SCOPE!;
  } else {
    delete childEnv.CLAUDE_TEAM_APP_INSTANCE_ID;
    delete childEnv.CLAUDE_TEAM_APP_PROFILE_SCOPE;
  }
  env.AGENT_TEAMS_MCP_CLAUDE_DIR = claudeBasePath;
  childEnv.AGENT_TEAMS_MCP_CLAUDE_DIR = claudeBasePath;
  const controlUrl = controlApiBaseUrl?.trim();
  if (controlUrl) {
    env.CLAUDE_TEAM_CONTROL_URL = controlUrl;
    childEnv.CLAUDE_TEAM_CONTROL_URL = controlUrl;
  } else {
    delete env.CLAUDE_TEAM_CONTROL_URL;
    delete childEnv.CLAUDE_TEAM_CONTROL_URL;
  }
  env[MCP_ENV_JSON_ENV] = JSON.stringify(childEnv);
}

export function hasAgentTeamsMcpLocalLaunchEnv(env: AgentTeamsMcpLaunchEnv): boolean {
  return Boolean(
    env[MCP_COMMAND_ENV]?.trim() && env[MCP_ENTRY_ENV]?.trim() && env[MCP_ARGS_JSON_ENV]?.trim()
  );
}

function ensureLegacyMcpChildEnvJson(env: AgentTeamsMcpLaunchEnv): void {
  if (env[MCP_ENV_JSON_ENV]?.trim()) {
    return;
  }
  const electronRunAsNode = env[ELECTRON_RUN_AS_NODE_ENV]?.trim();
  if (electronRunAsNode) {
    env[MCP_ENV_JSON_ENV] = JSON.stringify({
      [ELECTRON_RUN_AS_NODE_ENV]: electronRunAsNode,
    });
  }
}

export async function ensureAgentTeamsMcpLocalLaunchEnv(
  env: AgentTeamsMcpLaunchEnv,
  resolveLaunchSpec: () => Promise<McpLaunchSpec> = resolveDefaultAgentTeamsMcpLaunchSpec,
  resolvePackagedEntry: () => Promise<string | null> = resolveDefaultPackagedAgentTeamsMcpEntry
): Promise<void> {
  if (hasAgentTeamsMcpLocalLaunchEnv(env)) {
    ensureLegacyMcpChildEnvJson(env);
    return;
  }

  try {
    const launchSpec = await resolveLaunchSpec();
    const entry = launchSpec.args[0]?.trim();
    const command = launchSpec.command.trim();
    if (!command || !entry) {
      throw new Error('Resolved Agent Teams MCP launch spec is incomplete');
    }

    env[MCP_COMMAND_ENV] = command;
    env[MCP_ENTRY_ENV] = entry;
    env[MCP_ARGS_JSON_ENV] = JSON.stringify(launchSpec.args);
    env[MCP_ENV_JSON_ENV] = JSON.stringify(launchSpec.env ?? {});
  } catch (error) {
    const entryOnlyFallback =
      env[MCP_ENTRY_ENV]?.trim() || (await resolvePackagedEntry().catch(() => null));
    if (entryOnlyFallback) {
      env[MCP_ENTRY_ENV] = entryOnlyFallback;
      logger.warn(
        `Unable to resolve the full Agent Teams MCP launch env; using packaged entrypoint fallback: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return;
    }
    logger.warn(
      `Unable to resolve Agent Teams MCP local launch env: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
