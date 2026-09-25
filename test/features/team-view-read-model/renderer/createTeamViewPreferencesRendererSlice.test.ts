import {
  createTeamViewPreferencesRendererSlice,
  type TeamMessagesPanelMode,
  type TeamViewPreferencesRendererSlice,
} from '@features/team-view-read-model/renderer';
import { describe, expect, it, vi } from 'vitest';

function createHarness(restoredMode: unknown, persistedLogsHeight: number | null = null) {
  let state = {} as TeamViewPreferencesRendererSlice;
  const order: string[] = [];
  const saveMessagesPanelMode = vi.fn((mode: TeamMessagesPanelMode) => {
    order.push(`persist:${mode}`);
  });
  const saveSidebarLogsHeight = vi.fn((height: number) => {
    order.push(`persist-logs:${height}`);
  });
  const slice = createTeamViewPreferencesRendererSlice<TeamViewPreferencesRendererSlice>({
    persistence: {
      loadMessagesPanelMode: () => restoredMode,
      saveMessagesPanelMode,
      loadSidebarLogsHeight: () => persistedLogsHeight,
      saveSidebarLogsHeight,
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
  return { getState: () => state, order, saveMessagesPanelMode, saveSidebarLogsHeight };
}

describe('createTeamViewPreferencesRendererSlice', () => {
  it('restores a valid panel mode with the log-height default', () => {
    const harness = createHarness('bottom-sheet');
    expect(harness.getState().messagesPanelMode).toBe('bottom-sheet');
    expect(harness.getState().messagesPanelWidth).toBe(340);
    expect(harness.getState().sidebarLogsHeight).toBe(213);
    expect(harness.getState().sidebarLogsHeightCustom).toBe(false);
  });

  it('restores a custom sidebar log height', () => {
    const harness = createHarness('sidebar', 278);
    expect(harness.getState().sidebarLogsHeight).toBe(278);
    expect(harness.getState().sidebarLogsHeightCustom).toBe(true);
    harness.getState().applyDefaultSidebarLogsHeight(300);
    expect(harness.getState().sidebarLogsHeight).toBe(278);
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

  it('applies measured defaults until a manual height is persisted', () => {
    const harness = createHarness('inline');
    harness.getState().applyDefaultSidebarLogsHeight(245);
    expect(harness.getState().sidebarLogsHeight).toBe(245);
    expect(harness.getState().sidebarLogsHeightCustom).toBe(false);
    harness.getState().setMessagesPanelWidth(512);
    harness.getState().setSidebarLogsHeight(280);
    harness.getState().applyDefaultSidebarLogsHeight(300);
    expect(harness.getState().messagesPanelWidth).toBe(512);
    expect(harness.getState().sidebarLogsHeight).toBe(280);
    expect(harness.getState().sidebarLogsHeightCustom).toBe(true);
    expect(harness.saveSidebarLogsHeight).toHaveBeenCalledWith(280);
    expect(harness.order).toEqual(['project', 'project', 'persist-logs:280', 'project', 'project']);
  });
});
