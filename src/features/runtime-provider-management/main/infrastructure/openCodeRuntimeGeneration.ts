/**
 * Detects that the OpenCode runtime changed since provider reads were cached.
 *
 * The resolver generation bumps when an install finishes and on an OpenCode
 * status re-check. A directory read while OpenCode was missing still succeeds
 * with seed-only entries, so reads cached under another generation describe a
 * different runtime and must not be served again.
 */
export class OpenCodeRuntimeGenerationGuard {
  private readonly readGeneration: () => number;
  private observedGeneration: number;

  constructor(readGeneration: () => number) {
    this.readGeneration = readGeneration;
    this.observedGeneration = readGeneration();
  }

  /** True once per generation change: the caller must drop its cached reads. */
  consumeChange(): boolean {
    const generation = this.readGeneration();
    if (generation === this.observedGeneration) {
      return false;
    }
    this.observedGeneration = generation;
    return true;
  }
}
