import type { AccountObservationLockPort } from "../application/ports";

export class SerialAccountLock implements AccountObservationLockPort {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  async withAccountLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.inFlight.get(key);
    if (previous) {
      try {
        await previous;
      } catch {
        // The next observer should still get its own chance after a failed one.
      }
    }

    const current = fn();
    this.inFlight.set(key, current);
    try {
      return await current;
    } finally {
      if (this.inFlight.get(key) === current) this.inFlight.delete(key);
    }
  }
}
