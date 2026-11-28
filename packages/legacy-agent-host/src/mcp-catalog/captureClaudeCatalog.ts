import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readConfiguredMcpServers } from './catalog.js';
import { readCapturedMcpBytes, McpCatalogUnavailable } from './capturedFile.js';
import type { ConfiguredMcpServer } from './catalog.js';
export { McpCatalogUnavailable } from './capturedFile.js';
const MAX_SERVERS = 256;
function readConfig(target: string): Record<string, unknown> | undefined {
  try {
    const bytes = readCapturedMcpBytes(target, 2 * 1024 * 1024);
    if (bytes === undefined) return undefined;
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new McpCatalogUnavailable();
    return value as Record<string, unknown>;
  } catch {
    throw new McpCatalogUnavailable();
  }
}
function servers(value: unknown, scope: ConfiguredMcpServer['scope']): ConfiguredMcpServer[] {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new McpCatalogUnavailable();
  if (Object.keys(value).length > MAX_SERVERS) throw new McpCatalogUnavailable();
  const rows = readConfiguredMcpServers(value, scope);
  if (
    rows.length !== Object.keys(value).length ||
    rows.length > MAX_SERVERS ||
    rows.some((row) => !row.name.trim() || row.name.length > 128 || row.name.includes('\0'))
  )
    throw new McpCatalogUnavailable();
  return rows;
}

/** One private capture snapshot: repeated scope reads share the exact same parsed file bytes. */
export class CapturedClaudeMcpCatalogReader {
  private readonly files = new Map<string, Record<string, unknown> | undefined>();
  private bytes = 0;

  private read(path: string): Record<string, unknown> | undefined {
    if (this.files.has(path)) return this.files.get(path);
    const value = readConfig(path);
    this.bytes += value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value));
    if (this.bytes > 8 * 1024 * 1024 || this.files.size >= 512) throw new McpCatalogUnavailable();
    this.files.set(path, value);
    return value;
  }

  readCatalog(options: { userConfigPath: string; projectPath: string }): ConfiguredMcpServer[] {
    try {
      const project = lstatSync(options.projectPath);
      if (!project.isDirectory() || project.isSymbolicLink()) throw new McpCatalogUnavailable();
      const config = this.read(options.userConfigPath);
      const projectConfig = this.read(join(options.projectPath, '.mcp.json'));
      const projects = config?.projects;
      if (
        projects !== undefined &&
        (!projects || typeof projects !== 'object' || Array.isArray(projects))
      )
        throw new McpCatalogUnavailable();
      const local = (projects as Record<string, unknown> | undefined)?.[options.projectPath];
      if (local !== undefined && (!local || typeof local !== 'object' || Array.isArray(local)))
        throw new McpCatalogUnavailable();
      const rows = [
        ...servers(config?.mcpServers, 'user'),
        ...servers((local as Record<string, unknown> | undefined)?.mcpServers, 'local'),
        ...servers(projectConfig?.mcpServers, 'project'),
      ];
      if (rows.length > MAX_SERVERS) throw new McpCatalogUnavailable();
      return rows;
    } catch {
      throw new McpCatalogUnavailable();
    }
  }
}

/** Caller supplies the captured account's exact config path; never consults process HOME. */
export function captureClaudeMcpCatalog(options: {
  userConfigPath: string;
  projectPath: string;
}): ConfiguredMcpServer[] {
  return new CapturedClaudeMcpCatalogReader().readCatalog(options);
}
