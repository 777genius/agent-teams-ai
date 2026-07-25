import type { EditorFileChangeEvent } from '@shared/types/editor';

export interface ReviewFileWatcherPort {
  isWatching(): boolean;
  setWatchedFiles(filePaths: string[]): void;
  start(projectRoot: string, onChange: (event: EditorFileChangeEvent) => void): void;
  stop(): void;
}

export type ReviewProjectPathValidator = (projectPath: string) => Promise<string>;

export interface ReviewFileWatchEventPort {
  present(event: EditorFileChangeEvent): void;
}

export interface ReviewFileWatchDependencies {
  defaultWatcher: ReviewFileWatcherPort;
  defaultProjectPathValidator: ReviewProjectPathValidator;
  events: ReviewFileWatchEventPort;
}

export interface ReviewFileWatchConfiguration {
  fileWatcher?: ReviewFileWatcherPort;
  projectPathValidator?: ReviewProjectPathValidator;
}

export type ReviewFileWatchOperation = () => Promise<void>;
