import type { TmuxInstallerSnapshotPort } from '../ports/TmuxInstallerSnapshotPort';
import type { TmuxInstallerSnapshot } from '@features/tmux-installer/contracts';

export class GetTmuxInstallerSnapshotUseCase {
  readonly #snapshotPort: TmuxInstallerSnapshotPort;

  constructor(snapshotPort: TmuxInstallerSnapshotPort) {
    this.#snapshotPort = snapshotPort;
  }

  execute(): TmuxInstallerSnapshot {
    return this.#snapshotPort.getSnapshot();
  }
}
