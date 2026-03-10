# ADR-001: Extension Store Contract Spike

**Date**: 2026-03-07
**Status**: Accepted

## Context

Extension Store нуждается в точных внешних контрактах перед написанием парсеров. Этот ADR фиксирует результаты contract spike.

---

## 1. Plugin CLI Contracts

### Verified CLI Flags

| Command | Syntax | Default scope |
|---------|--------|---------------|
| install | `claude plugin install [-s scope] <plugin>` | `user` |
| uninstall | `claude plugin uninstall [-s scope] <plugin>` | `user` |
| list | `claude plugin list [--json] [--available]` | — |
| enable | `claude plugin enable [-s scope] <plugin>` | — |
| disable | `claude plugin disable [plugin]` | — |

**Scope flag**: `-s, --scope <scope>` — values: `user`, `project`, `local`

**qualifiedName format**: `<name>@<marketplace>` (e.g. `context7@claude-plugins-official`)

### Installed State — Source of Truth

**File**: `~/.claude/plugins/installed_plugins.json`

```json
{
  "version": 2,
  "plugins": {
    "<qualifiedName>": [
      {
        "scope": "user",
        "installPath": "/Users/.../.claude/plugins/cache/<marketplace>/<name>/<version>",
        "version": "1.0.0",
        "installedAt": "2026-03-01T11:14:21.926Z",
        "lastUpdated": "2026-03-01T11:14:21.926Z",
        "gitCommitSha": "..."
      }
    ]
  }
}
```

- Key = `qualifiedName` = `<pluginName>@<marketplaceName>`
- Value = array (one entry per scope installation)
- `scope`: `"user"` | `"project"` | `"local"`
- **pluginId** for V1 = `qualifiedName` (globally unique)

### Install Counts

**File**: `~/.claude/plugins/install-counts-cache.json`

```json
{
  "<pluginName>": <count>    // NOT qualifiedName, just name
}
```

- Key = plugin `name` (without marketplace suffix)
- 157 entries in current cache

### Marketplaces

**File**: `~/.claude/plugins/known_marketplaces.json`

```json
{
  "<marketplace-name>": {
    "source": { "source": "github", "repo": "<owner>/<repo>" },
    "installLocation": "...",
    "lastUpdated": "..."
  }
}
```

- V1: we read only `claude-plugins-official` marketplace
- Marketplace manifest: `raw.githubusercontent.com/<owner>/<repo>/main/.claude-plugin/marketplace.json`
- Supports ETag/If-None-Match → 304 Not Modified

### `claude plugin list --json`

- Supports `--json` flag
- Supports `--available` flag (requires `--json`)
- Output format: TBD (не тестировали мутирующе, но флаг существует)

---

## 2. MCP CLI Contracts

### Verified CLI Flags

| Command | Syntax |
|---------|--------|
| add (stdio) | `claude mcp add [-s scope] [-e KEY=val...] <name> -- <command> [args...]` |
| add (http) | `claude mcp add [-s scope] -t http [-H "Header: val"...] <name> <url>` |
| add (sse) | `claude mcp add [-s scope] -t sse [-H "Header: val"...] <name> <url>` |
| remove | `claude mcp remove [-s scope] <name>` |
| list | `claude mcp list` |
| get | `claude mcp get <name>` |

**Scope flag**: `-s, --scope <scope>` — values: `local` (default), `user`, `project`

**Transport flag**: `-t, --transport <transport>` — values: `stdio` (default), `sse`, `http`

**Env flag**: `-e, --env <env...>` — format: `KEY=value`

**Header flag**: `-H, --header <header...>` — format: `"Key: value"` — YES, SUPPORTED!

**OAuth**: `--client-id`, `--client-secret`, `--callback-port` — not needed for V1

### Installed State — Source of Truth

**User scope**: `~/.claude.json` → `mcpServers` key
**Project scope**: `.mcp.json` in project root
**Local scope**: определяется в Phase 0 (likely `~/.claude.json`)

---

## 3. Official MCP Registry API

**Base URL**: `https://registry.modelcontextprotocol.io/v0.1/servers`

**Pagination**: cursor-based via `metadata.nextCursor`

**Query params**:
- `limit=N` — items per page
- `search=<query>` — text search
- `cursor=<nextCursor>` — pagination

**Response structure**:
```json
{
  "servers": [
    {
      "server": {
        "name": "io.github.upstash/context7",  // reverse-DNS ID
        "description": "...",
        "title": "Context7",                     // display name (optional)
        "version": "1.0.30",
        "repository": { "url": "...", "source": "github" },
        "packages": [{                           // npm install info (optional)
          "registryType": "npm",
          "identifier": "@upstash/context7-mcp",
          "version": "1.0.30",
          "transport": { "type": "stdio" },
          "environmentVariables": [{
            "name": "CONTEXT7_API_KEY",
            "description": "...",
            "isSecret": true,
            "format": "string"
          }]
        }],
        "remotes": [{                            // HTTP/SSE install info (optional)
          "type": "streamable-http",
          "url": "https://...",
          "headers": [{                          // auth headers (optional)
            "name": "Authorization",
            "description": "...",
            "isRequired": true,
            "isSecret": true,
            "value": "Bearer {key}"              // template (optional)
          }]
        }]
      },
      "_meta": {
        "io.modelcontextprotocol.registry/official": {
          "status": "active",
          "isLatest": true
        }
      }
    }
  ],
  "metadata": {
    "nextCursor": "...",
    "count": N
  }
}
```

**Key fields for install**:
- `packages[0].identifier` → npm package name
- `packages[0].version` → npm version
- `packages[0].transport.type` → `"stdio"`
- `packages[0].environmentVariables` → env var definitions
- `remotes[0].type` → `"streamable-http"` | `"sse"`
- `remotes[0].url` → HTTP endpoint
- `remotes[0].headers` → auth headers (with `isSecret`, `isRequired`)

**Version handling**: Multiple versions of same server returned separately. Use `_meta.isLatest: true` to pick latest.

**Auth**: No authentication required.

---

## 4. Glama API

**Base URL**: `https://glama.ai/api/mcp/v1/servers`

**Pagination**: cursor-based via `pageInfo.endCursor`

**Query params**:
- `first=N` — items per page
- `search=<query>` — text search
- `after=<cursor>` — pagination cursor

**Response structure**:
```json
{
  "pageInfo": {
    "endCursor": "...",
    "hasNextPage": true,
    "hasPreviousPage": false,
    "startCursor": "..."
  },
  "servers": [{
    "id": "iu27vfrji2",
    "name": "clelp-mcp-server",
    "namespace": "oscarsterling",
    "description": "...",
    "slug": "clelp-mcp-server",
    "url": "https://glama.ai/mcp/servers/iu27vfrji2",
    "repository": { "url": "https://github.com/..." },
    "spdxLicense": { "name": "MIT License", "url": "..." },
    "tools": [],
    "attributes": [],
    "environmentVariablesJsonSchema": null
  }]
}
```

**Key differences from Official Registry**:
- NO install info (no `packages`, no `remotes`) → can't auto-install Glama-only servers
- Has `spdxLicense` → enrichment data
- Has `tools[]` → enrichment data
- Has `url` → link to Glama page
- Pagination: `after` param (not `cursor`)

**Auth**: No authentication required.

---

## 5. Marketplace JSON Schema

**URL**: `https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json`

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "claude-plugins-official",
  "description": "...",
  "owner": { "name": "Anthropic", "email": "..." },
  "plugins": [
    {
      "name": "typescript-lsp",
      "description": "...",
      "version": "1.0.0",
      "author": { "name": "Anthropic", "email": "..." },
      "source": "./plugins/typescript-lsp",    // local path OR object with URL
      "category": "development",
      "strict": false,
      "lspServers": { ... }                    // optional
    }
  ]
}
```

**Plugin fields**:
- `name`: display/install name
- `source`: string (local path) or `{ source: "url", url: "..." }` (external)
- `category`: open-ended string
- `lspServers`: optional dict → hasLspServers capability
- No `mcpServers`, `agents`, `commands`, `hooks` found in current V1 marketplace
- `homepage`: optional string (external plugins)
- `tags`: NOT present in marketplace.json (will be empty in V1)

**Categories found**: database, deployment, design, development, learning, monitoring, productivity, security, testing

**ETag support**: Yes — `If-None-Match` → 304 Not Modified

---

## 6. Decisions

| Decision | Value |
|----------|-------|
| Scope | Electron-only V1 |
| Plugin identity key (`pluginId`) | `<name>@<marketplace>` = qualifiedName |
| Plugin install target | `qualifiedName` resolved by main from catalog |
| Plugin scope flag | `-s, --scope` (short) / `--scope` (long) |
| MCP scope flag | `-s, --scope` |
| MCP transport flag | `-t, --transport` |
| MCP env flag | `-e, --env KEY=val` |
| MCP header flag | `-H, --header "Key: val"` — **SUPPORTED** |
| MCP default scope | `local` |
| Plugin default scope | `user` |
| Official Registry API version | `v0.1` |
| Official Registry pagination | cursor-based, `cursor` param |
| Glama pagination | cursor-based, `after` param |
| Latest version filter | `_meta.isLatest: true` |
| Capability flags V1 | `hasLspServers` only (others not in current marketplace) |
| Install counts key | plugin `name` (without `@marketplace`) |
