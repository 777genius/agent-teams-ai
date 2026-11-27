import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutonomousGoalStatus } from '@features/agent-backend/contracts';

const harness = vi.hoisted(() => ({
  invoke: vi.fn(),
  refresh: vi.fn(),
  state: {
    activeContextId: 'TEST-context',
    isContextSwitching: false,
    selectedTeamName: 'host-team:TEST-handle',
    selectedTeamError: null as string | null,
  },
}));
vi.mock('@renderer/api', () => ({ api: { agentBackend: { invoke: harness.invoke } } }));
vi.mock('@features/agent-backend/renderer', async () => ({
  controlAutonomousGoal: (await import('@features/agent-backend/renderer/controlAutonomousGoal')).controlAutonomousGoal,
}));
vi.mock('@renderer/store', () => ({
  useStore: { getState: () => ({ ...harness.state, refreshTeamData: harness.refresh }) },
}));

import { AutonomousGoalStatusNotice } from './ContinueUntilDoneControl';

const goal: AutonomousGoalStatus = {
  goalId: 'TEST-goal',
  revision: 3,
  disposition: 'active',
  startedAt: '2026-11-27T08:00:00.000Z',
  deadlineAt: '2026-11-27T20:00:00.000Z',
  attemptLimit: 100,
  attemptsUsed: 4,
};

function render() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(<AutonomousGoalStatusNotice teamName="host-team:TEST-handle" goal={goal} />)
  );
  return { host, root };
}
function button(host: HTMLElement, text: string) {
  const found = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === text
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

describe('original continuation controls', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    harness.state.selectedTeamName = 'host-team:TEST-handle';
    harness.state.selectedTeamError = null;
    harness.state.isContextSwitching = false;
    harness.invoke
      .mockReset()
      .mockResolvedValue({ ok: true, value: { ...goal, disposition: 'stopped' } });
    harness.refresh.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('checks the same original control after a lost reply without creating another command', async () => {
    harness.invoke.mockRejectedValueOnce(new Error('Lost reply'));
    const { host, root } = render();
    try {
      await act(async () => button(host, 'Stop continuation').click());
      expect(harness.invoke).toHaveBeenCalledTimes(1);
      expect(button(host, 'Stop continuation').disabled).toBe(true);
      expect(host.textContent).toContain('The change is not confirmed');
      await act(async () => button(host, 'Check original request').click());
      expect(harness.invoke).toHaveBeenCalledTimes(2);
      expect(harness.invoke.mock.calls[1]).toEqual(harness.invoke.mock.calls[0]);
      expect(harness.invoke.mock.calls[0]?.[0]).toMatchObject({
        handle: { handleId: 'TEST-handle' },
        operation: 'goal.control',
        payload: { goalId: 'TEST-goal', expectedRevision: 3, action: 'stop' },
      });
      expect(harness.refresh).toHaveBeenCalledTimes(1);
      expect(host.querySelector('[role="alert"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('keeps an applied change distinct from a failed status refresh and allows a read-only retry', async () => {
    harness.refresh.mockRejectedValueOnce(new Error('Read unavailable'));
    const { host, root } = render();
    try {
      await act(async () => button(host, 'Stop continuation').click());
      expect(host.textContent).toContain('The change was applied');
      expect(host.textContent).not.toContain('Check original request');
      await act(async () => button(host, 'Refresh status').click());
      expect(harness.invoke).toHaveBeenCalledTimes(1);
      expect(harness.refresh).toHaveBeenCalledTimes(2);
      expect(button(host, 'Stop continuation').disabled).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it('refreshes a known refusal before accepting another explicit change', async () => {
    harness.invoke.mockResolvedValueOnce({ ok: false, code: 'conflict', outcome: 'rejected' });
    const { host, root } = render();
    try {
      await act(async () => button(host, 'Stop continuation').click());
      expect(host.textContent).toContain('The change could not be applied');
      expect(host.textContent).not.toContain('Check original request');
      await act(async () => button(host, 'Refresh status').click());
      expect(harness.invoke).toHaveBeenCalledTimes(1);
      expect(button(host, 'Stop continuation').disabled).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it('does not send a control after the selected team changes', async () => {
    const { host, root } = render();
    try {
      harness.state.selectedTeamName = 'host-team:ANOTHER';
      await act(async () => button(host, 'Stop continuation').click());
      expect(harness.invoke).not.toHaveBeenCalled();
      expect(harness.refresh).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});
