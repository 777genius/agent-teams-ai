import {
  ClaudePtyWorkspaceTrustStrategy,
  DefaultWorkspaceTrustCoordinator,
  WorkspaceTrustLockCancelledError,
  WorkspaceTrustLockRegistry,
  WorkspaceTrustLockTimeoutError,
} from '@features/workspace-trust/core/application';
import {
  buildWorkspaceTrustPathCandidates,
  readCodexWorkspaceTrustConfigOverridesFromSettings,
  type WorkspaceTrustDiagnosticStrategyResult,
  type WorkspaceTrustProvider,
  type WorkspaceTrustWorkspace,
} from '@features/workspace-trust/core/domain';
import { describe, expect, it } from 'vitest';

const featureFlags = {
  enabled: true,
  claudePty: true,
  codexArgs: true,
  retry: false,
  fileLock: true,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function workspace(): WorkspaceTrustWorkspace {
  return buildWorkspaceTrustPathCandidates({
    cwd: '/tmp/project',
    realCwd: '/private/tmp/project',
    platform: 'posix',
  })[0];
}

function codexTrustOverrides(args: string[]): string[] {
  const overrides: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--settings' && typeof args[index + 1] === 'string') {
      overrides.push(
        ...readCodexWorkspaceTrustConfigOverridesFromSettings(JSON.parse(args[index + 1]))
      );
    }
  }
  return overrides;
}

class RecordingClaudeStrategy extends ClaudePtyWorkspaceTrustStrategy {
  active = 0;
  maxActive = 0;
  calls = 0;

  override async execute(): Promise<WorkspaceTrustDiagnosticStrategyResult> {
    this.calls += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await sleep(10);
    this.active -= 1;
    return {
      id: 'claude-pty-workspace-trust',
      provider: 'claude',
      status: 'ok',
      workspaceIds: ['workspace'],
    };
  }
}

class ThrowingClaudeStrategy extends ClaudePtyWorkspaceTrustStrategy {
  override async execute(): Promise<WorkspaceTrustDiagnosticStrategyResult> {
    throw new Error('pty unavailable');
  }
}

describe('WorkspaceTrustCoordinator', () => {
  it('plans Codex trust as settings patches instead of direct native -c args', async () => {
    const coordinator = new DefaultWorkspaceTrustCoordinator(new ClaudePtyWorkspaceTrustStrategy());
    const workspaces = buildWorkspaceTrustPathCandidates({
      cwd: '/tmp/project',
      realCwd: '/private/tmp/project',
      platform: 'posix',
    });

    const plan = await coordinator.planFull({
      providers: ['claude', 'codex'],
      workspaces,
      featureFlags,
    });

    expect(plan.launchArgPatches).toHaveLength(4);
    expect(plan.launchArgPatches.every((patch) => patch.targetProvider === 'codex')).toBe(true);
    expect(
      plan.launchArgPatches.every((patch) => patch.dialect === 'claude-codex-runtime-settings')
    ).toBe(true);
    expect(plan.launchArgPatches.flatMap((patch) => patch.args)).not.toContain('-c');
    expect(plan.launchArgPatches[0].args.join(' ')).toContain('agent_teams_workspace_trust');
  });

  it('includes canonical git root overrides in Codex trust settings for worktree candidates', async () => {
    const coordinator = new DefaultWorkspaceTrustCoordinator(new ClaudePtyWorkspaceTrustStrategy());
    const plan = await coordinator.planFull({
      providers: ['codex'],
      workspaces: buildWorkspaceTrustPathCandidates({
        cwd: '/tmp/generated-worktrees/alice',
        realCwd: '/private/tmp/generated-worktrees/alice',
        gitRoot: '/Users/belief/project',
        source: 'member-worktree',
        memberId: 'alice',
        platform: 'posix',
      }),
      featureFlags,
    });

    const overrides = codexTrustOverrides(plan.launchArgPatches[0].args);
    expect(overrides).toEqual(
      expect.arrayContaining([
        'projects."/tmp/generated-worktrees/alice".trust_level="trusted"',
        'projects."/private/tmp/generated-worktrees/alice".trust_level="trusted"',
        'projects."/Users/belief/project".trust_level="trusted"',
      ])
    );
  });

  it('does not emit Codex settings patches for Anthropic-only launches', async () => {
    const coordinator = new DefaultWorkspaceTrustCoordinator(new ClaudePtyWorkspaceTrustStrategy());
    const plan = await coordinator.planArgsOnly({
      providers: ['claude'],
      workspaces: buildWorkspaceTrustPathCandidates({ cwd: '/tmp/project', platform: 'posix' }),
      featureFlags,
    });

    expect(plan.launchArgPatches).toEqual([]);
  });

  it('does not emit Codex workspace-trust patches for OpenCode-only launches', async () => {
    const coordinator = new DefaultWorkspaceTrustCoordinator(new ClaudePtyWorkspaceTrustStrategy());
    const plan = await coordinator.planArgsOnly({
      providers: ['opencode'],
      workspaces: buildWorkspaceTrustPathCandidates({
        cwd: '/tmp/generated-worktrees/alice',
        gitRoot: '/Users/belief/project',
        source: 'member-worktree',
        memberId: 'alice',
        platform: 'posix',
      }),
      featureFlags,
    });

    expect(plan.launchArgPatches).toEqual([]);
  });

  it('limits Codex settings patches to requested target surfaces', async () => {
    const coordinator = new DefaultWorkspaceTrustCoordinator(new ClaudePtyWorkspaceTrustStrategy());
    const plan = await coordinator.planArgsOnly({
      providers: ['anthropic', 'codex'],
      workspaces: buildWorkspaceTrustPathCandidates({ cwd: '/tmp/project', platform: 'posix' }),
      targetSurfaces: ['provider_facts_probe'],
      featureFlags,
    });

    expect(plan.launchArgPatches).toHaveLength(1);
    expect(plan.launchArgPatches[0]).toMatchObject({
      targetProvider: 'codex',
      targetSurface: 'provider_facts_probe',
      dialect: 'claude-codex-runtime-settings',
    });
  });

  it('does not plan Codex patches when Codex arg propagation is disabled', async () => {
    const coordinator = new DefaultWorkspaceTrustCoordinator(new ClaudePtyWorkspaceTrustStrategy());

    await expect(
      coordinator.planFull({
        providers: ['codex'],
        workspaces: buildWorkspaceTrustPathCandidates({ cwd: '/tmp/project', platform: 'posix' }),
        featureFlags: { ...featureFlags, codexArgs: false },
      })
    ).resolves.toMatchObject({ launchArgPatches: [] });
  });

  it('normalizes provider aliases in full workspace trust plans', async () => {
    const coordinator = new DefaultWorkspaceTrustCoordinator(new ClaudePtyWorkspaceTrustStrategy());
    const workspaces = buildWorkspaceTrustPathCandidates({
      cwd: '/tmp/project',
      platform: 'posix',
    });

    const plan = await coordinator.planFull({
      providers: ['anthropic', 'claude', 'codex', 'codex'],
      workspaces,
      featureFlags,
    });

    expect(plan.providers).toEqual(['claude', 'codex']);
  });

  it('does not plan Codex patches or execute Claude PTY when workspace trust is disabled', async () => {
    const strategy = new RecordingClaudeStrategy();
    const coordinator = new DefaultWorkspaceTrustCoordinator(strategy);
    const disabledFlags = {
      ...featureFlags,
      enabled: false,
      claudePty: false,
      codexArgs: false,
    };
    const workspaces = buildWorkspaceTrustPathCandidates({
      cwd: '/tmp/project',
      realCwd: '/private/tmp/project',
      platform: 'posix',
    });

    await expect(
      coordinator.planFull({
        providers: ['claude', 'codex'],
        workspaces,
        featureFlags: disabledFlags,
      })
    ).resolves.toEqual({ providers: ['claude', 'codex'], workspaces, launchArgPatches: [] });

    await expect(
      coordinator.execute({
        providers: ['claude', 'codex'],
        claudePath: '/usr/local/bin/claude',
        workspaces,
        env: {},
        featureFlags: disabledFlags,
        isCancelled: () => false,
      })
    ).resolves.toMatchObject({ status: 'skipped' });
    expect(strategy.calls).toBe(0);
  });

  it('serializes Claude preflights for the same workspace', async () => {
    const strategy = new RecordingClaudeStrategy();
    const coordinator = new DefaultWorkspaceTrustCoordinator(strategy);
    const plan = {
      providers: ['claude' as const],
      claudePath: '/usr/local/bin/claude',
      workspaces: [workspace()],
      env: {},
      featureFlags,
      isCancelled: () => false,
    };

    await Promise.all([coordinator.execute(plan), coordinator.execute(plan)]);

    expect(strategy.calls).toBe(2);
    expect(strategy.maxActive).toBe(1);
  });

  it('returns a soft failure when the Claude strategy throws unexpectedly', async () => {
    const coordinator = new DefaultWorkspaceTrustCoordinator(new ThrowingClaudeStrategy());

    const result = await coordinator.execute({
      providers: ['claude'],
      claudePath: '/usr/local/bin/claude',
      workspaces: [workspace()],
      env: {},
      featureFlags,
      isCancelled: () => false,
    });

    expect(result).toMatchObject({
      status: 'soft_failed',
      errorCode: 'workspace_trust_preflight_error',
      errorMessage: 'pty unavailable',
    });
  });

  it.each([
    {
      label: 'Codex-only',
      providers: ['codex'] satisfies WorkspaceTrustProvider[],
    },
    {
      label: 'Gemini-only',
      providers: ['gemini'] satisfies WorkspaceTrustProvider[],
    },
    {
      label: 'OpenCode-only',
      providers: ['opencode'] satisfies WorkspaceTrustProvider[],
    },
    {
      label: 'Codex and OpenCode',
      providers: ['codex', 'opencode'] satisfies WorkspaceTrustProvider[],
    },
  ])('skips Claude PTY preflight for $label launches', async ({ providers }) => {
    const strategy = new RecordingClaudeStrategy();
    const coordinator = new DefaultWorkspaceTrustCoordinator(strategy);

    const result = await coordinator.execute({
      providers,
      claudePath: '/usr/local/bin/claude',
      workspaces: [workspace()],
      env: {},
      featureFlags,
      isCancelled: () => false,
    });

    expect(result).toMatchObject({
      provider: 'claude',
      status: 'skipped',
      evidence: ['Claude workspace trust preflight not required for selected providers'],
    });
    expect(strategy.calls).toBe(0);
  });

  it('executes Claude PTY preflight when providers include the Anthropic alias', async () => {
    const strategy = new RecordingClaudeStrategy();
    const coordinator = new DefaultWorkspaceTrustCoordinator(strategy);

    const result = await coordinator.execute({
      providers: ['anthropic'],
      claudePath: '/usr/local/bin/claude',
      workspaces: [workspace()],
      env: {},
      featureFlags,
      isCancelled: () => false,
    });

    expect(result).toMatchObject({ status: 'ok' });
    expect(strategy.calls).toBe(1);
  });

  it('times out lock waits without blocking later waiters', async () => {
    const locks = new WorkspaceTrustLockRegistry();
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = locks.withWorkspaceLock(
      'claude:/tmp/project',
      { timeoutMs: 1000, pollIntervalMs: 1, isCancelled: () => false },
      async () => {
        enteredFirst();
        await firstReleased;
      }
    );
    await firstEntered;

    await expect(
      locks.withWorkspaceLock(
        'claude:/tmp/project',
        { timeoutMs: 5, pollIntervalMs: 1, isCancelled: () => false },
        async () => undefined
      )
    ).rejects.toBeInstanceOf(WorkspaceTrustLockTimeoutError);

    releaseFirst();
    await first;
    await expect(
      locks.withWorkspaceLock(
        'claude:/tmp/project',
        { timeoutMs: 50, pollIntervalMs: 1, isCancelled: () => false },
        async () => 'ok'
      )
    ).resolves.toBe('ok');
  });

  it('cancels lock waits without running the protected section', async () => {
    const locks = new WorkspaceTrustLockRegistry();
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = locks.withWorkspaceLock(
      'claude:/tmp/project',
      { timeoutMs: 1000, pollIntervalMs: 1, isCancelled: () => false },
      async () => {
        enteredFirst();
        await firstReleased;
      }
    );
    await firstEntered;
    const protectedSection = async () => 'should-not-run';

    await expect(
      locks.withWorkspaceLock(
        'claude:/tmp/project',
        { timeoutMs: 1000, pollIntervalMs: 1, isCancelled: () => true },
        protectedSection
      )
    ).rejects.toBeInstanceOf(WorkspaceTrustLockCancelledError);

    releaseFirst();
    await first;
  });
});
