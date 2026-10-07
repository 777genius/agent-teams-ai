import { api } from '@renderer/api';
import { editorBridge } from '@renderer/utils/editorBridge';
import { createLogger } from '@shared/utils/logger';

import type { AppState } from '@renderer/store/types';
import type { EditorSaveSnapshot } from '@renderer/utils/editorBridge';
import type { StateCreator } from 'zustand';

const log = createLogger('EditorSaveActions');
const without = <T>(record: Record<string, T>, key: string): Record<string, T> => {
  const next = { ...record }; delete next[key]; return next;
};

/** A save acknowledges one document identity, never subsequent edits or a new session. */
export function createEditorSaveActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: () => AppState,
  onSaved: (filePath: string) => void
): Pick<AppState, 'saveFile' | 'saveAllFiles' | 'forceOverwrite'> {
  const inFlight = new Map<string, EditorSaveSnapshot>();
  const save = async (filePath: string, force = false): Promise<void> => {
    if (get().editorSaving[filePath]) return;
    const snapshot = editorBridge.captureSave(filePath);
    if (!snapshot) return; // unavailable/readonly documents cannot reach the write bridge
    inFlight.set(filePath, snapshot);
    set((state) => ({
      editorSaving: { ...state.editorSaving, [filePath]: true },
      editorSaveError: without(state.editorSaveError, filePath),
      ...(force ? { editorConflictFile: null } : {}),
    }));
    try {
      const result = await api.editor.writeFile(filePath, snapshot.content,
        force ? undefined : get().editorFileMtimes[filePath]);
      if (!editorBridge.matchesSaveTarget(filePath, snapshot)) return;
      onSaved(filePath);
      editorBridge.updateBaseline(filePath, result.mtimeMs);
      const unchanged = editorBridge.matchesSaveDocument(filePath, snapshot);
      set((state) => ({
        editorSaving: without(state.editorSaving, filePath),
        editorFileMtimes: { ...state.editorFileMtimes, [filePath]: result.mtimeMs },
        editorExternalChanges: without(state.editorExternalChanges, filePath),
        ...(unchanged ? { editorModifiedFiles: without(state.editorModifiedFiles, filePath) } : {}),
      }));
      if (unchanged) {
        try { localStorage.removeItem(`editor-draft:${filePath}`); } catch { /* unavailable storage */ }
      }
    } catch (error) {
      if (!editorBridge.matchesSaveTarget(filePath, snapshot)) return;
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to save file:', filePath, message);
      set((state) => ({
        editorSaving: without(state.editorSaving, filePath),
        ...(message.includes('CONFLICT') ? { editorConflictFile: filePath }
          : { editorSaveError: { ...state.editorSaveError, [filePath]: message } }),
      }));
    } finally {
      // Only this request can clear its obsolete bookkeeping; a newer save owns its own flag.
      if (inFlight.get(filePath) === snapshot) {
        inFlight.delete(filePath);
        if (editorBridge.matchesSaveSession(snapshot) && get().editorSaving[filePath]) {
          set((state) => ({ editorSaving: without(state.editorSaving, filePath) }));
        }
      }
    }
  };
  return {
    saveFile: (filePath) => save(filePath),
    forceOverwrite: (filePath) => save(filePath, true),
    saveAllFiles: async () => {
      // Avoid materializing all large documents at once.
      const revision = editorBridge.revision('__saveAll');
      for (const filePath of Object.keys(get().editorModifiedFiles)) {
        if (revision !== editorBridge.revision('__saveAll')) break;
        await save(filePath);
      }
    },
  };
}
