import {
  runTeamForceStopAction,
  selectTeamForceStopFailureMessage,
} from '@renderer/components/team/teamForceStopAction';
import { describe, expect, it, vi } from 'vitest';

import type {
  TeamForceStopActionLabels,
  TeamForceStopActionPorts,
} from '@renderer/components/team/teamForceStopAction';

const labels: TeamForceStopActionLabels = {
  confirmTitle: 'Force stop team',
  confirmMessage: 'Force stop "fixteam"?',
  confirmLabel: 'Force stop',
  cancelLabel: 'Cancel',
  failureTitle: 'Force stop failed',
  failureFallbackMessage: 'An unexpected error occurred',
  failureConfirmLabel: 'OK',
};

function createPorts(
  overrides: Partial<TeamForceStopActionPorts> = {}
): TeamForceStopActionPorts & {
  confirm: ReturnType<typeof vi.fn>;
  forceStop: ReturnType<typeof vi.fn>;
  refreshTeamData: ReturnType<typeof vi.fn>;
  setBusy: ReturnType<typeof vi.fn>;
  logError: ReturnType<typeof vi.fn>;
} {
  return {
    teamName: 'fixteam',
    labels,
    confirm: vi.fn(() => Promise.resolve(true)),
    forceStop: vi.fn(() => Promise.resolve(undefined)),
    refreshTeamData: vi.fn(() => Promise.resolve()),
    setBusy: vi.fn(),
    logError: vi.fn(),
    ...overrides,
  } as never;
}

describe('runTeamForceStopAction', () => {
  it('confirms, runs and refreshes, and reports nothing to the user', async () => {
    const ports = createPorts();

    await expect(runTeamForceStopAction(ports)).resolves.toBe('ran');

    expect(ports.confirm).toHaveBeenCalledTimes(1);
    expect(ports.confirm).toHaveBeenCalledWith({
      title: 'Force stop team',
      message: 'Force stop "fixteam"?',
      confirmLabel: 'Force stop',
      cancelLabel: 'Cancel',
      variant: 'danger',
    });
    expect(ports.forceStop).toHaveBeenCalledWith('fixteam');
    expect(ports.refreshTeamData).toHaveBeenCalledWith('fixteam');
    expect(ports.setBusy.mock.calls).toEqual([[true], [false]]);
    expect(ports.logError).not.toHaveBeenCalled();
  });

  it('does nothing at all when the user cancels', async () => {
    const ports = createPorts({ confirm: vi.fn(() => Promise.resolve(false)) });

    await expect(runTeamForceStopAction(ports)).resolves.toBe('cancelled');

    expect(ports.forceStop).not.toHaveBeenCalled();
    // The control must not pulse while the user is still deciding.
    expect(ports.setBusy).not.toHaveBeenCalled();
  });

  it('tells the user when the force stop never ran', async () => {
    const ports = createPorts({
      confirm: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValue(true) as TeamForceStopActionPorts['confirm'],
      forceStop: vi.fn(() =>
        Promise.reject(new Error('Team runtime control is not available in this mode'))
      ),
    });

    await expect(runTeamForceStopAction(ports)).resolves.toBe('failed');

    expect(ports.logError).toHaveBeenCalledTimes(1);
    expect(ports.confirm).toHaveBeenNthCalledWith(2, {
      title: 'Force stop failed',
      message: 'Team runtime control is not available in this mode',
      confirmLabel: 'OK',
      variant: 'danger',
    });
    // The control is released either way, and the view is not refreshed over a
    // run that never happened.
    expect(ports.setBusy.mock.calls).toEqual([[true], [false]]);
    expect(ports.refreshTeamData).not.toHaveBeenCalled();
  });

  it('reports a failing refresh the same way', async () => {
    const ports = createPorts({
      refreshTeamData: vi.fn(() => Promise.reject(new Error('refresh failed'))),
    });

    await expect(runTeamForceStopAction(ports)).resolves.toBe('failed');

    expect(ports.confirm).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ title: 'Force stop failed', message: 'refresh failed' })
    );
  });
});

describe('selectTeamForceStopFailureMessage', () => {
  it('prefers what the error says', () => {
    expect(selectTeamForceStopFailureMessage(new Error('channel missing'), 'fallback')).toBe(
      'channel missing'
    );
    expect(selectTeamForceStopFailureMessage('plain string failure', 'fallback')).toBe(
      'plain string failure'
    );
  });

  it('falls back when the error has nothing readable to say', () => {
    // Negative control for the branch above: an Error whose message is empty or
    // whitespace, a non-error value, and nothing at all must not put a blank
    // dialog in front of the user.
    expect(selectTeamForceStopFailureMessage(new Error(''), 'fallback')).toBe('fallback');
    expect(selectTeamForceStopFailureMessage(new Error('   '), 'fallback')).toBe('fallback');
    expect(selectTeamForceStopFailureMessage({ code: 500 }, 'fallback')).toBe('fallback');
    expect(selectTeamForceStopFailureMessage(undefined, 'fallback')).toBe('fallback');
  });
});
