import { describe, expect, it } from 'vitest';

import {
  hasSelectedTargetTeamData,
  shouldKeepGlobalTaskDialogLoading,
} from '../../../../../src/renderer/components/team/dialogs/globalTaskDetailDialogLoading';

describe('shouldKeepGlobalTaskDialogLoading', () => {
  it('treats stale selectedTeamData from another team as not loaded', () => {
    expect(hasSelectedTargetTeamData('alpha', 'alpha', 'beta')).toBe(false);
    expect(hasSelectedTargetTeamData('alpha', 'alpha', 'alpha')).toBe(true);
  });

  it('keeps loading while team switch has not reached the target team yet', () => {
    expect(
      shouldKeepGlobalTaskDialogLoading({
        teamName: 'alpha',
        taskId: 'task-1',
        selectedTeamName: 'beta',
        selectedTeamDataPresent: false,
        selectedTeamLoading: false,
        selectedTeamError: null,
        hasTaskInMap: false,
      })
    ).toBe(true);
  });

  it('keeps loading when team data is not ready yet and the task is still absent', () => {
    expect(
      shouldKeepGlobalTaskDialogLoading({
        teamName: 'alpha',
        taskId: 'task-1',
        selectedTeamName: 'alpha',
        selectedTeamDataPresent: false,
        selectedTeamLoading: false,
        selectedTeamError: null,
        hasTaskInMap: false,
      })
    ).toBe(true);
  });

  it('stops loading once a fallback task snapshot is already available', () => {
    expect(
      shouldKeepGlobalTaskDialogLoading({
        teamName: 'alpha',
        taskId: 'task-1',
        selectedTeamName: 'alpha',
        selectedTeamDataPresent: false,
        selectedTeamLoading: false,
        selectedTeamError: null,
        hasTaskInMap: true,
      })
    ).toBe(false);
  });

  it('stops loading after a real load error', () => {
    expect(
      shouldKeepGlobalTaskDialogLoading({
        teamName: 'alpha',
        taskId: 'task-1',
        selectedTeamName: 'alpha',
        selectedTeamDataPresent: false,
        selectedTeamLoading: false,
        selectedTeamError: 'boom',
        hasTaskInMap: false,
      })
    ).toBe(false);
  });
});
