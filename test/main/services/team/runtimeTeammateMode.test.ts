import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockIsTmuxRuntimeReadyForCurrentPlatform = vi.fn<() => Promise<boolean>>();

vi.mock('@features/tmux-installer/main', () => ({
  isTmuxRuntimeReadyForCurrentPlatform: mockIsTmuxRuntimeReadyForCurrentPlatform,
}));

describe('runtimeTeammateMode', () => {
  const originalTeamMateModeEnv = process.env.CLAUDE_TEAM_TEAMMATE_MODE;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    if (originalTeamMateModeEnv === undefined) {
      delete process.env.CLAUDE_TEAM_TEAMMATE_MODE;
    } else {
      process.env.CLAUDE_TEAM_TEAMMATE_MODE = originalTeamMateModeEnv;
    }
  });

  it('does not inject tmux mode in default desktop launch when tmux runtime is ready', async () => {
    mockIsTmuxRuntimeReadyForCurrentPlatform.mockResolvedValue(true);
    const { resolveDesktopTeammateModeDecision } =
      await import('@main/services/team/runtimeTeammateMode');

    const decision = await resolveDesktopTeammateModeDecision(undefined);

    expect(decision.forceProcessTeammates).toBe(true);
    expect(decision.injectedTeammateMode).toBeNull();
  });

  it('uses native process teammates when tmux runtime is not ready', async () => {
    mockIsTmuxRuntimeReadyForCurrentPlatform.mockResolvedValue(false);
    const { resolveDesktopTeammateModeDecision } =
      await import('@main/services/team/runtimeTeammateMode');

    const decision = await resolveDesktopTeammateModeDecision(undefined);

    expect(decision.forceProcessTeammates).toBe(true);
    expect(decision.injectedTeammateMode).toBeNull();
  });

  it('honors explicit tmux mode as a debug opt-out from process teammates', async () => {
    mockIsTmuxRuntimeReadyForCurrentPlatform.mockResolvedValue(true);
    const { resolveDesktopTeammateModeDecision } =
      await import('@main/services/team/runtimeTeammateMode');

    const decision = await resolveDesktopTeammateModeDecision('--teammate-mode tmux');
    const equalsDecision = await resolveDesktopTeammateModeDecision('--teammate-mode=tmux');

    expect(decision.forceProcessTeammates).toBe(false);
    expect(decision.injectedTeammateMode).toBe('tmux');
    expect(equalsDecision.forceProcessTeammates).toBe(false);
    expect(equalsDecision.injectedTeammateMode).toBe('tmux');
    expect(mockIsTmuxRuntimeReadyForCurrentPlatform).not.toHaveBeenCalled();
  });

  it('treats explicit auto mode as automatic process teammate selection without injection', async () => {
    mockIsTmuxRuntimeReadyForCurrentPlatform.mockResolvedValue(true);
    const { resolveDesktopTeammateModeDecision } =
      await import('@main/services/team/runtimeTeammateMode');

    const decision = await resolveDesktopTeammateModeDecision('--teammate-mode auto');
    const equalsDecision = await resolveDesktopTeammateModeDecision('--teammate-mode=auto');

    expect(decision.forceProcessTeammates).toBe(true);
    expect(decision.injectedTeammateMode).toBeNull();
    expect(equalsDecision.forceProcessTeammates).toBe(true);
    expect(equalsDecision.injectedTeammateMode).toBeNull();
    expect(mockIsTmuxRuntimeReadyForCurrentPlatform).not.toHaveBeenCalled();
  });

  it('honors CLAUDE_TEAM_TEAMMATE_MODE=tmux for desktop debug launches', async () => {
    mockIsTmuxRuntimeReadyForCurrentPlatform.mockResolvedValue(true);
    process.env.CLAUDE_TEAM_TEAMMATE_MODE = 'tmux';
    const { resolveDesktopTeammateModeDecision } =
      await import('@main/services/team/runtimeTeammateMode');

    const decision = await resolveDesktopTeammateModeDecision(undefined);

    expect(decision.forceProcessTeammates).toBe(false);
    expect(decision.injectedTeammateMode).toBe('tmux');
    expect(mockIsTmuxRuntimeReadyForCurrentPlatform).not.toHaveBeenCalled();
  });

  it('lets explicit teammate mode args override CLAUDE_TEAM_TEAMMATE_MODE', async () => {
    mockIsTmuxRuntimeReadyForCurrentPlatform.mockResolvedValue(true);
    process.env.CLAUDE_TEAM_TEAMMATE_MODE = 'tmux';
    const { resolveDesktopTeammateModeDecision } =
      await import('@main/services/team/runtimeTeammateMode');

    const decision = await resolveDesktopTeammateModeDecision('--teammate-mode=in-process');

    expect(decision.forceProcessTeammates).toBe(false);
    expect(decision.injectedTeammateMode).toBeNull();
    expect(mockIsTmuxRuntimeReadyForCurrentPlatform).not.toHaveBeenCalled();
  });

  it('ignores unsupported CLAUDE_TEAM_TEAMMATE_MODE values', async () => {
    mockIsTmuxRuntimeReadyForCurrentPlatform.mockResolvedValue(true);
    process.env.CLAUDE_TEAM_TEAMMATE_MODE = 'pane';
    const { resolveDesktopTeammateModeDecision } =
      await import('@main/services/team/runtimeTeammateMode');

    const decision = await resolveDesktopTeammateModeDecision(undefined);

    expect(decision.forceProcessTeammates).toBe(true);
    expect(decision.injectedTeammateMode).toBeNull();
    expect(mockIsTmuxRuntimeReadyForCurrentPlatform).toHaveBeenCalledTimes(1);
  });

  it('honors explicit in-process mode as an opt-out from process teammates', async () => {
    mockIsTmuxRuntimeReadyForCurrentPlatform.mockResolvedValue(true);
    const { resolveDesktopTeammateModeDecision } =
      await import('@main/services/team/runtimeTeammateMode');

    const decision = await resolveDesktopTeammateModeDecision('--teammate-mode=in-process');

    expect(decision.forceProcessTeammates).toBe(false);
    expect(decision.injectedTeammateMode).toBeNull();
    expect(mockIsTmuxRuntimeReadyForCurrentPlatform).not.toHaveBeenCalled();
  });

  it('removes inherited process fallback env when explicit in-process mode opts out', async () => {
    const { applyDesktopTeammateModeDecisionToEnv } =
      await import('@main/services/team/runtimeTeammateMode');
    const env = {
      CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES: '1',
    };

    applyDesktopTeammateModeDecisionToEnv(env, { forceProcessTeammates: false });

    expect(env).not.toHaveProperty('CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES');
  });

  it('builds injected teammate mode cli args only when a mode was selected', async () => {
    const { buildDesktopTeammateModeCliArgs } =
      await import('@main/services/team/runtimeTeammateMode');

    expect(buildDesktopTeammateModeCliArgs({ injectedTeammateMode: 'tmux' })).toEqual([
      '--teammate-mode',
      'tmux',
    ]);
    expect(buildDesktopTeammateModeCliArgs({ injectedTeammateMode: null })).toEqual([]);
  });

  it('re-checks tmux readiness after the environment changes instead of keeping a stale negative cache', async () => {
    mockIsTmuxRuntimeReadyForCurrentPlatform
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { resolveDesktopTeammateModeDecision } =
      await import('@main/services/team/runtimeTeammateMode');

    const firstDecision = await resolveDesktopTeammateModeDecision(undefined);
    const secondDecision = await resolveDesktopTeammateModeDecision(undefined);

    expect(firstDecision.forceProcessTeammates).toBe(true);
    expect(firstDecision.injectedTeammateMode).toBeNull();
    expect(secondDecision.forceProcessTeammates).toBe(true);
    expect(secondDecision.injectedTeammateMode).toBeNull();
  });
});
