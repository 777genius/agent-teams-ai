import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(repoRoot, 'dist', 'index.js');

const children: ChildProcess[] = [];

async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate HTTP e2e port')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function readHealthBody(port: number): Promise<{ statusCode: number | null; body: string }> {
  return new Promise((resolve) => {
    let body = '';
    const request = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/health',
        timeout: 1_000,
      },
      (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => resolve({ statusCode: response.statusCode ?? null, body }));
      }
    );
    request.once('timeout', () => {
      request.destroy();
      resolve({ statusCode: null, body: '' });
    });
    request.once('error', () => resolve({ statusCode: null, body: '' }));
  });
}

async function waitForHealthBody(port: number): Promise<{ statusCode: number | null; body: string }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const result = await readHealthBody(port);
    if (result.statusCode === 200) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`HTTP MCP server did not become healthy on port ${port}`);
}

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once('exit', () => resolve());
          child.kill('SIGTERM');
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill('SIGKILL');
            }
          }, 500).unref();
        })
    )
  );
});

describe('agent-teams-mcp HTTP e2e', () => {
  it('returns app-managed JSON identity from /health when identity env is present', async () => {
    const port = await allocateLoopbackPort();
    const child = spawn(
      process.execPath,
      [
        serverEntry,
        '--transport',
        'httpStream',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--endpoint',
        'mcp',
      ],
      {
        env: {
          ...process.env,
          AGENT_TEAMS_MCP_HTTP_IDENTITY_SERVICE: 'agent-teams-mcp-http',
          AGENT_TEAMS_MCP_HTTP_CLAUDE_DIR_HASH: 'claude-dir-hash-e2e',
          AGENT_TEAMS_MCP_HTTP_LAUNCH_SPEC_HASH: 'launch-spec-hash-e2e',
          AGENT_TEAMS_MCP_HTTP_OWNER_INSTANCE_ID: 'owner-e2e',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    );
    children.push(child);

    const health = await waitForHealthBody(port);
    const parsed = JSON.parse(health.body) as Record<string, unknown>;

    expect(health.statusCode).toBe(200);
    expect(parsed).toEqual({
      schemaVersion: 1,
      service: 'agent-teams-mcp-http',
      transport: 'httpStream',
      host: '127.0.0.1',
      port,
      endpoint: '/mcp',
      claudeDirHash: 'claude-dir-hash-e2e',
      launchSpecHash: 'launch-spec-hash-e2e',
      ownerInstanceId: 'owner-e2e',
    });
  });
});
