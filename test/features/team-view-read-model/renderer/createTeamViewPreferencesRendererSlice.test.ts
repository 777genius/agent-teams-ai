import {
  createTeamViewPreferencesRendererSlice,
  type TeamMessagesPanelMode,
  type TeamViewPreferencesRendererSlice,
} from '@features/team-view-read-model/renderer';
import { describe, expect, it, vi } from 'vitest';

function createHarness(restoredMode: unknown) {
  let state = {} as TeamViewPreferencesRendererSlice;
  const order: string[] = [];
  const saveMessagesPanelMode = vi.fn((mode: TeamMessagesPanelMode) => {
    order.push(`persist:${mode}`);
  });
  const slice = createTeamViewPreferencesRendererSlice<TeamViewPreferencesRendererSlice>({
    persistence: {
      loadMessagesPanelMode: () => restoredMode,
      saveMessagesPanelMode,
    },
    state: {
      setState: (update) => {
        order.push('project');
        const patch = typeof update === 'function' ? update(state) : update;
        state = { ...state, ...patch };
      },
    },
  });
  state = { ...state, ...slice };
  return { getState: () => state, order, saveMessagesPanelMode };
}

describe('createTeamViewPreferencesRendererSlice', () => {
  it('restores a valid panel mode with the exact width and log-height defaults', () => {
    const harness = createHarness('bottom-sheet');

    expect(harness.getState().messagesPanelMode).toBe('bottom-sheet');
    expect(harness.getState().messagesPanelWidth).toBe(340);
    expect(harness.getState().sidebarLogsHeight).toBe(213);
  });

  it('falls back to sidebar for invalid persisted modes', () => {
    expect(createHarness('not-a-mode').getState().messagesPanelMode).toBe('sidebar');
    expect(createHarness(null).getState().messagesPanelMode).toBe('sidebar');
  });

  it('persists a mode before projecting it into renderer state', () => {
    const harness = createHarness('sidebar');

    harness.getState().setMessagesPanelMode('floating-composer');

    expect(harness.order).toEqual(['persist:floating-composer', 'project']);
    expect(harness.getState().messagesPanelMode).toBe('floating-composer');
    expect(harness.saveMessagesPanelMode).toHaveBeenCalledWith('floating-composer');
  });

  it('keeps panel width and sidebar log height in memory only', () => {
    const harness = createHarness('inline');

    harness.getState().setMessagesPanelWidth(512);
    harness.getState().setSidebarLogsHeight(280);

    expect(harness.getState().messagesPanelWidth).toBe(512);
    expect(harness.getState().sidebarLogsHeight).toBe(280);
    expect(harness.saveMessagesPanelMode).not.toHaveBeenCalled();
    expect(harness.order).toEqual(['project', 'project']);
  });
});
