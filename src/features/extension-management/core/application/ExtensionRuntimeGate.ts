export interface MutationLease {
  release(): void;
  /** Broaden without a gap; a new mutation must also reject launches already preparing. */
  extend(resources: readonly string[], requireIdle?: boolean): void;
}

/** Mutual admission for native profile mutations and launch preparation. */
export class ExtensionRuntimeGate {
  private readonly launching = new Map<string, number>();
  private readonly mutations = new Set<string>();

  /** The owner must publish this lease before awaiting activity validation. */
  reserveMutation(resources: readonly string[]): MutationLease {
    return this.hold(resources, true);
  }

  restoreMutation(resources: readonly string[]): MutationLease {
    // Accepted work already exists. Prevent further launches even if an earlier
    // launch is still being observed; this does not pretend to freeze that run.
    return this.hold(resources, false);
  }

  private hold(resources: readonly string[], checkLaunching: boolean): MutationLease {
    const owned = new Set<string>();
    let released = false;
    const extend = (more: readonly string[], check = false) => {
      if (released) throw new Error('This mutation admission has already been released.');
      const added = [...new Set(more)].filter((key) => !owned.has(key));
      if (
        added.some((key) => this.mutations.has(key)) ||
        (check && more.some((key) => this.launching.has(key)))
      )
        throw new Error(
          'This agent environment is busy. Wait for the current launch or extension change.'
        );
      added.forEach((key) => {
        owned.add(key);
        this.mutations.add(key);
      });
    };
    extend(resources, checkLaunching);
    return {
      extend: (more, requireIdle = false) => extend(more, requireIdle),
      release: () => {
        if (released) return;
        released = true;
        owned.forEach((key) => this.mutations.delete(key));
      },
    };
  }

  async launch<T>(resources: readonly string[], operation: () => Promise<T>): Promise<T> {
    const keys = [...new Set(resources)];
    if (keys.some((key) => this.mutations.has(key))) {
      throw new Error(
        'An extension change is running or needs recovery. Resolve it before launching this agent.'
      );
    }
    keys.forEach((key) => this.launching.set(key, (this.launching.get(key) ?? 0) + 1));
    try {
      return await operation();
    } finally {
      keys.forEach((key) => {
        const count = (this.launching.get(key) ?? 1) - 1;
        if (count) this.launching.set(key, count);
        else this.launching.delete(key);
      });
    }
  }
}
