/**
 * MCP server domain types — catalog items, install specs, installed state, headers.
 */

// ── Catalog item (normalized from Official Registry / Glama) ───────────────

export type McpHostingType = 'local' | 'remote' | 'both';

export interface McpCatalogItem {
  id: string; // Official: reverse-DNS (e.g. "io.github.upstash/context7"), Glama: "glama:<id>"
  name: string; // display name
  description: string;
  repositoryUrl?: string;
  version?: string;
  source: 'official' | 'glama';
  installSpec: McpInstallSpec | null; // null = can't auto-install (Glama-only)
  envVars: McpEnvVarDef[];
  license?: string;
  tools: McpToolDef[];
  glamaUrl?: string;
  requiresAuth: boolean; // true if HTTP server has required headers
  iconUrl?: string; // First icon URL from official registry (icons[0].src)
  websiteUrl?: string;
  status?: string;
  publishedAt?: string;
  updatedAt?: string;
  author?: string;
  hostingType?: McpHostingType;
  authHeaders?: McpAuthHeaderDef[];
}

export interface McpToolDef {
  name: string;
  description: string;
}

// ── Install spec (derived from registry packages/remotes) ──────────────────

export type McpInstallSpec = McpStdioInstallSpec | McpHttpInstallSpec;

export interface McpStdioInstallSpec {
  type: 'stdio';
  npmPackage: string; // "@upstash/context7-mcp"
  npmVersion?: string;
}

export interface McpHttpInstallSpec {
  type: 'http';
  url: string;
  transportType: 'streamable-http' | 'sse' | 'http';
}

// ── Environment variables ──────────────────────────────────────────────────

export interface McpEnvVarDef {
  name: string;
  isSecret: boolean;
  description?: string;
  isRequired?: boolean; // from registry, but treat all as optional in UI
}

export interface McpAuthHeaderDef {
  key: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  valueTemplate?: string;
}

// ── HTTP headers (for auth/config of HTTP/SSE servers) ─────────────────────

export interface McpHeaderDef {
  key: string;
  value: string;
  secret?: boolean; // true = mask in UI, don't log
  description?: string;
  isRequired?: boolean;
  valueTemplate?: string;
  locked?: boolean;
}

// ── Installed state (from ~/.claude.json / .mcp.json) ──────────────────────

export interface InstalledMcpEntry {
  name: string;
  scope: 'local' | 'user' | 'project';
  transport?: string;
}

export type McpServerHealthStatus = 'connected' | 'needs-authentication' | 'failed' | 'unknown';

export interface McpServerDiagnostic {
  name: string;
  target: string;
  status: McpServerHealthStatus;
  statusLabel: string;
  rawLine: string;
  checkedAt: number;
}

// ── Install request (renderer → main, minimal trusted data) ────────────────

export interface McpInstallRequest {
  registryId: string; // server ID from registry (NOT full catalog item)
  serverName: string; // user-chosen name for `claude mcp add`
  scope: 'local' | 'user' | 'project';
  projectPath?: string; // required for 'project' scope
  envValues: Record<string, string>;
  headers: McpHeaderDef[]; // for HTTP/SSE servers (CLI --header flag)
}

// ── Custom install request (bypasses registry, user provides spec) ──────────

export interface McpCustomInstallRequest {
  serverName: string;
  scope: 'local' | 'user' | 'project';
  projectPath?: string;
  installSpec: McpInstallSpec; // user provides directly
  envValues: Record<string, string>;
  headers: McpHeaderDef[];
}

// ── Search result wrapper ──────────────────────────────────────────────────

export interface McpSearchResult {
  servers: McpCatalogItem[];
  warnings: string[]; // e.g. "Official registry unavailable"
}
