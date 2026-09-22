#!/usr/bin/env node
import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';

import { FastMCP } from 'fastmcp';

import { registerTools } from './tools';

const HTTP_TRANSPORT = 'httpStream';
const STDIO_TRANSPORT = 'stdio';
const DEFAULT_HTTP_HOST = '127.0.0.1';
const DEFAULT_HTTP_ENDPOINT = '/mcp';
const MCP_HTTP_IDENTITY_SERVICE = 'agent-teams-mcp-http';
const MCP_HTTP_IDENTITY_SERVICE_ENV = 'AGENT_TEAMS_MCP_HTTP_IDENTITY_SERVICE';
const MCP_HTTP_CLAUDE_DIR_HASH_ENV = 'AGENT_TEAMS_MCP_HTTP_CLAUDE_DIR_HASH';
const MCP_HTTP_LAUNCH_SPEC_HASH_ENV = 'AGENT_TEAMS_MCP_HTTP_LAUNCH_SPEC_HASH';
const MCP_HTTP_OWNER_INSTANCE_ID_ENV = 'AGENT_TEAMS_MCP_HTTP_OWNER_INSTANCE_ID';

export type AgentTeamsMcpStartOptions =
  | {
      transportType: typeof STDIO_TRANSPORT;
    }
  | {
      transportType: typeof HTTP_TRANSPORT;
      httpStream: {
        host: string;
        port: number;
        endpoint: `/${string}`;
      };
    };

export interface AgentTeamsMcpHttpHealthIdentity {
  schemaVersion: 1;
  service: typeof MCP_HTTP_IDENTITY_SERVICE;
  transport: typeof HTTP_TRANSPORT;
  host: string;
  port: number;
  endpoint: `/${string}`;
  claudeDirHash: string;
  launchSpecHash: string;
  ownerInstanceId: string;
}

export function createServer(
  input: { healthIdentity?: AgentTeamsMcpHttpHealthIdentity | null } = {}
) {
  const server = new FastMCP({
    name: 'agent-teams-mcp',
    version: '1.0.0',
    ...(input.healthIdentity
      ? {
          health: {
            enabled: true,
            path: '/health',
            status: 200,
            message: JSON.stringify(input.healthIdentity),
          },
        }
      : {}),
  });

  registerTools(server);

  return server;
}

function getArgValue(argv: string[], name: string): string | null {
  const directPrefix = `${name}=`;
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === name) {
      return argv[index + 1] ?? null;
    }
    if (value.startsWith(directPrefix)) {
      return value.slice(directPrefix.length);
    }
  }
  return null;
}

function normalizeEndpoint(value: string | null | undefined): `/${string}` {
  const trimmed = value?.trim();
  if (!trimmed) {
    return DEFAULT_HTTP_ENDPOINT;
  }
  return (trimmed.startsWith('/') ? trimmed : `/${trimmed}`) as `/${string}`;
}

function parsePort(value: string | null | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid agent-teams MCP HTTP port: ${value ?? '<empty>'}`);
  }
  return parsed;
}

function readIdentityValue(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

export function buildHttpHealthIdentity(
  options: AgentTeamsMcpStartOptions,
  env: NodeJS.ProcessEnv = process.env
): AgentTeamsMcpHttpHealthIdentity | null {
  if (options.transportType !== HTTP_TRANSPORT) {
    return null;
  }

  const service = readIdentityValue(env, MCP_HTTP_IDENTITY_SERVICE_ENV);
  const claudeDirHash = readIdentityValue(env, MCP_HTTP_CLAUDE_DIR_HASH_ENV);
  const launchSpecHash = readIdentityValue(env, MCP_HTTP_LAUNCH_SPEC_HASH_ENV);
  const ownerInstanceId = readIdentityValue(env, MCP_HTTP_OWNER_INSTANCE_ID_ENV);
  if (
    service !== MCP_HTTP_IDENTITY_SERVICE ||
    !claudeDirHash ||
    !launchSpecHash ||
    !ownerInstanceId
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    service: MCP_HTTP_IDENTITY_SERVICE,
    transport: HTTP_TRANSPORT,
    host: options.httpStream.host,
    port: options.httpStream.port,
    endpoint: options.httpStream.endpoint,
    claudeDirHash,
    launchSpecHash,
    ownerInstanceId,
  };
}

export function resolveStartOptions(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): AgentTeamsMcpStartOptions {
  const transport =
    getArgValue(argv, '--transport') ??
    getArgValue(argv, '--transportType') ??
    env.AGENT_TEAMS_MCP_TRANSPORT ??
    STDIO_TRANSPORT;

  if (transport !== HTTP_TRANSPORT) {
    return { transportType: STDIO_TRANSPORT };
  }

  return {
    transportType: HTTP_TRANSPORT,
    httpStream: {
      host:
        getArgValue(argv, '--host')?.trim() ??
        env.AGENT_TEAMS_MCP_HTTP_HOST?.trim() ??
        DEFAULT_HTTP_HOST,
      port: parsePort(getArgValue(argv, '--port') ?? env.AGENT_TEAMS_MCP_HTTP_PORT),
      endpoint: normalizeEndpoint(
        getArgValue(argv, '--endpoint') ?? env.AGENT_TEAMS_MCP_HTTP_ENDPOINT
      ),
    },
  };
}

async function main(): Promise<void> {
  const startOptions = resolveStartOptions();
  const server = createServer({ healthIdentity: buildHttpHealthIdentity(startOptions) });
  await server.start(startOptions);
}

function isEntrypoint(argv: string[] = process.argv): boolean {
  const entryPath = argv[1];
  if (!entryPath) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entryPath);
  } catch {
    return fileURLToPath(import.meta.url) === entryPath;
  }
}

if (isEntrypoint()) {
  main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
