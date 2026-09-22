import type { TmuxStatusSourcePort } from '../ports/TmuxStatusSourcePort';
import type { TmuxStatus } from '@features/tmux-installer/contracts';

export class GetTmuxStatusUseCase {
  readonly #statusSource: TmuxStatusSourcePort;

  constructor(statusSource: TmuxStatusSourcePort) {
    this.#statusSource = statusSource;
  }

  execute(): Promise<TmuxStatus> {
    return this.#statusSource.getStatus();
  }
}
