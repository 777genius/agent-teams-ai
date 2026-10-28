import type { TaskViewState } from '../view-models/taskViewStateSchema';
import type { TaskViewSortMode } from '@renderer/components/sidebar/taskViewPolicy';

export interface TaskViewPreferencesRepository {
  load(storageNamespace: string, defaultSortMode: TaskViewSortMode): TaskViewState;
  save(storageNamespace: string, state: TaskViewState): void;
}
