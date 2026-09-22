import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { createLogger } from '@shared/utils/logger';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Cursor native CLI wrappers restore the host home, not the OpenCode profile home. */
export const CURSOR_AGENT_TEAMS_MCP_SERVER_NAME = 'agent-teams';
const logger = createLogger('CursorMcpConfigWriter');

export interface CursorMcpConfigWriteResult {
  path: string;
  action: 'created' | 'updated' | 'unchanged' | 'skipped';
  reason?: 'unparsable-config' | 'user-owned-entry';
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

// Serialize concurrent launches sharing a Cursor home to keep config and ownership aligned.
const pendingWrites = new Map<string, Promise<CursorMcpConfigWriteResult>>();

export async function ensureCursorAgentTeamsMcpConfig(input: {
  profileHome: string;
  mcpUrl: string;
  serverName?: string;
}): Promise<CursorMcpConfigWriteResult> {
  const key = path.resolve(input.profileHome);
  const previous = pendingWrites.get(key);
  const next = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
    writeCursorAgentTeamsMcpConfig(input)
  );
  pendingWrites.set(key, next);
  try {
    return await next;
  } finally {
    if (pendingWrites.get(key) === next) pendingWrites.delete(key);
  }
}

/**
 * Merges `{ mcpServers: { "agent-teams": { type: "http", url } } }` into
 * `<profileHome>/.cursor/mcp.json`, preserving every other server entry and
 * every top-level key. A sidecar records only entries created by this app.
 * Existing or subsequently customized entries are never adopted or overwritten.
 */
async function writeCursorAgentTeamsMcpConfig(input: {
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
  if (
    rawServers !== undefined &&
    (!rawServers || typeof rawServers !== 'object' || Array.isArray(rawServers))
  ) {
    return { path: configPath, action: 'skipped', reason: 'unparsable-config' };
  }
  const ownershipPath = path.join(input.profileHome, '.cursor', 'mcp.agent-teams-managed.json');
  const ownership = await readJsonObject(ownershipPath);
  const ownedServers =
    ownership.kind === 'object' &&
    ownership.value.version === 1 &&
    ownership.value.servers &&
    typeof ownership.value.servers === 'object' &&
    !Array.isArray(ownership.value.servers)
      ? (ownership.value.servers as Record<string, unknown>)
      : {};

  const mcpServers: Record<string, unknown> =
    rawServers && typeof rawServers === 'object' && !Array.isArray(rawServers)
      ? { ...(rawServers as Record<string, unknown>) }
      : {};
  const desired = { type: 'http', url: mcpUrl };
  if (Object.hasOwn(mcpServers, serverName)) {
    const entry = mcpServers[serverName];
    const owned = ownedServers[serverName];
    // Exact snapshot equality relinquishes ownership after any user customization.
    if (!owned || JSON.stringify(entry) !== JSON.stringify(owned)) {
      return { path: configPath, action: 'skipped', reason: 'user-owned-entry' };
    }
  }
  if (JSON.stringify(mcpServers[serverName]) === JSON.stringify(desired)) {
    return { path: configPath, action: 'unchanged' };
  }
  mcpServers[serverName] = desired;
  await atomicWriteAsync(configPath, `${JSON.stringify({ ...config, mcpServers }, null, 2)}\n`, {
    mode: 0o600,
    beforeCommit: async () => {
      if (JSON.stringify(await readJsonObject(configPath)) !== JSON.stringify(existing)) {
        throw new Error('Cursor MCP config changed during registration; retry after reviewing it');
      }
    },
  });
  // Publish ownership last: interruption may require manual conflict resolution,
  // but can never claim an entry that this app did not successfully write.
  await atomicWriteAsync(
    ownershipPath,
    `${JSON.stringify({ version: 1, servers: { ...ownedServers, [serverName]: desired } }, null, 2)}\n`,
    { mode: 0o600 }
  );
  return { path: configPath, action: existing.kind === 'object' ? 'updated' : 'created' };
}

/** cursor-agent does not accept the app-instance fragment the launch URL carries. */
export function stripUrlFragment(url: string): string {
  const hash = url.indexOf('#');
  return hash >= 0 ? url.slice(0, hash) : url;
}

/** Register only the home used by the Cursor native CLI credential bridge. */
export async function prepareCursorAcpLaunchMcpConfig(input: {
  mcpUrl: string | undefined;
  homeDir?: string;
}): Promise<void> {
  const mcpUrl = stripUrlFragment(input.mcpUrl?.trim() ?? '');
  if (!mcpUrl) return;
  const homeDir = input.homeDir ?? os.homedir();
  await registerAgentTeamsMcpServer(homeDir, mcpUrl);
}

async function registerAgentTeamsMcpServer(profileHome: string, mcpUrl: string): Promise<void> {
  try {
    const result = await ensureCursorAgentTeamsMcpConfig({ profileHome, mcpUrl });
    if (result.action === 'skipped') {
      const message = `Cursor MCP config left untouched (${result.reason}) at ${result.path}; Agent Teams MCP registration requires manual resolution`;
      if (result.reason === 'user-owned-entry') logger.error(message);
      else logger.warn(message);
      return;
    }
    if (result.action !== 'unchanged') {
      logger.info(`Cursor MCP config ${result.action}: ${result.path}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`Cursor MCP config write failed (${profileHome}): ${detail}`);
  }
}
