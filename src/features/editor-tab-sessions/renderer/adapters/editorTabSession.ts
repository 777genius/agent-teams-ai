import { getLanguageFromFileName } from '@renderer/utils/codemirrorLanguages';
import { computeDisambiguatedTabs } from '@renderer/utils/tabLabelDisambiguation';
import { getBasename } from '@shared/utils/platformPath';

import {
  createEditorTabsRepository,
  type EditorTabsRepository,
} from '../../core/application/editorTabsRepository';
import { editorSessionPathKey } from '../../core/domain/tabSession';

import { createLocalEditorTabsStorage } from './localEditorTabsStorage';

import type { AppState } from '@renderer/store/types';
import type { StateCreator, StoreApi } from 'zustand';

export function createEditorTabSession(
  setState: StoreApi<AppState>['setState'],
  get: () => AppState,
  repository: EditorTabsRepository = createEditorTabsRepository(
    createLocalEditorTabsStorage(() => localStorage)
  )
) {
  let suspended = false;
  let generation: number | null = null;
  const save = (state: AppState): void => {
    if (state.editorProjectPath)
      repository.save(state.editorProjectPath, {
        paths: state.editorOpenTabs.map((tab) => tab.filePath),
        active: state.editorActiveTabId,
      });
  };
  const set: typeof setState = (partial, replace) => {
    const before = get();
    setState(partial, replace);
    const after = get();
    if (suspended) return;
    if (before.editorProjectPath !== after.editorProjectPath) save(before);
    if (
      after.editorProjectPath &&
      (before.editorOpenTabs !== after.editorOpenTabs ||
        before.editorActiveTabId !== after.editorActiveTabId)
    )
      save(after);
  };
  return {
    set,
    beginOpen(project: string, sequence: number) {
      if (!suspended) save(get());
      suspended = true;
      generation = sequence;
      return { project, sequence, saved: repository.load(project) };
    },
    restore(open: {
      project: string;
      sequence: number;
      saved: { paths: string[]; active: string | null };
    }) {
      const current = get();
      if (
        generation !== open.sequence ||
        editorSessionPathKey(current.editorProjectPath) !== editorSessionPathKey(open.project)
      )
        return null;
      const present = new Set(
        current.editorOpenTabs.map((tab) => editorSessionPathKey(tab.filePath))
      );
      const restored = open.saved.paths
        .filter((file) => !present.has(editorSessionPathKey(file)))
        .map((filePath) => ({
          id: filePath,
          filePath,
          fileName: getBasename(filePath),
          language: getLanguageFromFileName(getBasename(filePath)),
        }));
      const tabs = computeDisambiguatedTabs([...restored, ...current.editorOpenTabs]);
      suspended = false;
      return {
        editorOpenTabs: tabs,
        editorActiveTabId: current.editorActiveTabId ?? open.saved.active ?? tabs[0]?.id ?? null,
      };
    },
    beginClose() {
      if (!suspended) save(get());
      suspended = true;
      generation = null;
    },
    endClose() {
      suspended = false;
    },
  };
}

export function withEditorTabSession<T>(
  create: (
    set: StoreApi<AppState>['setState'],
    get: () => AppState,
    session: ReturnType<typeof createEditorTabSession>
  ) => T
): StateCreator<AppState, [], [], T> {
  return (set, get) => {
    const session = createEditorTabSession(set, get);
    return create(session.set, get, session);
  };
}
