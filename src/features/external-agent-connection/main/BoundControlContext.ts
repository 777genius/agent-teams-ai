import { createHash } from 'node:crypto';

import type { AppConnectionContext } from '../contracts';

export class AppContextMismatchError extends Error {
  readonly code = 'APP_CONTEXT_MISMATCH';
  readonly statusCode = 409;
  constructor() {
    super('APP_CONTEXT_MISMATCH: Refresh app connection info before retrying.');
  }
}

function matches(context: AppConnectionContext, expected: unknown): boolean {
  if (!expected || typeof expected !== 'object') return false;
  const value = expected as Record<string, unknown>;
  return value.appInstanceId === context.appInstanceId &&
    value.dataRootFingerprint === context.dataRootFingerprint &&
    value.connectionGeneration === context.connectionGeneration;
}

/** Orders bound requests against root updates; it does not own transport lifecycle. */
export class BoundControlContext {
  private generation = 1;
  private rootFingerprint: string;
  private admissionOpen = true;
  private inFlight = 0;
  private drained: (() => void) | null = null;

  constructor(private readonly appInstanceId: string, root: string) {
    this.rootFingerprint = createHash('sha256').update(root).digest('hex');
  }

  snapshot(): AppConnectionContext {
    return Object.freeze({
      appInstanceId: this.appInstanceId,
      dataRootFingerprint: this.rootFingerprint,
      connectionGeneration: this.generation,
    });
  }

  assertExpected(expected: unknown): void {
    if (!this.admissionOpen || !matches(this.snapshot(), expected)) {
      throw new AppContextMismatchError();
    }
  }

  admit(expected: unknown): () => void {
    this.assertExpected(expected);
    this.inFlight++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight--;
      if (this.inFlight === 0) {
        this.drained?.();
        this.drained = null;
      }
    };
  }

  async closeAdmission(): Promise<void> {
    this.admissionOpen = false;
    this.generation++;
    if (this.inFlight > 0) {
      await new Promise<void>((resolve) => {
        const previous = this.drained;
        this.drained = () => { previous?.(); resolve(); };
      });
    }
  }

  rebind(root: string): void {
    if (this.inFlight !== 0) throw new Error('Cannot rebind while admitted control requests remain');
    this.rootFingerprint = createHash('sha256').update(root).digest('hex');
    this.admissionOpen = true;
  }

  transportReplaced(): void {
    this.generation++;
  }

  get isOpen(): boolean {
    return this.admissionOpen;
  }
}
