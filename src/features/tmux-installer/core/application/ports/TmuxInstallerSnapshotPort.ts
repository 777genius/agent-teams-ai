import type { TmuxInstallerSnapshot } from '@features/tmux-installer/contracts';

export interface TmuxInstallerSnapshotPort {
  getSnapshot(): TmuxInstallerSnapshot;
}
