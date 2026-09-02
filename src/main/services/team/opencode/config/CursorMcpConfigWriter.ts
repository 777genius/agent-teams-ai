import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { createLogger } from '@shared/utils/logger';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { Dirent } from 'fs';

/**
 * Registers the Agent Teams MCP HTTP endpoint as a real Cursor MCP server for
 * cursor-acp runs. cursor-agent only exposes the servers it finds in
 * `~/.cursor/mcp.json`, and the app rewrites HOME/USERPROFILE to
 * `<data>/opencode/profiles/<profileRootKey>/home`, so the entry must live in
 * that per-profile home or GetMcpTools/CallMcpTool never see "agent-teams".
 */

export const CURSOR_AGENT_TEAMS_MCP_SERVER_NAME = 'agent-teams';

const CLAUDE_MULTIMODEL_DATA_DIR_NAME = 'claude-multimodel-nodejs';
const CURSOR_ACP_PROFILE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const logger = createLogger('CursorMcpConfigWriter');

export interface CursorMcpConfigWriteResult {
  path: string;
  action: 'created' | 'updated' | 'unchanged' | 'skipped';
  /** Only set for `skipped`: why the existing file was left exactly as it was. */
  reason?: 'unparsable-config';
}

export interface ResolveCursorAcpProfileHomeOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/**
 * Mirrors the app's env-paths data directory (`CLAUDE_MULTIMODEL_DATA_HOME`
 * override, otherwise the env-paths default for the platform).
 */
export function resolveCursorAcpProfileHome(
  profileRootKey: string,
  options: ResolveCursorAcpProfileHomeOptions = {}
): string | null {
  const key = profileRootKey.trim();
  if (!CURSOR_ACP_PROFILE_KEY_PATTERN.test(key)) {
    return null;
  }
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const override = env.CLAUDE_MULTIMODEL_DATA_HOME?.trim();
  let dataDir: string;
  if (override && path.isAbsolute(override)) {
    dataDir = path.normalize(override);
  } else if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim() || path.join(homeDir, 'AppData', 'Local');
    dataDir = path.join(localAppData, CLAUDE_MULTIMODEL_DATA_DIR_NAME, 'Data');
  } else if (platform === 'darwin') {
    dataDir = path.join(homeDir, 'Library', 'Application Support', CLAUDE_MULTIMODEL_DATA_DIR_NAME);
  } else {
    const xdgDataHome = env.XDG_DATA_HOME?.trim() || path.join(homeDir, '.local', 'share');
    dataDir = path.join(xdgDataHome, CLAUDE_MULTIMODEL_DATA_DIR_NAME);
  }
  return path.join(dataDir, 'opencode', 'profiles', key, 'home');
}

/**
 * A missing file and an unparsable one are different outcomes: only the first
 * one may be written. Cursor tolerates comments and trailing commas in these
 * files, and a half-edited file parses as neither, so collapsing both onto an
 * empty object would delete every MCP server the user configured.
 */
type CursorJsonRead =
  | { kind: 'missing' }
  | { kind: 'object'; value: Record<string, unknown> }
  | { kind: 'unparsable' };

async function directoryExists(dirPath: string): Promise<boolean> {
  return fs
    .stat(dirPath)
    .then((stats) => stats.isDirectory())
    .catch(() => false);
}

/**
 * Every profile home the app has already created. The execution proof names the
 * project-root profile, but cursor-agent runs the lead out of the user-home
 * profile, which is a different key, so registering only the proof home leaves
 * the lead without tools on exactly the path that matters.
 */
export async function listCursorAcpProfileHomes(
  options: ResolveCursorAcpProfileHomeOptions = {}
): Promise<string[]> {
  const probeHome = resolveCursorAcpProfileHome('probe', options);
  if (!probeHome) return [];
  const profilesDir = path.dirname(path.dirname(probeHome));
  let entries: Dirent[];
  try {
    entries = await fs.readdir(profilesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const homes: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !CURSOR_ACP_PROFILE_KEY_PATTERN.test(entry.name)) continue;
    const home = path.join(profilesDir, entry.name, 'home');
    if (await directoryExists(home)) homes.push(home);
  }
  return homes;
}

async function readJsonObject(filePath: string): Promise<CursorJsonRead> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { kind: 'object', value: parsed as Record<string, unknown> }
      : { kind: 'unparsable' };
  } catch {
    return { kind: 'unparsable' };
  }
}

/**
 * Merges `{ mcpServers: { "agent-teams": { type: "http", url } } }` into
 * `<profileHome>/.cursor/mcp.json`, preserving every other server entry and
 * every top-level key, and rewriting only when the stored URL differs.
 */
export async function ensureCursorAgentTeamsMcpConfig(input: {
  profileHome: string;
  mcpUrl: string;
  serverName?: string;
}): Promise<CursorMcpConfigWriteResult> {
  const serverName = input.serverName?.trim() || CURSOR_AGENT_TEAMS_MCP_SERVER_NAME;
  const mcpUrl = input.mcpUrl.trim();
  if (!mcpUrl) {
    throw new Error('Agent Teams MCP URL is required to write the Cursor MCP config');
  }
  const configPath = path.join(input.profileHome, '.cursor', 'mcp.json');
  const existing = await readJsonObject(configPath);
  if (existing.kind === 'unparsable') {
    return { path: configPath, action: 'skipped', reason: 'unparsable-config' };
  }
  const config = existing.kind === 'object' ? existing.value : {};
  const rawServers = config.mcpServers;
  const mcpServers: Record<string, unknown> =
    rawServers && typeof rawServers === 'object' && !Array.isArray(rawServers)
      ? { ...(rawServers as Record<string, unknown>) }
      : {};
  const desired = { type: 'http', url: mcpUrl };
  if (JSON.stringify(mcpServers[serverName]) === JSON.stringify(desired)) {
    return { path: configPath, action: 'unchanged' };
  }
  mcpServers[serverName] = desired;
  await atomicWriteAsync(configPath, `${JSON.stringify({ ...config, mcpServers }, null, 2)}\n`, {
    mode: 0o600,
  });
  return { path: configPath, action: existing.kind === 'object' ? 'updated' : 'created' };
}

/** cursor-agent does not accept the app-instance fragment the launch URL carries. */
export function stripUrlFragment(url: string): string {
  const hash = url.indexOf('#');
  return hash >= 0 ? url.slice(0, hash) : url;
}

/**
 * Launch-time hook: registers the endpoint in every existing profile home and
 * in the real user home (cursor-agent resolves `~/.cursor` from the redirected
 * HOME, so both are load-bearing). Never throws; a launch must proceed even
 * when the config cannot be written, because the briefing then tells the model
 * to report the missing tools instead of scripting around them.
 */
export async function prepareCursorAcpLaunchMcpConfig(input: {
  profileRootKey: string | undefined;
  mcpUrl: string | undefined;
  paths?: ResolveCursorAcpProfileHomeOptions;
}): Promise<void> {
  const mcpUrl = stripUrlFragment(input.mcpUrl?.trim() ?? '');
  if (!mcpUrl) return;
  const profileRootKey = input.profileRootKey?.trim();
  const proofHome = profileRootKey
    ? resolveCursorAcpProfileHome(profileRootKey, input.paths)
    : null;
  const profileHomes = Array.from(
    new Set([...(proofHome ? [proofHome] : []), ...(await listCursorAcpProfileHomes(input.paths))])
  );
  if (profileHomes.length === 0) {
    logger.info('cursor-acp launch found no per-profile Cursor home to register');
  }
  const homeDir = input.paths?.homeDir ?? os.homedir();
  const targets = Array.from(new Set([...profileHomes, homeDir]));
  logger.info(`Registering the Agent Teams MCP server in ${targets.length} Cursor home(s)`);
  for (const profileHome of targets) {
    await registerAgentTeamsMcpServer(profileHome, mcpUrl);
  }
}

async function registerAgentTeamsMcpServer(profileHome: string, mcpUrl: string): Promise<void> {
  try {
    const result = await ensureCursorAgentTeamsMcpConfig({ profileHome, mcpUrl });
    if (result.action === 'skipped') {
      logger.warn(
        `Cursor MCP config left untouched (${result.reason}); the lead will have no agent-teams tools from ${result.path}`
      );
      return;
    }
    if (result.action !== 'unchanged') {
      logger.info(`Cursor MCP config ${result.action}: ${result.path}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn(`Cursor MCP config write failed (${profileHome}): ${detail}`);
  }
}
