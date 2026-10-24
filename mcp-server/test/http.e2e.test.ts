import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  sessionId?: string,
  headers: Record<string, string> = {}
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
          ...headers,
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
  // Fails if bound HTTP tools lose marker/context, retarget via fallback, follow redirects,
  // accept stale expectations, queue work-sync after rejection, or expose browser-origin access.
  it('binds external discovery and draft requests to one app context across the real HTTP transport', async () => {
    const claudeDir = await mkdtemp(path.join(os.tmpdir(), 'agent-teams-bound-mcp-e2e-'));
    tempDirectories.push(claudeDir);
    const context = {
      appInstanceId: 'sandbox-app',
      dataRootFingerprint: 'sandbox-root',
      connectionGeneration: 4,
    };
    const teamName = 'bound-draft';
    const teamDir = path.join(claudeDir, 'teams', teamName);
    await mkdir(teamDir, { recursive: true });
    const configFile = path.join(teamDir, 'config.json');
    const requests: Array<{ url: string; context: unknown; body: Record<string, unknown> }> = [];
    let redirect = false;
    const fallbackRequests: string[] = [];
    const fallback = http.createServer((req, res) => {
      fallbackRequests.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    await new Promise<void>((resolve) => fallback.listen(0, '127.0.0.1', resolve));
    const fallbackUrl = `http://127.0.0.1:${(fallback.address() as net.AddressInfo).port}`;
    const control = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      requests.push({
        url: req.url ?? '',
        context: JSON.parse(String(req.headers['x-agent-teams-app-context'] ?? 'null')),
        body,
      });
      if (redirect) {
        res.writeHead(307, { location: `${fallbackUrl}/redirected` }).end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/app/connection') {
        res.end(JSON.stringify({ schemaVersion: 1, context }));
      } else if (req.url === '/api/teams' && req.method === 'POST') {
        const saved = { ...body, name: teamName, members: body.members ?? [], isDraft: true };
        await writeFile(configFile, JSON.stringify(saved));
        res.end(JSON.stringify(saved));
      } else if (req.url === `/api/teams/${teamName}`) {
        res.end(await readFile(configFile, 'utf8'));
      } else {
        res.end(JSON.stringify({ accepted: true, memberName: 'alice' }));
      }
    });
    await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', resolve));
    const controlUrl = `http://127.0.0.1:${(control.address() as net.AddressInfo).port}`;
    await writeFile(
      path.join(claudeDir, 'team-control-api.json'),
      JSON.stringify({ baseUrl: fallbackUrl })
    );
    const port = await allocateLoopbackPort();
    const child = spawn(
      process.execPath,
      [serverEntry, '--transport', 'httpStream', '--host', '127.0.0.1', '--port', String(port)],
      {
        env: {
          ...process.env,
          AGENT_TEAMS_BOUND_CONTROL_URL: controlUrl,
          AGENT_TEAMS_BOUND_CONTEXT_JSON: JSON.stringify(context),
          AGENT_TEAMS_MCP_CLAUDE_DIR: claudeDir,
          CLAUDE_TEAM_CONTROL_URL: fallbackUrl,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    );
    children.push(child);
    try {
      await waitForHealthBody(port);
      const initializePayload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'bound-sandbox-test', version: '1.0.0' },
        },
      };
      const invalidHeaders: Array<Record<string, string>> = [
        { origin: 'https://foreign.example' },
        { host: 'foreign.example' },
      ];
      for (const headers of invalidHeaders) {
        const denied = await postMcp(port, initializePayload, undefined, headers);
        expect(denied.statusCode).toBe(403);
        expect(denied.headers['access-control-allow-origin']).toBeUndefined();
        for (const method of ['GET', 'DELETE', 'OPTIONS']) {
          const result = await new Promise<McpHttpResponse>((resolve, reject) => {
            const req = http.request(
              { host: '127.0.0.1', port, path: '/mcp', method, headers },
              (res) => {
                res.resume();
                res.on('end', () =>
                  resolve({ statusCode: res.statusCode ?? null, headers: res.headers, body: '' })
                );
              }
            );
            req.once('error', reject);
            req.end();
          });
          expect(result.statusCode).toBe(403);
          expect(result.headers['access-control-allow-origin']).toBeUndefined();
        }
      }
      const initialized = await postMcp(port, initializePayload);
      expect(initialized.statusCode).toBe(200);
      expect(initialized.headers['access-control-allow-origin']).toBeUndefined();
      const sessionId = String(initialized.headers['mcp-session-id']);
      await postMcp(port, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
      let nextId = 2;
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const id = nextId++;
        const response = await postMcp(
          port,
          { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
          sessionId
        );
        return parseJsonToolResult(parseMcpResponse(response.body, id));
      };
      expect((await call('app_get_connection_info')).context).toEqual(context);
      await expect(call('app_get_connection_info', { controlUrl: fallbackUrl })).rejects.toThrow();
      const args = {
        teamName,
        runtimeSelectionVersion: 1,
        expectedContext: context,
        members: [{ name: 'alice', role: 'developer', workflow: 'Implement scoped changes' }],
        prompt: 'Coordinate review',
      };
      const created = await call('team_create', args);
      expect(created.runtimeSelectionVersion).toBe(1);
      expect(created.expectedContext).toEqual(context);
      expect(created).not.toHaveProperty('providerId');
      expect(await call('team_get', { teamName })).toEqual(created);
      expect(JSON.parse(await readFile(configFile, 'utf8'))).toEqual(created);
      const rejected = [
        { ...args, expectedContext: { ...context, connectionGeneration: 3 } },
        { ...args, expectedContext: undefined },
        { ...args, runtimeSelectionVersion: 2 },
        { ...args, controlUrl: fallbackUrl },
        { ...args, controlUrl: '' },
        { ...args, claudeDir: path.join(claudeDir, 'other-root') },
      ];
      const before = requests.length;
      for (const input of rejected) await expect(call('team_create', input)).rejects.toThrow();
      expect(requests).toHaveLength(before);
      await call('member_work_sync_status', { teamName, memberName: 'alice' });
      await call('member_work_sync_report', {
        teamName,
        memberName: 'alice',
        state: 'caught_up',
        agendaFingerprint: 'test-agenda',
        reportToken: 'test-token',
      });
      await call('runtime_heartbeat', {
        teamName,
        runId: 'sandbox-run',
        memberName: 'alice',
        runtimeSessionId: 'sandbox-session',
      });
      expect(
        requests.every((request) => JSON.stringify(request.context) === JSON.stringify(context))
      ).toBe(true);
      redirect = true;
      await expect(call('team_list')).rejects.toThrow();
      await expect(
        call('member_work_sync_report', {
          teamName,
          memberName: 'alice',
          state: 'caught_up',
          agendaFingerprint: 'test-agenda',
          reportToken: 'test-token',
        })
      ).rejects.toThrow();
      expect(fallbackRequests).toEqual([]);
      await expect(
        readFile(path.join(teamDir, '.member-work-sync', 'pending-reports.json'), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => control.close(() => resolve())),
        new Promise<void>((resolve) => fallback.close(() => resolve())),
      ]);
    }
  });

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
