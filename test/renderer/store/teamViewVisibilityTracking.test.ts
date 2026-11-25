// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  track: vi.fn(async (_name: string, _enabled: boolean) => undefined),
}));

vi.mock('@renderer/api', () => ({
  api: { teams: { setTaskLogStreamTracking: state.track } },
}));

import { startTaskLogStreamTracking } from '../../../src/renderer/store/team/taskLogStreamTracking';
import { registerVisiblePhysicalTeam } from '../../../src/renderer/store/team/teamViewVisibility';

import type { AppState } from '../../../src/renderer/store/types';

describe('project context visibility → task log stream tracking', () => {
  beforeEach(() => {
    state.track.mockClear();
  });

  it('tracks the newly visible physical project and disables the previous one without pane changes', () => {
    const store = {
      getState: (): AppState => ({
        paneLayout: { panes: [] },
        activeContextId: 'test-context',
        isContextSwitching: false,
        taskDetailVisibleDemandById: {},
      }) as unknown as AppState,
      subscribe: () => () => undefined,
    };
    const disabled = vi.fn();
    const stop = startTaskLogStreamTracking(store, disabled);
    const stopA = registerVisiblePhysicalTeam('ptc-project-a');
    expect(state.track).toHaveBeenCalledWith('ptc-project-a', true);

    const stopB = registerVisiblePhysicalTeam('ptc-project-b');
    stopA();
    expect(state.track).toHaveBeenCalledWith('ptc-project-a', false);
    expect(state.track).toHaveBeenCalledWith('ptc-project-b', true);
    expect(disabled).toHaveBeenCalledWith('ptc-project-a');

    stopB();
    stop();
    const callCount = state.track.mock.calls.length;
    const late = registerVisiblePhysicalTeam('ptc-new');
    expect(state.track).toHaveBeenCalledTimes(callCount);
    late();
  });
});
