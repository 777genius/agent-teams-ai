import { getLanguageFromFileName } from '@renderer/utils/codemirrorLanguages';
import { editorBridge } from '@renderer/utils/editorBridge';
import { computeDisambiguatedTabs } from '@renderer/utils/tabLabelDisambiguation';
import { getBasename, normalizePathForComparison } from '@shared/utils/platformPath';

import type { EditorSlice } from '@renderer/store/slices/editorSlice';
import type { AppState } from '@renderer/store/types';
import type { EditorFileTab } from '@shared/types/editor';
import type { StoreApi } from 'zustand';

/** Remove a key from a record. Returns the same reference if key doesn't exist. */
export function omitKey<V>(record: Record<string, V>, key: string): Record<string, V> {
  if (!(key in record)) return record;
  const result = { ...record };
  delete result[key];
  return result;
}

export function createEditorTabActions(
  set: StoreApi<AppState>['setState'],
  get: () => AppState,
  scheduleWatch: () => void
) {
  return {
    openFile: (filePath: string) => {
      const { editorOpenTabs } = get();

      // Dedup: if file already open, just activate it
      const existing = editorOpenTabs.find(
        (t) => normalizePathForComparison(t.filePath) === normalizePathForComparison(filePath)
      );
      if (existing) {
        set({ editorActiveTabId: existing.id });
        return;
      }

      const fileName = getBasename(filePath) || 'file';
      const language = getLanguageFromFileName(fileName);

      const tab: EditorFileTab = {
        id: filePath,
        filePath,
        fileName,
        language,
      };

      const newTabs = computeDisambiguatedTabs([...editorOpenTabs, tab]);

      set({
        editorOpenTabs: newTabs,
        editorActiveTabId: tab.id,
      });

      scheduleWatch();
    },

    closeEditorTab: (tabId: string) => {
      const { editorOpenTabs, editorActiveTabId, editorModifiedFiles, editorSaveError } = get();
      const filtered = editorOpenTabs.filter((t) => t.id !== tabId);

      // Clean up dirty/error state for closed tab
      const restModified = omitKey(editorModifiedFiles, tabId);
      const restErrors = omitKey(editorSaveError, tabId);

      // Clear cached EditorState from bridge
      editorBridge.deleteState(tabId);

      // Clear draft from localStorage
      try {
        localStorage.removeItem(`editor-draft:${tabId}`);
      } catch {
        // localStorage may not be available
      }

      let newActiveId = editorActiveTabId;
      if (editorActiveTabId === tabId) {
        // Activate adjacent tab
        const closedIndex = editorOpenTabs.findIndex((t) => t.id === tabId);
        if (filtered.length > 0) {
          newActiveId = filtered[Math.min(closedIndex, filtered.length - 1)].id;
        } else {
          newActiveId = null;
        }
      }

      // Recompute disambiguation after removing tab
      const disambiguated = computeDisambiguatedTabs(filtered);

      set({
        editorOpenTabs: disambiguated,
        editorActiveTabId: newActiveId,
        editorModifiedFiles: restModified,
        editorSaveError: restErrors,
        editorSaving: omitKey(get().editorSaving, tabId),
      });

      scheduleWatch();
    },

    closeOtherEditorTabs: (keepTabId: string) => {
      const { editorOpenTabs } = get();
      const toClose = editorOpenTabs.filter((t) => t.id !== keepTabId);
      for (const tab of toClose) get().closeEditorTab(tab.id);
    },

    closeEditorTabsToLeft: (tabId: string) => {
      const { editorOpenTabs } = get();
      const idx = editorOpenTabs.findIndex((t) => t.id === tabId);
      if (idx <= 0) return;
      const toClose = editorOpenTabs.slice(0, idx);
      for (const tab of toClose) get().closeEditorTab(tab.id);
    },

    closeEditorTabsToRight: (tabId: string) => {
      const { editorOpenTabs } = get();
      const idx = editorOpenTabs.findIndex((t) => t.id === tabId);
      if (idx < 0 || idx >= editorOpenTabs.length - 1) return;
      const toClose = editorOpenTabs.slice(idx + 1);
      for (const tab of toClose) get().closeEditorTab(tab.id);
    },

    closeAllEditorTabs: () => {
      const { editorOpenTabs } = get();
      for (const tab of [...editorOpenTabs]) get().closeEditorTab(tab.id);
    },

    setActiveEditorTab: (tabId: string) => {
      set({ editorActiveTabId: tabId });
    },

    reorderEditorTabs: (activeId: string, overId: string) => {
      if (activeId === overId) return;
      const { editorOpenTabs } = get();
      const oldIndex = editorOpenTabs.findIndex((t) => t.id === activeId);
      const newIndex = editorOpenTabs.findIndex((t) => t.id === overId);
      if (oldIndex === -1 || newIndex === -1) return;

      const updated = [...editorOpenTabs];
      const [moved] = updated.splice(oldIndex, 1);
      updated.splice(newIndex, 0, moved);
      set({ editorOpenTabs: updated });
    },
  } satisfies Pick<
    EditorSlice,
    | 'openFile'
    | 'closeEditorTab'
    | 'closeOtherEditorTabs'
    | 'closeEditorTabsToLeft'
    | 'closeEditorTabsToRight'
    | 'closeAllEditorTabs'
    | 'setActiveEditorTab'
    | 'reorderEditorTabs'
  >;
}
