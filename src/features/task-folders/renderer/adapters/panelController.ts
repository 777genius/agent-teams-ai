export type Hold =
  | 'drag'
  | 'pointer'
  | 'focus'
  | 'edit'
  | `edit:${string}`
  | 'menu'
  | 'dialog'
  | 'manual'
  | `menu:${string}`;
export interface PanelState {
  open: boolean;
  manual: boolean;
  dragSource: string | null;
  session: number;
}
// The vendor cancel Escape lands within the same input sequence as dragend; anything
// later is a fresh Escape that must disable mode.
const CANCEL_ESCAPE_WINDOW_MS = 2000;
/** Host-owned lifecycle survives virtual row unmounts. Duplicate end events are harmless. */
export class PanelController {
  private state: PanelState = { open: false, manual: false, dragSource: null, session: 0 };
  private holds = new Set<Hold>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private dropTimer: ReturnType<typeof setTimeout> | undefined;
  private dropped = false;
  private pendingDragEscape = false;
  private pendingDragEscapeTimer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();
  getSnapshot = (): PanelState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(patch: Partial<PanelState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }
  private cancelTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.generation++;
  }
  hold(reason: Hold, active: boolean): void {
    if (reason === 'manual' && !active) {
      this.close();
      return;
    }
    if (reason !== 'manual' && !this.state.manual) return;
    if (active === this.holds.has(reason)) return;
    if (active) {
      this.holds.add(reason);
      this.cancelTimer();
      this.publish({ open: true, ...(reason === 'manual' ? { manual: true } : {}) });
    } else {
      this.holds.delete(reason);
      this.schedule();
    }
  }
  private schedule(): void {
    this.cancelTimer();
    if (this.holds.size || !this.state.open) return;
    const generation = this.generation;
    this.timer = setTimeout(() => {
      if (generation === this.generation && !this.holds.size)
        this.publish({ open: false, manual: false });
    }, 2000);
  }
  begin(source: string): number {
    if (!this.state.manual) return this.state.session;
    this.cancelDropTimer();
    this.cancelTimer();
    this.dropped = false;
    this.clearPendingDragEscape();
    this.holds.add('drag');
    this.publish({ open: true, dragSource: source, session: this.state.session + 1 });
    return this.state.session;
  }
  end(session = this.state.session): void {
    if (session !== this.state.session || !this.holds.has('drag')) return;
    this.cancelDropTimer();
    this.holds.delete('drag');
    if (!this.dropped) {
      this.pendingDragEscape = true;
      clearTimeout(this.pendingDragEscapeTimer);
      this.pendingDragEscapeTimer = setTimeout(
        () => this.clearPendingDragEscape(),
        CANCEL_ESCAPE_WINDOW_MS
      );
    }
    this.publish({ dragSource: null });
    this.schedule();
  }
  private cancelDropTimer(): void {
    clearTimeout(this.dropTimer);
    this.dropTimer = undefined;
  }
  private clearPendingDragEscape(): void {
    this.pendingDragEscape = false;
    clearTimeout(this.pendingDragEscapeTimer);
    this.pendingDragEscapeTimer = undefined;
  }
  endAfterDrop(): void {
    if (this.dropTimer !== undefined || !this.holds.has('drag')) return;
    const session = this.state.session;
    this.dropped = true;
    // Native listener propagation can run microtask checkpoints before the vendor drop.
    this.dropTimer = setTimeout(() => {
      this.dropTimer = undefined;
      this.end(session);
    }, 0);
  }
  escape(): boolean {
    if (
      this.holds.has('edit') ||
      [...this.holds].some((reason) => reason.startsWith('edit:')) ||
      this.holds.has('menu') ||
      [...this.holds].some((reason) => reason.startsWith('menu:')) ||
      this.holds.has('dialog')
    )
      return false;
    if (this.holds.has('drag')) {
      this.end();
      this.clearPendingDragEscape();
      return true;
    }
    if (this.pendingDragEscape) {
      this.clearPendingDragEscape();
      return true;
    }
    if (this.holds.has('manual')) {
      this.close();
      return true;
    }
    return false;
  }
  toggle(): void {
    if (this.holds.has('manual')) this.close();
    else this.hold('manual', true);
  }
  close(): void {
    this.cancelDropTimer();
    this.cancelTimer();
    this.holds.clear();
    this.dropped = false;
    this.clearPendingDragEscape();
    this.publish({ open: false, manual: false, dragSource: null });
  }
  suspend(): void {
    this.cancelDropTimer();
    this.cancelTimer();
    this.holds.clear();
    this.dropped = false;
    this.clearPendingDragEscape();
    if (this.state.manual) this.holds.add('manual');
    this.publish({ open: this.state.manual, dragSource: null, session: this.state.session + 1 });
  }
  dispose(): void {
    this.close();
  }
}
