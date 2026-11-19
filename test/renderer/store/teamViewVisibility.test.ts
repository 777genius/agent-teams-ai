import { describe, expect, it, vi } from 'vitest';

import {
  registerVisiblePhysicalTeam,
  subscribeVisiblePhysicalTeamChanges,
} from '../../../src/renderer/store/team/teamViewVisibility';

describe('visible physical team subscriptions', () => {
  it('resynchronizes subscribers on project mount and cleanup, not only pane changes', () => {
    const listener = vi.fn();
    const off = subscribeVisiblePhysicalTeamChanges(listener);
    const disposeA = registerVisiblePhysicalTeam('ptc-a');
    expect(listener).toHaveBeenCalledTimes(1);
    const disposeB = registerVisiblePhysicalTeam('ptc-b');
    expect(listener).toHaveBeenCalledTimes(2);
    disposeA();
    expect(listener).toHaveBeenCalledTimes(3);
    disposeA();
    expect(listener).toHaveBeenCalledTimes(3);
    disposeB();
    expect(listener).toHaveBeenCalledTimes(4);
    off();
    const disposeC = registerVisiblePhysicalTeam('ptc-c');
    expect(listener).toHaveBeenCalledTimes(4);
    disposeC();
  });
});
