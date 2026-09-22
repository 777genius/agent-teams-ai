import { countOpenInterval } from '../../core/domain';

import type { AnnouncementClock } from '../../core/application/ports';

/** Counts the union of main-window intervals, independently of focus/minimization. */
export class AnnouncementUsageTracker {
  private windows = new Set<number>();
  private anchor: number | null = null;
  private suspended = false;
  private enabled = false;
  private pending = 0;
  constructor(private readonly clock: AnnouncementClock) {}
  tick(): number {
    const interval = countOpenInterval(
      this.anchor,
      this.clock.monotonic(),
      this.enabled && !this.suspended && this.windows.size > 0
    );
    this.anchor = interval.anchor;
    this.pending += interval.elapsedMs;
    return interval.elapsedMs;
  }
  register(id: number): void {
    this.tick();
    this.windows.add(id);
    this.tick();
  }
  unregister(id: number): void {
    this.tick();
    this.windows.delete(id);
    this.tick();
  }
  hasWindows(): boolean {
    return this.windows.size > 0;
  }
  ownsWindow(id: number): boolean {
    return this.windows.has(id);
  }
  setEnabled(enabled: boolean): void {
    this.tick();
    this.enabled = enabled;
    this.tick();
  }
  suspend(): void {
    this.tick();
    this.suspended = true;
    this.tick();
  }
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.anchor = null;
    this.tick();
  }
  takePending(): number {
    const value = this.pending;
    this.pending = 0;
    return value;
  }
  pendingMs(): number {
    return this.pending;
  }
}
