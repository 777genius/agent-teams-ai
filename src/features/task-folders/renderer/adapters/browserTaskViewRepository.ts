import { normalizeTaskViewState, serializeTaskViewState } from '../view-models/taskViewStateSchema';

import type { TaskViewState } from '../view-models/taskViewStateSchema';
import type { TaskViewPreferencesRepository } from './taskViewRepository';
import type { TaskViewSortMode } from '@renderer/components/sidebar/taskViewPolicy';

type TaskViewStorage = Pick<Storage, 'getItem' | 'setItem'>;
const taskViewStorageKey = (storageNamespace: string): string =>
  `taskFolders:taskView:v1:${storageNamespace}`;

export class BrowserTaskViewPreferencesRepository implements TaskViewPreferencesRepository {
  constructor(private readonly getStorage: () => TaskViewStorage) {}

  load(storageNamespace: string, defaultSortMode: TaskViewSortMode): TaskViewState {
    try {
      const raw = this.getStorage().getItem(taskViewStorageKey(storageNamespace));
      if (raw !== null) return normalizeTaskViewState(JSON.parse(raw), defaultSortMode);
    } catch {
      /* storage and persisted values are best-effort */
    }
    return normalizeTaskViewState(undefined, defaultSortMode);
  }

  save(storageNamespace: string, state: TaskViewState): void {
    try {
      this.getStorage().setItem(
        taskViewStorageKey(storageNamespace),
        JSON.stringify(serializeTaskViewState(state))
      );
    } catch {
      /* preference persistence is best-effort */
    }
  }
}

export function createBrowserTaskViewPreferencesRepository(
  getStorage: () => TaskViewStorage = () => window.localStorage
): TaskViewPreferencesRepository {
  return new BrowserTaskViewPreferencesRepository(getStorage);
}

export const browserTaskViewPreferencesRepository = createBrowserTaskViewPreferencesRepository();
