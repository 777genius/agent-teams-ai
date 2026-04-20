/**
 * ScheduledTaskExecutor tests — covers process spawning, output capture,
 * argument building, cancellation, and error handling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

import type { ExecutionRequest } from '../../../../src/main/services/schedule/ScheduledTaskExecutor';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSpawnCli = vi.fn();
const mockKillProcessTree = vi.fn();
const mockResolve = vi.fn();
const mockResolveShellEnv = vi.fn();
const buildProviderAwareCliEnvMock = vi.fn();

vi.mock('@main/utils/childProcess', () => ({
  spawnCli: (...args: unknown[]) => mockSpawnCli(...args),
  killProcessTree: (...args: unknown[]) => mockKillProcessTree(...args),
}));

vi.mock('@main/utils/shellEnv', () => ({
  resolveInteractiveShellEnv: () => mockResolveShellEnv(),
}));

vi.mock('../../../../src/main/services/runtime/providerAwareCliEnv', () => ({
  buildProviderAwareCliEnv: (...args: Parameters<typeof buildProviderAwareCliEnvMock>) =>
    buildProviderAwareCliEnvMock(...args),
}));

vi.mock('../../../../src/main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: {
    resolve: () => mockResolve(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Flush pending microtasks so that execute()'s internal awaits
 * (ClaudeBinaryResolver.resolve, resolveInteractiveShellEnv) complete
 * and spawnCli gets called.
 */
function flushAsync(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 12345;
  return proc;
}

function makeRequest(overrides?: Partial<ExecutionRequest>): ExecutionRequest {
  return {
    runId: 'run-001',
    config: {
      cwd: '/tmp/project',
      prompt: 'Run the tests',
    },
    maxTurns: 50,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScheduledTaskExecutor', () => {
  let ScheduledTaskExecutor: typeof import('../../../../src/main/services/schedule/ScheduledTaskExecutor').ScheduledTaskExecutor;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockResolve.mockResolvedValue('/usr/local/bin/claude');
    mockResolveShellEnv.mockResolvedValue({ SHELL: '/bin/zsh' });
    buildProviderAwareCliEnvMock.mockResolvedValue({
      env: { ...process.env, SHELL: '/bin/zsh' },
      connectionIssues: {},
      providerArgs: [],
    });

    const mod = await import('../../../../src/main/services/schedule/ScheduledTaskExecutor');
    ScheduledTaskExecutor = mod.ScheduledTaskExecutor;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Basic Execution ---

  it('executes and returns result on successful exit', async () => {
    const proc = createMockProcess();
    mockSpawnCli.mockReturnValue(proc);

    const executor = new ScheduledTaskExecutor();
    const resultPromise = executor.execute(makeRequest());

    // Flush microtasks so execute() reaches spawnCli and sets up listeners
    await flushAsync();

    proc.stdout.emit('data', Buffer.from('Task completed'));
    proc.emit('close', 0);

    const result = await resultPromise;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Task completed');
    expect(result.stderr).toBe('');
    expect(result.summary).toBe('Task completed');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns non-zero exit code on failure', async () => {
    const proc = createMockProcess();
    mockSpawnCli.mockReturnValue(proc);

    const executor = new ScheduledTaskExecutor();
    const resultPromise = executor.execute(makeRequest());

    await flushAsync();

    proc.stderr.emit('data', Buffer.from('Error: something broke'));
    proc.emit('close', 1);

    const result = await resultPromise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('Error: something broke');
  });

  it('appends provider launch overrides returned by provider-aware env resolution', async () => {
    buildProviderAwareCliEnvMock.mockResolvedValue({
      env: { ...process.env, SHELL: '/bin/zsh' },
      connectionIssues: {},
      providerArgs: ['--settings', '{"codex":{"forced_login_method":"chatgpt"}}'],
    });
    const proc = createMockProcess();
    mockSpawnCli.mockReturnValue(proc);

    const executor = new ScheduledTaskExecutor();
    const resultPromise = executor.execute(
      makeRequest({
        config: {
          cwd: '/tmp/project',
          prompt: 'Run the tests',
          providerId: 'codex',
        },
      })
    );

    await flushAsync();

    const spawnArgs = mockSpawnCli.mock.calls[0]?.[1] as string[];
    expect(spawnArgs).toEqual(
      expect.arrayContaining(['--settings', '{"codex":{"forced_login_method":"chatgpt"}}'])
    );

    proc.emit('close', 0);
    await resultPromise;
  });

  it('rejects on process error event', async () => {
    const proc = createMockProcess();
    mockSpawnCli.mockReturnValue(proc);

    const executor = new ScheduledTaskExecutor();
    const resultPromise = executor.execute(makeRequest());

    await flushAsync();

    proc.emit('error', new Error('ENOENT'));

    await expect(resultPromise).rejects.toThrow('ENOENT');
  });

  it('throws when binary not found', async () => {
    mockResolve.mockResolvedValue(null);

    const executor = new ScheduledTaskExecutor();
    await expect(executor.execute(makeRequest())).rejects.toThrow('Claude CLI binary not found');
  });

  // --- Output Truncation ---

  it('truncates stdout at 512KB', async () => {
    const proc = createMockProcess();
    mockSpawnCli.mockReturnValue(proc);

    const executor = new ScheduledTaskExecutor();
    const resultPromise = executor.execute(makeRequest());

    await flushAsync();

    // Send 640KB in chunks (exceeds 512KB limit)
    const chunk = Buffer.alloc(64 * 1024, 'A');
    for (let i = 0; i < 10; i++) {
      proc.stdout.emit('data', chunk);
    }
    proc.emit('close', 0);

    const result = await resultPromise;
    // Should be capped around 512KB
    expect(result.stdout.length).toBeLessThanOrEqual(512 * 1024);
    // Should not be empty (captures at least some)
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it('truncates stderr at 16KB', async () => {
    const proc = createMockProcess();
    mockSpawnCli.mockReturnValue(proc);

    const executor = new ScheduledTaskExecutor();
    const resultPromise = executor.execute(makeRequest());

    await flushAsync();

    // Send 32KB in chunks
    const chunk = Buffer.alloc(8 * 1024, 'E');
    for (let i = 0; i < 4; i++) {
      proc.stderr.emit('data', chunk);
    }
    proc.emit('close', 1);

    const result = await resultPromise;
    expect(result.stderr.length).toBeLessThanOrEqual(16_384);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('truncates summary at 500 chars from stream-json text', async () => {
    const proc = createMockProcess();
    mockSpawnCli.mockReturnValue(proc);

    const executor = new ScheduledTaskExecutor();
    const resultPromise = executor.execute(makeRequest());

    await flushAsync();

    const longText = 'X'.repeat(1000);
    const streamLine = JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: longText }] });
    proc.stdout.emit('data', Buffer.from(streamLine + '\n'));
    proc.emit('close', 0);

    const result = await resultPromise;
    expect(result.summary.length).toBeLessThanOrEqual(500);
    expect(result.summary).toBe(longText.slice(0, 500));
  });

  it('extracts summary from last assistant text block', async () => {
    const proc = createMockProcess();
    mockSpawnCli.mockReturnValue(proc);

    const executor = new ScheduledTaskExecutor();
    const resultPromise = executor.execute(makeRequest());

    await flushAsync();

    const lines = [
      JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'First message' }] }),
      JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'All tests passed.' }] }),
    ].join('\n') + '\n';
    proc.stdout.emit('data', Buffer.from(lines));
    proc.emit('close', 0);

    const result = await resultPromise;
    expect(result.summary).toBe('All tests passed.');
  });

  it('falls back to raw stdout slice when no assistant text blocks', async () => {
    const proc = createMockProcess();
    mockSpawnCli.mockReturnValue(proc);

    const executor = new ScheduledTaskExecutor();
    const resultPromise = executor.execute(makeRequest());

    await flushAsync();

    const line = JSON.stringify({ type: 'result', subtype: 'success' }) + '\n';
    proc.stdout.emit('data', Buffer.from(line));
    proc.emit('close', 0);

    const result = await resultPromise;
    // Fallback: first 500 chars of raw stdout (includes the JSON line)
    expect(result.summary).toContain('"type":"result"');
    expect(result.summary.length).toBeLessThanOrEqual(500);
  });

  // --- Argument Building ---

  it('builds basic args with required fields', async () => {
    const proc = createMockProcess();
    mockSpawnCli.mockReturnValue(proc);

    const executor = new ScheduledTaskExecutor();
    void executor.execute(makeRequest());
    await flushAsync();

    const args = mockSpawnCli.mock.calls[0][1] as string[];
    expect(args).toContain('-p');
    expect(args).toContain('Run the tests');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--max-turns');
    expect(args).toContain('50');
    expect(args).toContain('--no-session-persistence');
    // skipPermissions defaults to true (undefined !== false)
    expect(args).toContain('--dangerously-skip-permissions');

    proc.emit('close', 0);
  });

  it('includes --max-budget-usd when specified', async () => {
    const proc = createMockProcess();
    mockSpawnCli.mockReturnValue(proc);

    const executor = new ScheduledTaskExecutor();
    void executor.execute(makeRequest({ maxBudgetUsd: 5.0 }));
    await flushAsync();

    const args = mockSpawnCli.mock.calls[0][1] as string[];
    expect(args).toContain('--max-budget-usd');
    expect(args).toContain('5');

    proc.emit('close', 0);
  });

  it('includes --model when specified', async () => {
    const proc = createMockProcess();
    mockSpawnCli.mockReturnValue(proc);

    const executor = new ScheduledTaskExecutor();
    void executor.execute(makeRequest({
      config: {
        cwd: '/tmp/project',
        prompt: 'do it',
        model: 'claude-sonnet-4-5-20250514',
      },
    }));
    await flushAsync();

    const args = mockSpawnCli.mock.calls[0][1] as string[];
    expect(args).toContain('--model');
    expect(args).toContain('claude-sonnet-4-5-20250514');

    proc.emit('close', 0);
  });

  it('excludes --dangerously-skip-permissions when skipPermissions is false', async () => {
    const proc = createMockProcess();
    mockSpawnCli.mockReturnValue(proc);

    const executor = new ScheduledTaskExecutor();
    void executor.execute(makeRequest({
      config: {
        cwd: '/tmp/project',
        prompt: 'do it',
        skipPermissions: false,
      },
    }));
    await flushAsync();

    const args = mockSpawnCli.mock.calls[0][1] as string[];
    expect(args).not.toContain('--dangerously-skip-permissions');

    proc.emit('close', 0);
  });

  it('includes --allowed-tools and --disallowed-tools when specified', async () => {
    const proc = createMockProcess();
    mockSpawnCli.mockReturnValue(proc);

    const executor = new ScheduledTaskExecutor();
    void executor.execute(makeRequest({
      config: {
        cwd: '/tmp/project',
        prompt: 'do it',
        allowedTools: ['Read', 'Write'],
        disallowedTools: ['Bash'],
      },
    }));
    await flushAsync();

    const args = mockSpawnCli.mock.calls[0][1] as string[];
    expect(args).toContain('--allowed-tools');
    expect(args).toContain('Read,Write');
    expect(args).toContain('--disallowed-tools');
    expect(args).toContain('Bash');

    proc.emit('close', 0);
  });

  // --- Cancellation ---

  it('cancel() kills process and returns true when found', async () => {
    const proc = createMockProcess();
    mockSpawnCli.mockReturnValue(proc);

    const executor = new ScheduledTaskExecutor();
    void executor.execute(makeRequest({ runId: 'run-cancel-test' }));
    await flushAsync();

    expect(executor.activeCount).toBe(1);

    const cancelled = executor.cancel('run-cancel-test');
    expect(cancelled).toBe(true);
    expect(mockKillProcessTree).toHaveBeenCalledWith(proc, 'SIGTERM');
    expect(executor.activeCount).toBe(0);

    // Emit close so the promise settles (prevents unhandled rejection)
    proc.emit('close', null);
  });

  it('cancel() returns false when run not found', () => {
    const executor = new ScheduledTaskExecutor();
    expect(executor.cancel('nonexistent')).toBe(false);
    expect(mockKillProcessTree).not.toHaveBeenCalled();
  });

  it('cancelAll() kills all active processes', async () => {
    const proc1 = createMockProcess();
    const proc2 = createMockProcess();
    mockSpawnCli.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);

    const executor = new ScheduledTaskExecutor();
    void executor.execute(makeRequest({ runId: 'run-1' }));
    void executor.execute(makeRequest({ runId: 'run-2' }));
    await flushAsync();

    expect(executor.activeCount).toBe(2);

    executor.cancelAll();
    expect(mockKillProcessTree).toHaveBeenCalledTimes(2);
    expect(executor.activeCount).toBe(0);

    // Emit close for both
    proc1.emit('close', null);
    proc2.emit('close', null);
  });

  // --- Active Tracking ---

  it('activeCount reflects number of running processes', async () => {
    const proc = createMockProcess();
    mockSpawnCli.mockReturnValue(proc);

    const executor = new ScheduledTaskExecutor();
    expect(executor.activeCount).toBe(0);

    const resultPromise = executor.execute(makeRequest());
    await flushAsync();
    expect(executor.activeCount).toBe(1);

    proc.emit('close', 0);
    await resultPromise;

    expect(executor.activeCount).toBe(0);
  });

  // --- CWD and Environment ---

  it('passes correct cwd and env to spawnCli', async () => {
    const proc = createMockProcess();
    mockSpawnCli.mockReturnValue(proc);
    mockResolveShellEnv.mockResolvedValue({ MY_VAR: 'test' });

    const executor = new ScheduledTaskExecutor();
    void executor.execute(makeRequest({
      config: { cwd: '/home/user/project', prompt: 'test' },
    }));
    await flushAsync();

    const opts = mockSpawnCli.mock.calls[0][2];
    expect(opts.cwd).toBe('/home/user/project');
    expect(opts.env.SHELL).toBe('/bin/zsh');
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);

    proc.emit('close', 0);
  });

  it('strips CLAUDECODE env var to avoid nested session detection', async () => {
    const proc = createMockProcess();
    mockSpawnCli.mockReturnValue(proc);
    mockResolveShellEnv.mockResolvedValue({});

    // Simulate CLAUDECODE being set in parent process
    const originalClaudeCode = process.env.CLAUDECODE;
    process.env.CLAUDECODE = '1';

    try {
      const executor = new ScheduledTaskExecutor();
      void executor.execute(makeRequest());
      await flushAsync();

      const opts = mockSpawnCli.mock.calls[0][2];
      expect(opts.env.CLAUDECODE).toBeUndefined();

      proc.emit('close', 0);
    } finally {
      if (originalClaudeCode === undefined) {
        delete process.env.CLAUDECODE;
      } else {
        process.env.CLAUDECODE = originalClaudeCode;
      }
    }
  });

  it('fails fast when provider-aware env reports a missing API key', async () => {
    buildProviderAwareCliEnvMock.mockResolvedValue({
      env: { SHELL: '/bin/zsh' },
      connectionIssues: {
        anthropic:
          'Anthropic API key mode is enabled, but no ANTHROPIC_API_KEY is configured.',
      },
    });

    const executor = new ScheduledTaskExecutor();

    await expect(executor.execute(makeRequest())).rejects.toThrow('ANTHROPIC_API_KEY');
    expect(mockSpawnCli).not.toHaveBeenCalled();
  });
});
