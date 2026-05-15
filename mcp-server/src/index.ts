#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { FastMCP } from 'fastmcp';

import { registerTools } from './tools';

const HTTP_TRANSPORT = 'httpStream';
const STDIO_TRANSPORT = 'stdio';
const DEFAULT_HTTP_HOST = '127.0.0.1';
const DEFAULT_HTTP_ENDPOINT = '/mcp';

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

export function createServer() {
  const server = new FastMCP({
    name: 'agent-teams-mcp',
    version: '1.0.0',
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
      endpoint: normalizeEndpoint(getArgValue(argv, '--endpoint') ?? env.AGENT_TEAMS_MCP_HTTP_ENDPOINT),
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer();
  void server.start(resolveStartOptions());
}
