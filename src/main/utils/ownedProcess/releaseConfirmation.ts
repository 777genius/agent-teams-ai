import { performance } from 'node:perf_hooks';

import type { BrokerExit } from './contract';

/** The original broker must both acknowledge Release and exit successfully. */
export class BrokerReleaseConfirmation {
  acknowledged = false;
  private exit?: BrokerExit;
  private failure?: string;
  private readonly observers = new Set<() => void>();

  acknowledge(): void {
    this.acknowledged = true;
    this.notify();
  }
  observeExit(exit: BrokerExit): void {
    this.exit ??= exit;
    if (this.exit.code !== 0 || this.exit.signal !== null)
      this.fail('Original broker did not exit successfully');
    this.notify();
  }
  fail(reason: string): void {
    this.failure ??= reason;
    this.notify();
  }
  private notify(): void {
    for (const observer of this.observers) observer();
  }
  wait(deadline: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: string): void => {
        clearTimeout(timer);
        this.observers.delete(check);
        if (error) reject(new Error(error));
        else resolve();
      };
      const check = (): void => {
        if (this.failure) finish(this.failure);
        else if (performance.now() >= deadline) finish('Broker release completion deadline');
        else if (this.acknowledged && this.exit?.code === 0 && this.exit.signal === null) finish();
      };
      const timer = setTimeout(
        () => finish('Broker release completion deadline'),
        Math.max(0, deadline - performance.now())
      );
      this.observers.add(check);
      check();
    });
  }
}
