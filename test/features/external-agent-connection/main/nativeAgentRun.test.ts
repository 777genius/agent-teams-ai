// @vitest-environment node
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  nativeAgentRunArgs,
  prepareNativeAgentRun,
} from '@features/external-agent-connection/main/nativeAgentRun';
import { killProcessTreeAndWait,spawnCli } from '@main/utils/childProcess';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionInfoV1 } from '@features/external-agent-connection/contracts';
import type { ChildProcess } from 'node:child_process';

vi.mock('@main/services/infrastructure/codexAppServer/CodexBinaryResolver', () => ({
  CodexBinaryResolver: { resolve: async () => '/sandbox/bin/codex' },
}));
vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: { resolveNative: async () => '/sandbox/bin/claude' },
}));
vi.mock('@main/services/runtime/providerAwareCliEnv', () => ({
  buildProviderAwareCliEnv: async () => ({
    env: { CLAUDECODE: 'nested', ELECTRON_RUN_AS_NODE: '1', TEST_PROVIDER_AUTH: 'retained' },
    providerArgs: [],
    connectionIssues: {},
  }),
}));
vi.mock('node:fs/promises', () => ({
  mkdtemp: async () => '/sandbox/native-run-temp',
  rm: vi.fn(async () => {}),
}));
vi.mock('@main/utils/childProcess', () => ({
  spawnCli: vi.fn(),
  killProcessTreeAndWait: vi.fn(),
  untrackCliProcess: vi.fn(),
}));

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 444;
  exitCode: number | null = null;
  signalCode: string | null = null;
  close(code: number | null) {
    this.exitCode = code;
    this.emit('close', code);
  }
}
const connection: ConnectionInfoV1 = {
  schemaVersion: 1,
  context: {
    appInstanceId: 'sandbox',
    dataRootFingerprint: 'sandbox-root',
    connectionGeneration: 1,
  },
  appVersion: 'test',
  profileFingerprint: 'sandbox-profile',
  observedAt: '2026-10-08T00:00:00.000Z',
  mcp: {
    status: 'ready',
    transport: 'httpStream',
    url: 'http://127.0.0.1:41000/mcp',
    generation: 1,
  },
  control: { status: 'ready' },
  cdp: {
    status: 'disabled',
    httpOrigin: null,
    browserWsUrl: null,
    rendererTargetId: null,
    rendererWsUrl: null,
    targetGeneration: 0,
  },
  capabilities: {
    draftCreation: true,
    configurationEdit: true,
    reversibleTrash: true,
    rendererControl: false,
  },
  errorCode: null,
  reason: null,
  recovery: null,
};
const allowed = [
  'app_get_connection_info',
  'team_list',
  'team_get',
  'team_create',
  'team_update',
  'team_trash',
];

describe('native one-shot provider transport', () => {
  let child: FakeChild;
  beforeEach(() => {
    vi.clearAllMocks();
    child = new FakeChild();
    vi.mocked(spawnCli).mockReturnValue(child as unknown as ChildProcess);
    vi.mocked(killProcessTreeAndWait).mockImplementation(async () => {
      if (child.exitCode === null) {
        child.signalCode = 'SIGKILL';
        child.close(null);
      }
    });
  });

  it('limits Codex to six management tools, read-only sandbox, no shell or user MCP config', () => {
    const args = nativeAgentRunArgs('codex', connection);
    const config = Object.fromEntries(
      args.flatMap((arg, i) => (arg === '-c' ? [args[i + 1].split(/=(.*)/s).slice(0, 2)] : []))
    );
    expect(args).toContain('--ignore-user-config');
    expect(JSON.parse(config['mcp_servers.agent-teams.enabled_tools'])).toEqual(allowed);
    expect(JSON.parse(config.sandbox_mode)).toBe('read-only');
    expect(JSON.parse(config['features.shell_tool'])).toBe(false);
    expect(JSON.parse(config['features.unified_exec'])).toBe(false);
    expect(JSON.parse(config.web_search)).toBe('disabled');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('removes Claude built-ins and denies every other registered MCP tool rather than using broad skip', () => {
    const args = nativeAgentRunArgs('anthropic', connection);
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
    const authorized = args[args.indexOf('--allowedTools') + 1].split(',');
    expect(authorized).toEqual(allowed.map((tool) => `mcp__agent-teams__${tool}`));
    const denied = args[args.indexOf('--disallowedTools') + 1].split(',');
    expect(denied).toEqual(
      expect.arrayContaining([
        'mcp__agent-teams__team_launch',
        'mcp__agent-teams__team_stop',
        'mcp__agent-teams__task_start',
        'mcp__agent-teams__message_send',
      ])
    );
    expect(authorized.some((tool) => denied.includes(tool))).toBe(false);
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('writes prompt through stdin in sandbox cwd, preserves provider auth and fails a Claude error result even with exit zero', async () => {
    const runtime = await prepareNativeAgentRun('anthropic', connection);
    const output: string[] = [];
    const result = runtime.launch('Private sandbox request', (text) => output.push(text));
    const [binary, args, options] = vi.mocked(spawnCli).mock.calls[0];
    expect(binary).toBe('/sandbox/bin/claude');
    expect(args).not.toContain('Private sandbox request');
    expect(options?.cwd).toBe('/sandbox/native-run-temp');
    expect(options?.env?.TEST_PROVIDER_AUTH).toBe('retained');
    expect(options?.env?.CLAUDECODE).toBeUndefined();
    expect(options?.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(child.stdin.read()?.toString()).toBe('Private sandbox request');
    child.stdout.write('{"type":"result","subtype":"error_max_turns","is_error":true}\n');
    child.close(0);
    expect(await result).toEqual({ successful: false });
    expect(output.join('\n')).toContain('error_max_turns');
    await runtime.dispose();
  });

  it('does not report success after a native error event followed by turn.completed', async () => {
    const runtime = await prepareNativeAgentRun('codex', connection);
    const result = runtime.launch('Sandbox request', () => {});
    child.stdout.write('{"type":"error","message":"request failed"}\n{"type":"turn.completed"}\n');
    child.close(0);
    expect(await result).toEqual({ successful: false });
    await runtime.dispose();
  });

  it('bounds large tool output without failing an independently confirmed successful process', async () => {
    const runtime = await prepareNativeAgentRun('codex', connection);
    const output: string[] = [];
    const result = runtime.launch('Sandbox request', (text) => output.push(text));
    child.stdout.write(
      `${JSON.stringify({ type: 'item.completed', result: 'x'.repeat(40_000) })}\n`
    );
    child.stdout.write('{"type":"turn.completed"}\n');
    child.close(0);
    expect(await result).toEqual({ successful: true });
    expect(output.every((line) => line.length <= 32_000)).toBe(true);
    await runtime.dispose();
  });

  it('keeps fragmented UTF8 output intact and requires native completion plus successful exit', async () => {
    const runtime = await prepareNativeAgentRun('codex', connection);
    const output: string[] = [];
    const result = runtime.launch('Sandbox request', (text) => output.push(text));
    const line = Buffer.from(
      '{"type":"item.completed","text":"Привет"}\n{"type":"turn.completed"}\n'
    );
    for (const byte of line) child.stdout.write(Buffer.from([byte]));
    child.close(0);
    expect(await result).toEqual({ successful: true });
    expect(output.join('\n')).toContain('Привет');
    await runtime.dispose();
  });
});
