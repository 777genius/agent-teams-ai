import type { TmuxStatus } from '@features/tmux-installer/contracts';

export interface TmuxStatusSourcePort {
  getStatus(): Promise<TmuxStatus>;
  invalidateStatus(): void;
}
