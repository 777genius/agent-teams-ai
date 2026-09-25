import { normalizeReviewWatchedFiles } from '../../core/domain/reviewFileWatchPolicy';

import type {
  ReviewFileWatchConfiguration,
  ReviewFileWatchDependencies,
  ReviewFileWatcherPort,
  ReviewFileWatchOperation,
  ReviewProjectPathValidator,
} from './ReviewFileWatchPorts';

export class ReviewFileWatchApplication {
  private fileWatcher: ReviewFileWatcherPort;
  private projectPathValidator: ReviewProjectPathValidator;
  private projectRoot: string | null = null;
  private requestGeneration = 0;

  constructor(private readonly dependencies: ReviewFileWatchDependencies) {
    this.fileWatcher = dependencies.defaultWatcher;
    this.projectPathValidator = dependencies.defaultProjectPathValidator;
  }

  supersedePendingRequests(): void {
    this.requestGeneration += 1;
  }

  configure(configuration: ReviewFileWatchConfiguration): void {
    const nextFileWatcher = configuration.fileWatcher ?? this.dependencies.defaultWatcher;
    if (this.fileWatcher !== nextFileWatcher) {
      this.fileWatcher.stop();
      this.projectRoot = null;
      this.fileWatcher = nextFileWatcher;
    }
    this.projectPathValidator =
      configuration.projectPathValidator ?? this.dependencies.defaultProjectPathValidator;
  }

  prepareWatch(projectPath: string, filePaths: unknown): ReviewFileWatchOperation {
    const requestGeneration = ++this.requestGeneration;
    return async () => {
      const normalizedProjectPath = await this.projectPathValidator(projectPath);
      if (requestGeneration !== this.requestGeneration) return;
      const shouldRestart =
        this.projectRoot !== normalizedProjectPath || !this.fileWatcher.isWatching();

      if (shouldRestart) {
        this.fileWatcher.stop();
        this.projectRoot = normalizedProjectPath;
        this.fileWatcher.start(normalizedProjectPath, (event) => {
          this.dependencies.events.present(event);
        });
      }

      this.fileWatcher.setWatchedFiles(normalizeReviewWatchedFiles(filePaths));
    };
  }

  prepareUnwatch(): ReviewFileWatchOperation {
    this.requestGeneration += 1;
    return async () => {
      this.fileWatcher.stop();
      this.projectRoot = null;
    };
  }

  dispose(): void {
    this.fileWatcher.stop();
    this.projectRoot = null;
    this.requestGeneration += 1;
  }
}
