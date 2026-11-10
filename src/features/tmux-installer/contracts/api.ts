import type { TmuxInstallerProgress, TmuxInstallerSnapshot, TmuxStatus } from './dto';

export interface TmuxAPI {
  getStatus: () => Promise<TmuxStatus>;
  getInstallerSnapshot: () => Promise<TmuxInstallerSnapshot>;
  install: () => Promise<void>;
  cancelInstall: () => Promise<void>;
  submitInstallerInput: (input: string) => Promise<void>;
  invalidateStatus: () => Promise<void>;
  onProgress: (callback: (event: unknown, data: TmuxInstallerProgress) => void) => () => void;
}
