import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearAllTeamLocalStateEpochs,
  invalidateTeamLocalStateEpoch,
} from '../../../src/renderer/store/team/teamLocalStateEpoch';
import { TeamStateLifecycleCoordinator } from '../../../src/renderer/store/team/TeamStateLifecycleCoordinator';
import {
  invalidateContextScopedRequestEpoch,
  resetContextScopedRequestEpochForTests,
} from '../../../src/renderer/store/utils/contextScopedRequestEpoch';

describe('TeamStateLifecycleCoordinator request scopes', () => {
  beforeEach(() => {
    clearAllTeamLocalStateEpochs();
    resetContextScopedRequestEpochForTests();
  });

  it('rejects context scopes after navigation or a context epoch invalidation', () => {
    const coordinator = new TeamStateLifecycleCoordinator({ reset: vi.fn() });
    const state = { activeContextId: 'context-a' };
    const getState = () => state;
    const scope = coordinator.captureContextRequestScope(getState);

    expect(coordinator.isContextRequestScopeCurrent(getState, scope)).toBe(true);
    state.activeContextId = 'context-b';
    expect(coordinator.isContextRequestScopeCurrent(getState, scope)).toBe(false);

    state.activeContextId = 'context-a';
    invalidateContextScopedRequestEpoch();
    expect(coordinator.isContextRequestScopeCurrent(getState, scope)).toBe(false);
  });

  it('invalidates only the changed team scope', () => {
    const coordinator = new TeamStateLifecycleCoordinator({ reset: vi.fn() });
    const getState = () => ({ activeContextId: 'context-a' });
    const teamAScope = coordinator.captureTeamRequestScope(getState, 'team-a');
    const teamBScope = coordinator.captureTeamRequestScope(getState, 'team-b');

    invalidateTeamLocalStateEpoch('team-a');

    expect(coordinator.isTeamRequestScopeCurrent(getState, 'team-a', teamAScope)).toBe(false);
    expect(coordinator.isTeamRequestScopeCurrent(getState, 'team-b', teamBScope)).toBe(true);
  });
});
