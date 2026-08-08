import { EditorFileWatcher } from '@main/services/editor';

import { ReviewFileWatchEventPresenter } from '../adapters/output/presenters/ReviewFileWatchEventPresenter';
import { ReviewFileWatchApplication } from '../application/ReviewFileWatchApplication';
import { validateReviewWatchProjectPath } from '../infrastructure/validateReviewWatchProjectPath';

import type {
  ReviewFileWatchConfiguration,
  ReviewFileWatchOperation,
} from '../application/ReviewFileWatchPorts';
import type { BrowserWindow } from 'electron';

export interface ReviewFileWatchFeature {
  supersedePendingRequests(): void;
  configure(configuration: ReviewFileWatchConfiguration): void;
  prepareWatch(projectPath: string, filePaths: unknown): ReviewFileWatchOperation;
  prepareUnwatch(): ReviewFileWatchOperation;
  dispose(): void;
  setMainWindow(window: BrowserWindow | null): void;
}

export function createReviewFileWatchFeature(): ReviewFileWatchFeature {
  // Review is backed by a point-in-time diff. Ignoring startup changes can miss
  // an external write and make Undo unsafe.
  const defaultWatcher = new EditorFileWatcher({ ignoreStartupChanges: false });
  const presenter = new ReviewFileWatchEventPresenter();
  const application = new ReviewFileWatchApplication({
    defaultWatcher,
    defaultProjectPathValidator: validateReviewWatchProjectPath,
    events: presenter,
  });

  return {
    supersedePendingRequests: () => application.supersedePendingRequests(),
    configure: (configuration) => application.configure(configuration),
    prepareWatch: (projectPath, filePaths) => application.prepareWatch(projectPath, filePaths),
    prepareUnwatch: () => application.prepareUnwatch(),
    dispose: () => application.dispose(),
    setMainWindow: (window) => presenter.setMainWindow(window),
  };
}
