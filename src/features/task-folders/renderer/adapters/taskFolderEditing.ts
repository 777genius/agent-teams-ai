import { useSyncExternalStore } from 'react';

import { folderController } from '../composition';

import { moveRequest } from './moveRequest';

import type { FolderState } from '../../core/application/folderController';
import type { TaskIdentity } from '../../core/domain/folders';
export interface TaskFolderReadinessSource {
  getSnapshot(): Pick<FolderState, 'status'>;
  subscribe(listener: () => void): () => void;
}
const isReady = (source: TaskFolderReadinessSource): boolean =>
  source.getSnapshot().status === 'ready';
export function useTaskFolderEditingReady(
  source: TaskFolderReadinessSource = folderController
): boolean {
  return useSyncExternalStore(
    (listener) => source.subscribe(listener),
    () => isReady(source),
    () => isReady(source)
  );
}
export const taskFolderMoveRequest = {
  getSnapshot: moveRequest.getSnapshot,
  subscribe: moveRequest.subscribe,
  open: (identity: TaskIdentity): void => {
    if (isReady(folderController)) moveRequest.open(identity);
  },
  close: moveRequest.close,
};
