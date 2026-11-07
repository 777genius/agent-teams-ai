import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestStore } from './storeTestUtils';

describe('Teams in-tab creation navigation', () => {
  beforeEach(() => {
    let next = 0;
    vi.stubGlobal('crypto', { randomUUID: () => `teams-create-${++next}` });
  });

  it('opens inside an existing Teams tab without duplicating it', () => {
    const store = createTestStore();
    store.getState().openTeamsTab();
    const originalTabId = store.getState().getActiveTab()?.id;
    store.getState().openTeamsCreationPage();
    const editor = store.getState().getActiveTab();
    expect(editor?.id).toBe(originalTabId);
    expect(editor).toMatchObject({ type: 'teams', teamsCreationPage: true });
    expect(store.getState().getAllPaneTabs()).toHaveLength(1);

    store.getState().closeTeamsCreationPage(editor!.id);
    expect(store.getState().getActiveTab()).toMatchObject({
      type: 'teams',
      teamsCreationPage: false,
    });
    expect(store.getState().getAllPaneTabs()).toHaveLength(1);
  });

  it('focuses the existing creation editor even when another pane is active', () => {
    const store = createTestStore();
    store.getState().openTeamsCreationPage();
    const editorId = store.getState().getActiveTab()!.id;
    const sourcePaneId = store.getState().paneLayout.focusedPaneId;

    store.getState().openTab({ type: 'settings', label: 'Settings' });
    const settingsId = store.getState().getActiveTab()!.id;
    store.getState().splitPane(sourcePaneId, settingsId, 'right');
    expect(store.getState().paneLayout.panes).toHaveLength(2);

    store.getState().openTeamsCreationPage();
    expect(store.getState().getActiveTab()?.id).toBe(editorId);
    expect(
      store.getState().getAllPaneTabs().filter((tab) => tab.teamsCreationPage === true)
    ).toHaveLength(1);
  });

  it('does not replace an existing editor seed without explicit replacement', () => {
    const store = createTestStore();
    store.getState().openTeamsCreationPage({
      copyData: { teamName: 'copy-one', members: [] },
    });
    const first = store.getState().getActiveTab();
    const originalSeedId = first?.teamsCreationSeed?.id;
    expect(first?.teamsCreationSeed?.copyData?.teamName).toBe('copy-one');

    store.getState().openTeamsCreationPage({
      copyData: { teamName: 'copy-two', members: [] },
    });
    expect(store.getState().getActiveTab()?.teamsCreationSeed?.id).toBe(originalSeedId);

    store.getState().openTeamsCreationPage(
      { copyData: { teamName: 'copy-two', members: [] } },
      true
    );
    expect(store.getState().getActiveTab()?.teamsCreationSeed?.copyData?.teamName).toBe('copy-two');
    expect(store.getState().getActiveTab()?.teamsCreationSeed?.id).not.toBe(originalSeedId);
  });
});
