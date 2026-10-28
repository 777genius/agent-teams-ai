// @vitest-environment node
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  BoundControlContext,
  configureDesktopMcpEnvironment,
  getDesktopMcpChildEnvironment,
} from '@features/external-agent-connection/main';
import { OpenCodeBridgeCommandClient } from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandClient';
import { cleanupManagedOpenCodeServeProcesses } from '@main/services/team/opencode/bridge/OpenCodeManagedHostProcessCleanup';
import { OpenCodeReadinessBridge } from '@main/services/team/opencode/bridge/OpenCodeReadinessBridge';
import { expect, it } from 'vitest';

it('sends zero HTTP bytes and no signal to a marker-matching listener without native custody', async () => {
  let bytes = 0;
  const server = createServer((socket) => {
    socket.on('data', (chunk) => {
      bytes += chunk.length;
      const body = '{"mcp":{"agent-teams":{"environment":{"AGENT_TEAMS_MCP_CLAUDE_DIR":"TEST"}}}}';
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const signals: number[] = [];
  try {
    const result = await cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      platform: 'win32',
      listProcessRows: async () => [
        {
          pid: 424242,
          ppid: 1,
          command: `C:\\TEST\\runtimes\\opencode\\versions\\1.18.34\\opencode-windows-x64\\opencode.exe serve --hostname 127.0.0.1 --port ${address.port}`,
        },
      ],
      readProcessStartTimeMs: async () => Date.now() - 60000,
      isProcessAlive: () => true,
      killProcess: (pid) => {
        signals.push(pid);
      },
      forceKillProcess: (pid) => {
        signals.push(pid);
      },
    });
    expect(bytes).toBe(0);
    expect(signals).toEqual([]);
    expect(result).toMatchObject({ scanned: 0, killed: 0, candidates: [] });
    expect(result.diagnostics).toContain(
      'Managed host process sweep preserved candidates: retained native custody is required.'
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('still delegates known-host cleanup through the bound frontend bridge transport', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-cleanup-delegation-')));
  const context = new BoundControlContext('TEST-cleanup-instance', root).snapshot();
  const token = 'TEST-cleanup-control-token-0123456789abcdef';
  const observed: Array<Record<string, unknown>> = [];
  const data = {
    cleaned: 1,
    remaining: 0,
    hosts: [
      {
        hostKey: 'TEST-retained-native-host',
        projectPath: root,
        pid: 424242,
        port: 54321,
        action: 'disposed',
        reason: 'TEST native boundary acknowledgement',
        leaseCount: 0,
      },
    ],
    diagnostics: [],
  };
  const receiver = createHttpServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const authorized =
      request.headers.authorization === `Bearer ${token}` &&
      request.headers['x-agent-teams-app-context'] === JSON.stringify(context);
    observed.push({ authorized, command: envelope.command, body: envelope.body });
    if (!authorized || request.url !== '/TEST/runtime-bridge') {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        ok: true,
        schemaVersion: envelope.schemaVersion,
        requestId: envelope.requestId,
        command: envelope.command,
        completedAt: new Date().toISOString(),
        durationMs: 1,
        runtime: {
          providerId: 'opencode',
          binaryPath: '/TEST/runtime-cli',
          binaryFingerprint: 'TEST-runtime',
          version: 'TEST',
          capabilitySnapshotId: 'TEST-capabilities',
        },
        diagnostics: [],
        data,
      })
    );
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const address = receiver.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const revoke = configureDesktopMcpEnvironment(() => ({
    AGENT_TEAMS_MCP_CLAUDE_DIR: root,
    AGENT_TEAMS_BOUND_CONTROL_URL: baseUrl,
    AGENT_TEAMS_BOUND_CONTROL_AUTH_TOKEN: token,
    AGENT_TEAMS_BOUND_CONTEXT_JSON: JSON.stringify(context),
  }));
  let runnerCalls = 0;
  const client = new OpenCodeBridgeCommandClient({
    binaryPath: '/TEST/runtime-cli',
    tempDirectory: path.join(root, 'bridge-input'),
    envProvider: () => getDesktopMcpChildEnvironment(),
    // Only the native runner boundary is synthetic. No CLI or native process is started.
    processRunner: {
      async run(input) {
        runnerCalls++;
        const inputFile = input.args[input.args.indexOf('--input') + 1];
        expect(inputFile.startsWith(root + path.sep)).toBe(true);
        const envelope = await readFile(inputFile, 'utf8');
        const result = await fetch(
          `${input.env.AGENT_TEAMS_BOUND_CONTROL_URL}/TEST/runtime-bridge`,
          {
            method: 'POST',
            redirect: 'error',
            headers: {
              authorization: `Bearer ${input.env.AGENT_TEAMS_BOUND_CONTROL_AUTH_TOKEN}`,
              'x-agent-teams-app-context': input.env.AGENT_TEAMS_BOUND_CONTEXT_JSON!,
            },
            body: envelope,
          }
        );
        return {
          stdout: await result.text(),
          stderr: '',
          exitCode: result.ok ? 0 : 1,
          timedOut: false,
        };
      },
    },
  });
  try {
    const bridge = new OpenCodeReadinessBridge(client);
    expect(
      await bridge.cleanupOpenCodeHosts({ reason: 'startup', mode: 'stale', projectPath: root })
    ).toEqual(data);
    expect(runnerCalls).toBe(1);
    expect(observed).toEqual([
      {
        authorized: true,
        command: 'opencode.cleanupHosts',
        body: { reason: 'startup', mode: 'stale', projectPath: root },
      },
    ]);
  } finally {
    revoke();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
