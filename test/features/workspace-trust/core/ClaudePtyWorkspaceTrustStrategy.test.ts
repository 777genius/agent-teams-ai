import { ClaudePtyWorkspaceTrustStrategy } from '@features/workspace-trust/core/application';
import { buildWorkspaceTrustPathCandidates } from '@features/workspace-trust/core/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ProviderStateProbe,
  ProviderTrustPersister,
  ProviderTrustPersistResult,
  ProviderTrustState,
  PtyKeyAction,
  PtyProcessPort,
  PtySessionPort,
  PtySpawnInput,
  PtySpawnResult,
  TempEmptyMcpConfigHandle,
  TempEmptyMcpConfigStore,
  TerminalSnapshot,
} from '@features/workspace-trust/core/application';

class FakeSession implements PtySessionPort {
  readonly actions: PtyKeyAction[] = [];
  killed = false;

  constructor(private readonly snapshots: string[]) {}

  async readSnapshot(): Promise<TerminalSnapshot | null> {
    return {
      text: this.snapshots.shift() ?? '',
      capturedAtMs: Date.now(),
    };
  }

  async writeAction(action: PtyKeyAction): Promise<void> {
    this.actions.push(action);
  }

  async kill(): Promise<void> {
    this.killed = true;
  }
}

class FakePtyProcess implements PtyProcessPort {
  readonly spawnInputs: PtySpawnInput[] = [];
  session: FakeSession | null = null;
  spawnResult: PtySpawnResult | null = null;

  async spawn(input: PtySpawnInput): Promise<PtySpawnResult> {
    this.spawnInputs.push(input);
    if (this.spawnResult) {
      return this.spawnResult;
    }
    this.session = new FakeSession(['Quick safety check\nYes, I trust this folder']);
    return { ok: true, session: this.session };
  }
}

class FakeStateProbe implements ProviderStateProbe {
  calls = 0;

  constructor(private readonly states: ProviderTrustState[]) {}

  async readTrustState(): Promise<ProviderTrustState> {
    const state = this.states[Math.min(this.calls, this.states.length - 1)];
    this.calls += 1;
    return state;
  }
}

class FakeTrustPersister implements ProviderTrustPersister {
  readonly workspaces: string[] = [];

  constructor(private readonly result: ProviderTrustPersistResult) {}

  async persistTrustState(): Promise<ProviderTrustPersistResult> {
    this.workspaces.push('workspace');
    return this.result;
  }
}

class FakeTempStore implements TempEmptyMcpConfigStore {
  cleaned = false;

  async create(): Promise<TempEmptyMcpConfigHandle> {
    return {
      path: '/tmp/empty-mcp.json',
      cleanup: async () => {
        this.cleaned = true;
      },
    };
  }
}

function workspace(cwd = '/tmp/project') {
  return buildWorkspaceTrustPathCandidates({ cwd, platform: 'posix' })[0];
}

describe('ClaudePtyWorkspaceTrustStrategy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips PTY when the state probe already reports trusted', async () => {
    const pty = new FakePtyProcess();
    const result = await new ClaudePtyWorkspaceTrustStrategy().execute({
      claudePath: '/usr/local/bin/claude',
      workspaces: [workspace()],
      env: { HOME: '/Users/tester' },
      ptyProcess: pty,
      stateProbe: new FakeStateProbe([{ status: 'trusted', evidence: ['trusted project key'] }]),
      tempEmptyMcpConfigStore: new FakeTempStore(),
      isCancelled: () => false,
    });

    expect(result.status).toBe('ok');
    expect(result.evidence).toEqual(['trusted project key']);
    expect(pty.spawnInputs).toEqual([]);
  });

  it('blocks non-persistable home and root workspaces without spawning PTY', async () => {
    const pty = new FakePtyProcess();
    const homeWorkspace = buildWorkspaceTrustPathCandidates({
      cwd: '/Users/tester',
      homeDir: '/Users/tester',
      platform: 'posix',
    })[0];
    const result = await new ClaudePtyWorkspaceTrustStrategy().execute({
      claudePath: '/usr/local/bin/claude',
      workspaces: [homeWorkspace],
      env: { HOME: '/Users/tester' },
      ptyProcess: pty,
      stateProbe: new FakeStateProbe([{ status: 'untrusted' }]),
      tempEmptyMcpConfigStore: new FakeTempStore(),
      isCancelled: () => false,
    });

    expect(result.status).toBe('blocked');
    expect(result.errorCode).toBe('workspace_trust_not_persistable_home_directory');
    expect(pty.spawnInputs).toEqual([]);
  });

  it('preserves trusted evidence before blocking a later non-persistable workspace', async () => {
    const pty = new FakePtyProcess();
    const trustedWorkspace = workspace('/tmp/project');
    const homeWorkspace = buildWorkspaceTrustPathCandidates({
      cwd: '/Users/tester',
      homeDir: '/Users/tester',
      platform: 'posix',
    })[0];
    const result = await new ClaudePtyWorkspaceTrustStrategy().execute({
      claudePath: '/usr/local/bin/claude',
      workspaces: [trustedWorkspace, homeWorkspace],
      env: { HOME: '/Users/tester' },
      ptyProcess: pty,
      stateProbe: new FakeStateProbe([{ status: 'trusted', evidence: ['trusted project key'] }]),
      tempEmptyMcpConfigStore: new FakeTempStore(),
      isCancelled: () => false,
    });

    expect(result.status).toBe('blocked');
    expect(result.workspaceIds).toEqual([trustedWorkspace.id, homeWorkspace.id]);
    expect(result.evidence).toEqual([
      'trusted project key',
      `${homeWorkspace.id}:workspace_trust_not_persistable_home_directory`,
    ]);
    expect(pty.spawnInputs).toEqual([]);
  });

  it('cancels before probing or spawning when launch cancellation is already requested', async () => {
    const pty = new FakePtyProcess();
    const stateProbe = new FakeStateProbe([{ status: 'untrusted' }]);
    const targetWorkspace = workspace();
    const result = await new ClaudePtyWorkspaceTrustStrategy().execute({
      claudePath: '/usr/local/bin/claude',
      workspaces: [targetWorkspace],
      env: { HOME: '/Users/tester' },
      ptyProcess: pty,
      stateProbe,
      tempEmptyMcpConfigStore: new FakeTempStore(),
      isCancelled: () => true,
    });

    expect(result.status).toBe('cancelled');
    expect(result.workspaceIds).toEqual([targetWorkspace.id]);
    expect(stateProbe.calls).toBe(0);
    expect(pty.spawnInputs).toEqual([]);
  });

  it('accepts the trust dialog, verifies persisted trust, kills PTY, and cleans temp MCP config', async () => {
    const pty = new FakePtyProcess();
    const tempStore = new FakeTempStore();
    const stateProbe = new FakeStateProbe([
      { status: 'untrusted' },
      { status: 'untrusted' },
      { status: 'trusted', evidence: ['trusted project key: /tmp/project'] },
    ]);
    const result = await new ClaudePtyWorkspaceTrustStrategy().execute({
      claudePath: '/usr/local/bin/claude',
      workspaces: [workspace()],
      env: { HOME: '/Users/tester', PATH: '/usr/local/bin', OPTIONAL_EMPTY: undefined },
      ptyProcess: pty,
      stateProbe,
      tempEmptyMcpConfigStore: tempStore,
      isCancelled: () => false,
      timeoutMs: 100,
      pollIntervalMs: 1,
    });

    expect(result.status).toBe('ok');
    expect(result.matchedRuleIds).toEqual(['claude.workspace_trust']);
    expect(result.actions).toEqual(['claude.workspace_trust:enter']);
    expect(result.evidence).toEqual(['trusted project key: /tmp/project']);
    expect(pty.spawnInputs[0]).toMatchObject({
      command: '/usr/local/bin/claude',
      cwd: '/tmp/project',
    });
    expect(pty.spawnInputs[0].args).toContain('--strict-mcp-config');
    expect(pty.spawnInputs[0].env).toMatchObject({
      HOME: '/Users/tester',
      PATH: '/usr/local/bin',
    });
    expect(pty.spawnInputs[0].env.OPTIONAL_EMPTY).toBeUndefined();
    expect(pty.session?.actions.map((action) => action.id)).toEqual(['enter']);
    expect(pty.session?.killed).toBe(true);
    expect(tempStore.cleaned).toBe(true);
    expect(stateProbe.calls).toBe(4);
  });

  it('persists Claude trust directly and skips PTY when verification succeeds', async () => {
    const pty = new FakePtyProcess();
    const trustPersister = new FakeTrustPersister({
      ok: true,
      evidence: ['persisted trusted project key: /tmp/project'],
    });
    const result = await new ClaudePtyWorkspaceTrustStrategy().execute({
      claudePath: '/usr/local/bin/claude',
      workspaces: [workspace()],
      env: { HOME: '/Users/tester' },
      ptyProcess: pty,
      stateProbe: new FakeStateProbe([
        { status: 'untrusted' },
        { status: 'trusted', evidence: ['trusted project key: /tmp/project'] },
      ]),
      trustPersister,
      tempEmptyMcpConfigStore: new FakeTempStore(),
      isCancelled: () => false,
    });

    expect(result.status).toBe('ok');
    expect(result.evidence).toEqual([
      'persisted trusted project key: /tmp/project',
      'trusted project key: /tmp/project',
    ]);
    expect(trustPersister.workspaces).toEqual(['workspace']);
    expect(pty.spawnInputs).toEqual([]);
  });

  it('can confirm trust through direct persistence without PTY ports', async () => {
    const result = await new ClaudePtyWorkspaceTrustStrategy().execute({
      claudePath: '/usr/local/bin/claude',
      workspaces: [workspace()],
      env: { HOME: '/Users/tester' },
      stateProbe: new FakeStateProbe([
        { status: 'untrusted' },
        { status: 'trusted', evidence: ['trusted project key: /tmp/project'] },
      ]),
      trustPersister: new FakeTrustPersister({
        ok: true,
        evidence: ['persisted trusted project key: /tmp/project'],
      }),
      isCancelled: () => false,
    });

    expect(result.status).toBe('ok');
    expect(result.evidence).toContain('trusted project key: /tmp/project');
  });

  it('falls back to PTY when direct trust persistence cannot update Claude state', async () => {
    const pty = new FakePtyProcess();
    const stateProbe = new FakeStateProbe([
      { status: 'untrusted' },
      { status: 'untrusted' },
      { status: 'trusted', evidence: ['trusted project key: /tmp/project'] },
    ]);
    const result = await new ClaudePtyWorkspaceTrustStrategy().execute({
      claudePath: '/usr/local/bin/claude',
      workspaces: [workspace()],
      env: { HOME: '/Users/tester' },
      ptyProcess: pty,
      stateProbe,
      trustPersister: new FakeTrustPersister({
        ok: false,
        code: 'claude_state_write_failed',
        message: 'write failed',
      }),
      tempEmptyMcpConfigStore: new FakeTempStore(),
      isCancelled: () => false,
      timeoutMs: 100,
      pollIntervalMs: 1,
    });

    expect(result.status).toBe('ok');
    expect(result.evidence).toContain('write failed');
    expect(result.evidence).toContain('trusted project key: /tmp/project');
    expect(pty.spawnInputs).toHaveLength(1);
  });

  it('keeps the default Claude preflight alive long enough for slow startup trust prompts', async () => {
    const pty = new FakePtyProcess();
    const session = new FakeSession(['Starting Claude...', 'Quick safety check\nYes, I trust this folder']);
    pty.spawnResult = { ok: true, session };
    const nowValues = [0, 0, 0, 0, 46_000, 46_000, 46_000];
    vi.spyOn(Date, 'now').mockImplementation(() => nowValues.shift() ?? 46_000);

    const result = await new ClaudePtyWorkspaceTrustStrategy().execute({
      claudePath: '/usr/local/bin/claude',
      workspaces: [workspace()],
      env: { HOME: '/Users/tester' },
      ptyProcess: pty,
      stateProbe: new FakeStateProbe([
        { status: 'untrusted' },
        { status: 'trusted', evidence: ['trusted project key: /tmp/project'] },
      ]),
      tempEmptyMcpConfigStore: new FakeTempStore(),
      isCancelled: () => false,
      pollIntervalMs: 1,
    });

    expect(result.status).toBe('ok');
    expect(result.matchedRuleIds).toEqual(['claude.workspace_trust']);
    expect(session.actions.map((action) => action.id)).toEqual(['enter']);
  });

  it('soft-fails when node-pty is unavailable instead of throwing', async () => {
    const pty = new FakePtyProcess();
    pty.spawnResult = {
      ok: false,
      code: 'node_pty_unavailable',
      message: 'node-pty unavailable',
    };
    const result = await new ClaudePtyWorkspaceTrustStrategy().execute({
      claudePath: '/usr/local/bin/claude',
      workspaces: [workspace()],
      env: { HOME: '/Users/tester' },
      ptyProcess: pty,
      stateProbe: new FakeStateProbe([{ status: 'untrusted' }]),
      tempEmptyMcpConfigStore: new FakeTempStore(),
      isCancelled: () => false,
    });

    expect(result.status).toBe('soft_failed');
    expect(result.errorCode).toBe('node_pty_unavailable');
  });

  it('soft-fails provider auth prompts instead of blocking the launch', async () => {
    const pty = new FakePtyProcess();
    const session = new FakeSession(['Log in to Claude']);
    pty.spawnResult = { ok: true, session };
    const result = await new ClaudePtyWorkspaceTrustStrategy().execute({
      claudePath: '/usr/local/bin/claude',
      workspaces: [workspace()],
      env: { HOME: '/Users/tester' },
      ptyProcess: pty,
      stateProbe: new FakeStateProbe([{ status: 'untrusted' }]),
      tempEmptyMcpConfigStore: new FakeTempStore(),
      isCancelled: () => false,
      timeoutMs: 100,
      pollIntervalMs: 1,
    });

    expect(result.status).toBe('soft_failed');
    expect(result.errorCode).toBe('provider_auth_required');
    expect(result.errorMessage).toBe('provider auth required prompt');
    expect(result.evidence).toContain('provider auth required prompt');
    expect(session.actions).toEqual([]);
    expect(session.killed).toBe(true);
  });

  it('includes the last unknown terminal snapshot when preflight times out', async () => {
    const pty = new FakePtyProcess();
    const session = new FakeSession([
      '\u001b[31mUnexpected Claude startup screen\u001b[0m',
      '',
      '',
    ]);
    pty.spawnResult = { ok: true, session };
    const result = await new ClaudePtyWorkspaceTrustStrategy().execute({
      claudePath: '/usr/local/bin/claude',
      workspaces: [workspace()],
      env: { HOME: '/Users/tester' },
      ptyProcess: pty,
      stateProbe: new FakeStateProbe([{ status: 'untrusted' }]),
      tempEmptyMcpConfigStore: new FakeTempStore(),
      isCancelled: () => false,
      timeoutMs: 20,
      pollIntervalMs: 1,
    });

    expect(result.status).toBe('soft_failed');
    expect(result.errorCode).toBe('workspace_trust_preflight_timeout');
    expect(result.rawTail).toBe('Unexpected Claude startup screen');
    expect(session.actions).toEqual([]);
    expect(session.killed).toBe(true);
  });
});
