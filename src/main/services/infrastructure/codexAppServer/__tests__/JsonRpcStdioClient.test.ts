import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { JsonRpcStdioClient } from '../JsonRpcStdioClient';

const tempDirs: string[] = [];

function createStrictJsonRpcServerScript(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-rpc-stdio-client-'));
  tempDirs.push(tempDir);
  const scriptPath = path.join(tempDir, 'server.cjs');
  fs.writeFileSync(
    scriptPath,
    `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.jsonrpc !== '2.0') {
    return;
  }
  if (message.method === 'fail') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: 'No such method', data: { method: message.method } },
    }) + '\\n');
    return;
  }
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: message.id,
    result: { ok: true, params: message.params },
  }) + '\\n');
});
`,
    'utf8'
  );
  return scriptPath;
}

function createSignalIgnoringJsonRpcServerScript(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-rpc-stdio-client-'));
  tempDirs.push(tempDir);
  const scriptPath = path.join(tempDir, 'server.cjs');
  fs.writeFileSync(
    scriptPath,
    `
const readline = require('node:readline');
process.on('SIGTERM', () => {});
setInterval(() => {}, 10_000);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.jsonrpc !== '2.0') {
    return;
  }
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: message.id,
    result: { ok: true },
  }) + '\\n');
});
`,
    'utf8'
  );
  return scriptPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('JsonRpcStdioClient', () => {
  it('sends JSON-RPC 2.0 framed requests and preserves structured errors', async () => {
    const scriptPath = createStrictJsonRpcServerScript();
    const client = new JsonRpcStdioClient({ warn: () => undefined });

    await client.withSession(
      {
        binaryPath: process.execPath,
        args: [scriptPath],
        label: 'strict json-rpc smoke',
        requestTimeoutMs: 1_000,
        totalTimeoutMs: 2_000,
      },
      async (session) => {
        await expect(session.request('ping', { value: 1 })).resolves.toEqual({
          ok: true,
          params: { value: 1 },
        });

        await expect(session.request('fail')).rejects.toMatchObject({
          method: 'fail',
          code: -32601,
          data: { method: 'fail' },
          details: { method: 'fail' },
        });
      }
    );
  });

  it('force kills the child when session close does not finish gracefully', async () => {
    const scriptPath = createSignalIgnoringJsonRpcServerScript();
    const warn = vi.fn();
    const client = new JsonRpcStdioClient({ warn });

    await client.withSession(
      {
        binaryPath: process.execPath,
        args: [scriptPath],
        label: 'stubborn json-rpc close',
        requestTimeoutMs: 1_000,
        totalTimeoutMs: 2_000,
        closeTimeoutMs: 25,
        forceCloseTimeoutMs: 1_000,
      },
      async (session) => {
        await expect(session.request('ping')).resolves.toEqual({ ok: true });
      }
    );

    expect(warn).toHaveBeenCalledWith('json-rpc close timed out; force killing process', {
      pid: expect.any(Number),
      timeoutMs: 25,
    });
  });
});
