export interface FileWatcherStartupCoordinatorOptions {
  isServicesReady: () => boolean;
  isShutdownStarted: () => boolean;
  getActiveContext: () => { startFileWatcher(): void };
  schedule: (action: () => void, delayMs: number) => void;
  platform: NodeJS.Platform;
}

/**
 * Starts the active context's FileWatcher once main-process services are ready.
 *
 * Renderer lifecycle is intentionally absent from this boundary. Inbox delivery
 * is a main-process responsibility and must continue while the renderer reloads
 * or recovers from a crash.
 */
export class FileWatcherStartupCoordinator {
  private startupStarted = false;

  constructor(private readonly options: FileWatcherStartupCoordinatorOptions) {}

  startWhenServicesReady(): void {
    if (
      this.startupStarted ||
      !this.options.isServicesReady() ||
      this.options.isShutdownStarted()
    ) {
      return;
    }

    this.startupStarted = true;

    if (this.options.platform === 'win32') {
      this.options.schedule(() => {
        if (!this.options.isServicesReady() || this.options.isShutdownStarted()) {
          return;
        }
        this.options.getActiveContext().startFileWatcher();
      }, 1500);
      return;
    }

    this.options.getActiveContext().startFileWatcher();
  }
}
