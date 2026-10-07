import type { App } from 'electron';

export interface OtaState {
  electronVersion: string;
  events: {
    type: string;
    version?: string;
    percent?: number;
    downloadedFile?: string;
    at: string;
    message?: string;
  }[];
  native: { type: string; at: string; message?: string }[];
  provider?: string;
  providerError?: string;
  candidateVersion?: string;
}
interface Observer {
  readonly clientPromise: Promise<{ constructor: { name: string } }> | null;
  on(
    event: string,
    listener: (info: {
      version?: string;
      percent?: number;
      downloadedFile?: string;
      message?: string;
    }) => void
  ): unknown;
}
// These listeners observe the original native Squirrel completion separately from electron-updater's earlier notification.
export function observeOldMac(
  electron: {
    app: App;
    autoUpdater: { on(event: string, listener: (...args: unknown[]) => void): unknown };
  },
  getUpdater: () => Observer
) {
  const state: OtaState = { electronVersion: process.versions.electron, events: [], native: [] };
  (globalThis as typeof globalThis & { __TEST_oldMac: OtaState }).__TEST_oldMac = state;
  electron.app.once('ready', () => {
    const updater = getUpdater();
    for (const [event, type] of [
      ['checking-for-update', 'checking'],
      ['update-available', 'available'],
      ['update-not-available', 'not-available'],
      ['update-downloaded', 'downloaded'],
      ['download-progress', 'progress'],
      ['error', 'error'],
    ] as const)
      updater.on(event, (info) => {
        state.events.push({
          type,
          version: info?.version,
          percent: info?.percent,
          downloadedFile: info?.downloadedFile,
          message: info?.message,
          at: new Date().toISOString(),
        });
        if (type === 'available' || type === 'not-available')
          state.candidateVersion = info?.version;
        void updater.clientPromise?.then(
          (provider) => {
            state.provider = provider.constructor.name;
          },
          (error: unknown) => {
            state.providerError = String(error);
          }
        );
      });
    electron.autoUpdater.on('update-downloaded', () =>
      state.native.push({ type: 'downloaded', at: new Date().toISOString() })
    );
    electron.autoUpdater.on('error', (...args) =>
      state.native.push({
        type: 'error',
        at: new Date().toISOString(),
        message: args.map(String).join(' '),
      })
    );
  });
}
