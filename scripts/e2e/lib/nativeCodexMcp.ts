import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

import type { AppConnectionContext } from '../../../src/features/external-agent-connection/contracts/index.ts';

const execute = promisify(execFile);
const REQUEST_TIMEOUT_MS = 45_000;
const SERVER_NAME = 'agent-teams-native-e2e';
const REQUIRED_TOOLS = ['app_get_connection_info', 'team_create', 'team_get'];

export interface NativeCodexMcpInput {
  url: string;
  expectedContext: AppConnectionContext;
  /** Fresh sandbox project; never pass a real user project. */
  cwd: string;
  /** New disposable directory, retained as evidence. Must not already exist. */
  workRoot: string;
  teamName: string;
}

export interface NativeCodexMcpEvidence {
  client: 'codex-cli-app-server';
  nativeVersion: string;
  toolNames: string[];
  created: Record<string, unknown>;
  readback: Record<string, unknown>;
}

interface RpcPending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), label);
  return value as Record<string, unknown>;
}

function toolValue(result: unknown, name: string): Record<string, unknown> {
  const response = record(result, `${name}: invalid native tool response`);
  const content = Array.isArray(response.content) ? response.content : [];
  const text = content
    .map((item) => record(item, 'invalid tool content'))
    .find((item) => item.type === 'text' && typeof item.text === 'string')?.text;
  if (response.isError === true) {
    throw new Error(
      `${name}: ${typeof text === 'string' ? text.slice(0, 800) : 'native MCP tool error'}`
    );
  }
  if (response.structuredContent !== undefined && response.structuredContent !== null) {
    return record(response.structuredContent, `${name}: invalid structured content`);
  }
  assert.equal(typeof text, 'string', `${name}: missing tool result text`);
  return record(JSON.parse(text as string), `${name}: non-object tool result`);
}

function nativeRpc(child: ChildProcessWithoutNullStreams) {
  const pending = new Map<number, RpcPending>();
  let sequence = 0;
  let failure: Error | null = null;
  let closing = false;
  const lines = createInterface({ input: child.stdout });
  // Drain diagnostics without exposing credentials or unrelated environment details.
  child.stderr.resume();
  const fail = (error: Error) => {
    failure = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  child.once('error', fail);
  child.stdin.on('error', fail);
  child.once('exit', (code, signal) => {
    if (!closing) fail(new Error(`Native Codex app-server exited (${code ?? signal})`));
  });
  lines.on('line', (line) => {
    try {
      const message = record(JSON.parse(line), 'Invalid app-server JSON-RPC message');
      if (message.id !== undefined && typeof message.method === 'string') {
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32601,
              message: 'Unsupported server request in native MCP verification',
            },
          }) + '\n'
        );
        fail(
          new Error(
            `Native MCP verification requires unsupported server request: ${message.method}`
          )
        );
        return;
      }
      if (typeof message.id !== 'number') return;
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error !== undefined) {
        const error = record(message.error, 'Invalid JSON-RPC error');
        request.reject(
          new Error(
            `Native Codex RPC ${String(error.code)}: ${String(error.message).slice(0, 800)}`
          )
        );
      } else {
        request.resolve(message.result);
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const request = (
    method: string,
    params: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS
  ) => {
    if (failure) return Promise.reject(failure);
    const id = ++sequence;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Native Codex ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (error) => {
        if (error) fail(error);
      });
    });
  };
  const close = async () => {
    closing = true;
    fail(new Error('Native Codex verification finished'));
    lines.close();
    child.stdin.end();
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      child.kill('SIGTERM');
    });
  };
  return {
    request,
    close,
    notify: (method: string) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
    },
  };
}

/** Native Codex MCP calls only: never starts an inference turn or consumes provider auth. */
export async function verifyNativeCodexMcp(
  input: NativeCodexMcpInput
): Promise<NativeCodexMcpEvidence> {
  const endpoint = new URL(input.url);
  assert(
    endpoint.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname),
    'Native MCP verification requires the sandbox app loopback endpoint'
  );
  assert(
    !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
    'Native MCP endpoint must not contain credentials, query or fragment'
  );
  await mkdir(input.workRoot);
  const codexHome = path.join(input.workRoot, 'codex-home');
  const home = path.join(input.workRoot, 'home');
  await Promise.all([mkdir(codexHome), mkdir(home)]);
  // Deliberate allowlist: no auth/API keys, proxies, existing Codex settings or credentials.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    HOME: home,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
  };
  const options = { cwd: input.cwd, env, timeout: REQUEST_TIMEOUT_MS, maxBuffer: 64 * 1024 };
  const version = await execute('codex', ['--version'], options);
  const nativeVersion = version.stdout.trim();
  assert(nativeVersion.startsWith('codex-cli '), 'Unexpected native Codex binary version');
  await execute('codex', ['mcp', 'add', SERVER_NAME, '--url', input.url], options);
  const child = spawn(
    'codex',
    ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="file"'],
    { cwd: input.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const rpc = nativeRpc(child);
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'agent-teams-native-e2e', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    rpc.notify('initialized');
    const started = record(
      await rpc.request('thread/start', {
        cwd: input.cwd,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        ephemeral: true,
      }),
      'Invalid native thread/start response'
    );
    const threadId = record(started.thread, 'Native thread missing').id;
    assert.equal(typeof threadId, 'string', 'Native thread id missing');
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    let toolNames: string[] = [];
    while (Date.now() < deadline) {
      const status = record(
        await rpc.request(
          'mcpServerStatus/list',
          { threadId, serverName: SERVER_NAME },
          Math.max(1, deadline - Date.now())
        ),
        'Invalid native MCP status response'
      );
      assert(Array.isArray(status.data), 'Native MCP status missing data');
      const server = status.data
        .map((entry) => record(entry, 'Invalid native MCP server status'))
        .find((entry) => entry.name === SERVER_NAME);
      if (server) {
        if (
          ['authenticationRequired', 'failed', 'cancelled', 'disabled'].includes(
            String(server.runtimeStatus)
          )
        ) {
          throw new Error(
            `Native MCP connection ${String(server.runtimeStatus)}: ${String(server.toolsError ?? server.authStatus).slice(0, 800)}`
          );
        }
        toolNames = Object.values(record(server.tools, 'Native MCP tools missing'))
          .map((tool) => String(record(tool, 'Invalid native MCP tool').name))
          .sort();
        if (REQUIRED_TOOLS.every((name) => toolNames.includes(name))) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(
      REQUIRED_TOOLS.every((name) => toolNames.includes(name)),
      'Native MCP required tools unavailable'
    );
    const call = async (tool: string, args: Record<string, unknown>) =>
      toolValue(
        await rpc.request('mcpServer/tool/call', {
          server: SERVER_NAME,
          threadId,
          tool,
          arguments: args,
        }),
        tool
      );
    const discovered = await call('app_get_connection_info', {});
    const liveContext = record(discovered.context, 'Native discovery context missing');
    for (const field of ['appInstanceId', 'dataRootFingerprint', 'connectionGeneration'] as const) {
      assert.equal(
        liveContext[field],
        input.expectedContext[field],
        `Native discovery changed ${field}`
      );
    }
    const created = await call('team_create', {
      teamName: input.teamName,
      cwd: input.cwd,
      runtimeSelectionVersion: 1,
      expectedContext: input.expectedContext,
      prompt: 'Coordinate this disposable native MCP contract team.',
      members: [
        { name: 'developer', role: 'developer', workflow: 'Implement scoped sandbox work.' },
      ],
    });
    assert.equal(created.runtimeSelectionVersion, 1, 'Native create dropped marker');
    assert.equal(created.draft, true, 'Native create did not return a draft');
    assert.equal(created.runtimeSelection, 'unresolved', 'Native create selected a runtime');
    const readback = await call('team_get', { teamName: input.teamName });
    const saved = record(readback.savedRequest, 'Native draft readback missing savedRequest');
    assert.equal(readback.pendingCreate, true, 'Native readback is not a draft');
    assert.equal(saved.runtimeSelectionVersion, 1, 'Native readback dropped marker');
    assert.equal(saved.providerId, undefined, 'Native readback invented a provider');
    assert(
      Array.isArray(saved.members) && saved.members.length === 1,
      'Native readback lost roster'
    );
    const member = record(saved.members[0], 'Native readback invalid member');
    assert.equal(member.name, 'developer');
    assert.equal(member.workflow, 'Implement scoped sandbox work.');
    assert.equal(member.providerId, undefined, 'Native readback invented member provider');
    return { client: 'codex-cli-app-server', nativeVersion, toolNames, created, readback };
  } finally {
    await rpc.close();
  }
}
