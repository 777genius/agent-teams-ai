import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(repoRoot, 'dist', 'index.js');

const children: ChildProcess[] = [];
const tempDirectories: string[] = [];

type McpHttpResponse = {
  statusCode: number | null;
  headers: http.IncomingHttpHeaders;
  body: string;
};

function parseMcpResponse(body: string, expectedId: number): Record<string, unknown> {
  const dataLines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'));
  const messages = (
    dataLines.length > 0 ? dataLines.map((line) => line.slice(5).trim()) : [body]
  ).map((payload) => JSON.parse(payload) as Record<string, unknown>);
  const response = messages.find((message) => message.id === expectedId);
  if (!response) {
    throw new Error(`HTTP MCP response did not include JSON-RPC id ${expectedId}`);
  }
  return response;
}

function parseJsonToolResult(response: Record<string, unknown>): Record<string, unknown> {
  const result = response.result as {
    content?: Array<{ text?: string }>;
    isError?: boolean;
  };
  const text = result.content?.[0]?.text;
  if (result.isError) {
    throw new Error(text ?? 'Tool returned an unspecified error');
  }
  return JSON.parse(text ?? 'null') as Record<string, unknown>;
}

async function postMcp(
  port: number,
  payload: Record<string, unknown>,
  sessionId?: string
): Promise<McpHttpResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
        timeout: 5_000,
      },
      (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          responseBody += chunk;
        });
        response.on('end', () =>
          resolve({
            statusCode: response.statusCode ?? null,
            headers: response.headers,
            body: responseBody,
          })
        );
      }
    );
    request.once('timeout', () => request.destroy(new Error('HTTP MCP request timed out')));
    request.once('error', reject);
    request.end(body);
  });
}

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

async function waitForHealthBody(
  port: number
): Promise<{ statusCode: number | null; body: string }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
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
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
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

  it('executes task create, start, reassign, and complete through HTTP MCP', async () => {
    const claudeDir = await mkdtemp(path.join(os.tmpdir(), 'agent-teams-mcp-http-e2e-'));
    tempDirectories.push(claudeDir);
    const teamName = 'http-lifecycle-team';
    const teamDir = path.join(claudeDir, 'teams', teamName);
    await mkdir(teamDir, { recursive: true });
    await writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: teamName,
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'alice', agentType: 'teammate', role: 'developer' },
          { name: 'bob', agentType: 'teammate', role: 'reviewer' },
        ],
      }),
      'utf8'
    );

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
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    children.push(child);
    await waitForHealthBody(port);

    const initialize = await postMcp(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vitest-http-e2e', version: '1.0.0' },
      },
    });
    expect(initialize.statusCode).toBe(200);
    expect(parseMcpResponse(initialize.body, 1)).toHaveProperty('result');
    const sessionId = initialize.headers['mcp-session-id'];
    expect(typeof sessionId).toBe('string');

    const initialized = await postMcp(
      port,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      sessionId as string
    );
    expect([200, 202]).toContain(initialized.statusCode);

    let requestId = 2;
    const callTool = async (name: string, args: Record<string, unknown>) => {
      const id = requestId++;
      const response = await postMcp(
        port,
        {
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args },
        },
        sessionId as string
      );
      expect(response.statusCode).toBe(200);
      return parseJsonToolResult(parseMcpResponse(response.body, id));
    };

    const created = await callTool('task_create', {
      claudeDir,
      teamName,
      subject: 'HTTP lifecycle task',
      owner: 'alice',
      description: 'Exercise the shared HTTP MCP transport.',
    });
    expect(created.owner).toBe('alice');
    expect(typeof created.id).toBe('string');

    const started = await callTool('task_start', {
      claudeDir,
      teamName,
      taskId: created.id,
      actor: 'alice',
    });
    expect(started.status).toBe('in_progress');

    const reassigned = await callTool('task_set_owner', {
      claudeDir,
      teamName,
      taskId: created.id,
      actor: 'team-lead',
      owner: 'bob',
    });
    expect(reassigned.owner).toBe('bob');

    const completed = await callTool('task_complete', {
      claudeDir,
      teamName,
      taskId: created.id,
      actor: 'bob',
    });
    expect(completed.status).toBe('completed');
    expect(completed.owner).toBe('bob');
  });
});
