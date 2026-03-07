#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { FastMCP } from 'fastmcp';

import { registerTools } from './tools';

export function createServer() {
  const server = new FastMCP({
    name: 'agent-teams-mcp',
    version: '1.0.0',
  });

  registerTools(server);

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer();
  void server.start({
    transportType: 'stdio',
  });
}
