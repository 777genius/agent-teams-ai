import {
  type AnthropicTeamApiKeyHelperMaterial,
  cleanupAnthropicTeamApiKeyHelperMaterial,
} from '../../runtime/anthropicTeamApiKeyHelper';

export type AnthropicApiKeyHelperMaterialCleanup = (input: {
  directory: string;
}) => Promise<unknown>;

export interface AnthropicApiKeyHelperRunOwner {
  anthropicApiKeyHelper: AnthropicTeamApiKeyHelperMaterial | null;
  anthropicApiKeyHelperCleanupPromise?: Promise<void> | null;
}

export class AnthropicApiKeyHelperLeaseConflictError extends Error {
  constructor() {
    super('Deterministic setup produced conflicting Anthropic API-key helpers');
    this.name = 'AnthropicApiKeyHelperLeaseConflictError';
  }
}

/**
 * Owns helper material while deterministic setup is still fallible. The lease
 * is deliberately provisioning-local: setup either releases it or transfers
 * its exact material into the run that is about to be published.
 */
export interface AnthropicApiKeyHelperSetupLease {
  coalesce(material: AnthropicTeamApiKeyHelperMaterial | null | undefined): void;
  getOwnedMaterial(): AnthropicTeamApiKeyHelperMaterial | null;
  transferTo(run: AnthropicApiKeyHelperRunOwner): AnthropicTeamApiKeyHelperMaterial | null;
  cleanup(): Promise<void>;
}

export interface AnthropicApiKeyHelperCleanupRetryOwner {
  retainSetupLease(
    lease: AnthropicApiKeyHelperSetupLease
  ): Promise<AnthropicApiKeyHelperCleanupRetentionResult>;
  retainRunOwner(
    run: AnthropicApiKeyHelperRunOwner,
    options?: AnthropicApiKeyHelperRetainedRunOptions
  ): Promise<AnthropicApiKeyHelperCleanupRetentionResult>;
  retryPendingForTeam(teamName: string): Promise<void>;
  hasPendingForTeam(teamName: string): boolean;
  getPendingOwnerCount(): number;
}

export interface AnthropicApiKeyHelperRetainedRunOptions {
  beforeCleanup?: () => Promise<void>;
  cleanup?: () => Promise<void>;
  onReleased?: () => void;
}

export interface AnthropicApiKeyHelperDurableSetupCleanupOwner {
  readonly kind: 'setup';
  readonly teamName: string;
  readonly directory: string;
  readonly lease: AnthropicApiKeyHelperSetupLease;
  retryCleanup(): Promise<void>;
}

export interface AnthropicApiKeyHelperDurableRunCleanupOwner {
  readonly kind: 'run';
  readonly teamName: string;
  readonly directory: string;
  readonly run: AnthropicApiKeyHelperRunOwner;
  retryCleanup(): Promise<void>;
}

export type AnthropicApiKeyHelperDurableCleanupOwner =
  | AnthropicApiKeyHelperDurableSetupCleanupOwner
  | AnthropicApiKeyHelperDurableRunCleanupOwner;

export type AnthropicApiKeyHelperCleanupRetentionResult =
  | { kind: 'retained' }
  | {
      kind: 'source-owned';
      owner: AnthropicApiKeyHelperDurableCleanupOwner;
      maxPendingOwners: number;
    };

/**
 * Carries an overflow cleanup owner through production create/launch rejection.
 * The exact lease/run therefore remains reachable without growing the bounded
 * service-level retry map or leaving the caller waiting for unrelated teams.
 */
export class AnthropicApiKeyHelperCleanupCapacityError extends Error {
  readonly cleanupOwner: AnthropicApiKeyHelperDurableCleanupOwner;
  readonly maxPendingOwners: number;

  constructor(
    retention: Extract<AnthropicApiKeyHelperCleanupRetentionResult, { kind: 'source-owned' }>,
    options: { cause: unknown }
  ) {
    super(
      `Anthropic helper cleanup retry owner capacity exceeded (${retention.maxPendingOwners}); exact cleanup ownership remains attached to this error`,
      options
    );
    this.name = 'AnthropicApiKeyHelperCleanupCapacityError';
    this.cleanupOwner = retention.owner;
    this.maxPendingOwners = retention.maxPendingOwners;
  }
}

export function throwIfAnthropicApiKeyHelperCleanupRemainsSourceOwned(
  retention: AnthropicApiKeyHelperCleanupRetentionResult,
  cause: unknown
): void {
  if (retention.kind === 'source-owned') {
    throw new AnthropicApiKeyHelperCleanupCapacityError(retention, { cause });
  }
}

export interface AnthropicApiKeyHelperCleanupRetryOwnerOptions {
  maxPendingOwners?: number;
  retryDelaysMs?: readonly number[];
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export const ANTHROPIC_API_KEY_HELPER_MAX_PENDING_CLEANUP_OWNERS = 128;
export const ANTHROPIC_API_KEY_HELPER_CLEANUP_RETRY_DELAYS_MS = [
  1_000, 5_000, 30_000, 120_000, 300_000,
] as const;
export const ANTHROPIC_API_KEY_HELPER_MAX_AUTOMATIC_CLEANUP_RETRIES =
  ANTHROPIC_API_KEY_HELPER_CLEANUP_RETRY_DELAYS_MS.length;

export function createAnthropicApiKeyHelperSetupLease(
  cleanupMaterial: AnthropicApiKeyHelperMaterialCleanup = (input) =>
    cleanupAnthropicTeamApiKeyHelperMaterial(input)
): AnthropicApiKeyHelperSetupLease {
  const ownedByDirectory = new Map<string, AnthropicTeamApiKeyHelperMaterial>();
  let state: 'setup' | 'releasing' | 'transferred' | 'released' = 'setup';
  let cleanupPromise: Promise<void> | null = null;

  return {
    coalesce(material) {
      if (!material) {
        return;
      }
      if (state !== 'setup') {
        throw new Error(`Cannot acquire Anthropic API-key helper after lease was ${state}`);
      }

      ownedByDirectory.set(material.directory, material);
      if (ownedByDirectory.size > 1) {
        throw new AnthropicApiKeyHelperLeaseConflictError();
      }
    },

    getOwnedMaterial() {
      return ownedByDirectory.values().next().value ?? null;
    },

    transferTo(run) {
      if (state !== 'setup') {
        throw new Error(`Cannot transfer Anthropic API-key helper lease after it was ${state}`);
      }
      if (run.anthropicApiKeyHelper) {
        throw new Error('Cannot transfer Anthropic API-key helper into an occupied run owner');
      }

      const material = ownedByDirectory.values().next().value ?? null;
      run.anthropicApiKeyHelper = material;
      run.anthropicApiKeyHelperCleanupPromise = null;
      ownedByDirectory.clear();
      state = 'transferred';
      return material;
    },

    async cleanup() {
      if (state === 'transferred' || state === 'released') {
        return;
      }
      if (cleanupPromise) {
        await cleanupPromise;
        return;
      }

      const ownedMaterials = [...ownedByDirectory.values()];
      state = 'releasing';
      cleanupPromise = Promise.all(
        ownedMaterials.map(async (material) => {
          await cleanupMaterial({ directory: material.directory });
        })
      ).then(() => undefined);
      try {
        await cleanupPromise;
        ownedByDirectory.clear();
        state = 'released';
      } catch (error) {
        state = 'setup';
        throw error;
      } finally {
        cleanupPromise = null;
      }
    },
  };
}

/** Release a run's exact helper once. Failed cleanup retains ownership for retry. */
export async function cleanupRunOwnedAnthropicApiKeyHelper(
  run: AnthropicApiKeyHelperRunOwner,
  cleanupMaterial: AnthropicApiKeyHelperMaterialCleanup = (input) =>
    cleanupAnthropicTeamApiKeyHelperMaterial(input)
): Promise<void> {
  if (run.anthropicApiKeyHelperCleanupPromise) {
    await run.anthropicApiKeyHelperCleanupPromise;
    return;
  }

  const material = run.anthropicApiKeyHelper;
  if (!material) {
    return;
  }

  const cleanupPromise = Promise.resolve()
    .then(() => cleanupMaterial({ directory: material.directory }))
    .then(() => undefined);
  run.anthropicApiKeyHelperCleanupPromise = cleanupPromise;
  try {
    await cleanupPromise;
    if (run.anthropicApiKeyHelper === material) {
      run.anthropicApiKeyHelper = null;
    }
  } finally {
    if (run.anthropicApiKeyHelperCleanupPromise === cleanupPromise) {
      run.anthropicApiKeyHelperCleanupPromise = null;
    }
  }
}

/**
 * Keeps failed helper cleanup owners reachable after a setup/run stack unwinds.
 * A later create/launch for the same team retries cleanup before materializing
 * replacement authentication material.
 */
export function createAnthropicApiKeyHelperCleanupRetryOwner(
  options: AnthropicApiKeyHelperCleanupRetryOwnerOptions = {}
): AnthropicApiKeyHelperCleanupRetryOwner {
  const maxPendingOwners =
    options.maxPendingOwners ?? ANTHROPIC_API_KEY_HELPER_MAX_PENDING_CLEANUP_OWNERS;
  const retryDelaysMs = options.retryDelaysMs ?? ANTHROPIC_API_KEY_HELPER_CLEANUP_RETRY_DELAYS_MS;
  const scheduleTimeout = options.setTimeout ?? setTimeout;
  const cancelTimeout = options.clearTimeout ?? clearTimeout;
  if (
    !Number.isSafeInteger(maxPendingOwners) ||
    maxPendingOwners < 1 ||
    retryDelaysMs.length === 0 ||
    retryDelaysMs.length > ANTHROPIC_API_KEY_HELPER_MAX_AUTOMATIC_CLEANUP_RETRIES ||
    retryDelaysMs.some(
      (delay) => !Number.isSafeInteger(delay) || delay < 0 || delay > 24 * 60 * 60 * 1000
    )
  ) {
    throw new Error('Anthropic helper cleanup retry ownership must be explicitly bounded');
  }

  interface PendingCleanupOwner {
    durableOwner: AnthropicApiKeyHelperDurableCleanupOwner;
    retryIndex: number;
    retryTimer: ReturnType<typeof setTimeout> | null;
    inFlight: Promise<void> | null;
  }

  const pendingOwners = new Map<string, PendingCleanupOwner>();

  const createRetryCleanup = (
    cleanup: () => Promise<void>,
    onReleased?: () => void
  ): (() => Promise<void>) => {
    let released = false;
    let cleanupPromise: Promise<void> | null = null;
    return async () => {
      if (released) {
        return;
      }
      if (cleanupPromise) {
        await cleanupPromise;
        return;
      }
      cleanupPromise = cleanup();
      try {
        await cleanupPromise;
        released = true;
        onReleased?.();
      } finally {
        cleanupPromise = null;
      }
    };
  };

  const scheduleRetry = (key: string, owner: PendingCleanupOwner): void => {
    if (owner.retryTimer || owner.retryIndex >= retryDelaysMs.length) {
      return;
    }
    const delay = retryDelaysMs[owner.retryIndex];
    owner.retryIndex += 1;
    owner.retryTimer = scheduleTimeout(() => {
      owner.retryTimer = null;
      void retryOwner(key, owner).catch(() => undefined);
    }, delay);
    owner.retryTimer.unref?.();
  };

  const retryOwner = async (key: string, owner: PendingCleanupOwner): Promise<void> => {
    if (pendingOwners.get(key) !== owner) {
      return;
    }
    if (owner.inFlight) {
      await owner.inFlight;
      return;
    }
    owner.inFlight = owner.durableOwner.retryCleanup();
    try {
      await owner.inFlight;
      if (pendingOwners.get(key) === owner) {
        pendingOwners.delete(key);
        if (owner.retryTimer) {
          cancelTimeout(owner.retryTimer);
          owner.retryTimer = null;
        }
      }
    } catch (error) {
      scheduleRetry(key, owner);
      throw error;
    } finally {
      owner.inFlight = null;
    }
  };

  const retryAllPendingForOneTurn = async (): Promise<void> => {
    const retryAttempts = [...pendingOwners]
      .filter(([, owner]) => owner.inFlight === null)
      .map(([key, owner]) => retryOwner(key, owner));
    if (retryAttempts.length === 0) {
      return;
    }
    let turnTimer: ReturnType<typeof setTimeout> | null = null;
    const nextTurn = new Promise<void>((resolve) => {
      turnTimer = scheduleTimeout(resolve, 0);
      turnTimer.unref?.();
    });
    try {
      await Promise.race([Promise.allSettled(retryAttempts), nextTurn]);
    } finally {
      if (turnTimer) {
        cancelTimeout(turnTimer);
      }
    }
  };

  const retain = async (
    key: string,
    owner: PendingCleanupOwner
  ): Promise<AnthropicApiKeyHelperCleanupRetentionResult> => {
    if (pendingOwners.has(key)) {
      return { kind: 'retained' };
    }
    if (pendingOwners.size >= maxPendingOwners) {
      // Sweep every retained owner independently, but wait no longer than one
      // event-loop turn. A cleanup that never settles must not hold another
      // team's retain decision hostage. If the map remains full, return the
      // exact new owner instead of growing an overflow collection. Production
      // orchestration turns this into a reachable, ownership-carrying rejection.
      await retryAllPendingForOneTurn();
      if (pendingOwners.has(key)) {
        return { kind: 'retained' };
      }
      if (pendingOwners.size >= maxPendingOwners) {
        return { kind: 'source-owned', owner: owner.durableOwner, maxPendingOwners };
      }
    }
    pendingOwners.set(key, owner);
    scheduleRetry(key, owner);
    return { kind: 'retained' };
  };

  return {
    async retainSetupLease(lease) {
      const material = lease.getOwnedMaterial();
      if (!material) {
        return { kind: 'retained' };
      }
      const durableOwner: AnthropicApiKeyHelperDurableSetupCleanupOwner = {
        kind: 'setup',
        teamName: material.teamName,
        directory: material.directory,
        lease,
        retryCleanup: createRetryCleanup(() => lease.cleanup()),
      };
      return retain(`setup:${material.directory}`, {
        durableOwner,
        retryIndex: 0,
        retryTimer: null,
        inFlight: null,
      });
    },

    async retainRunOwner(run, retainedOptions = {}) {
      const material = run.anthropicApiKeyHelper;
      if (!material) {
        return { kind: 'retained' };
      }
      const durableOwner: AnthropicApiKeyHelperDurableRunCleanupOwner = {
        kind: 'run',
        teamName: material.teamName,
        directory: material.directory,
        run,
        retryCleanup: createRetryCleanup(async () => {
          await retainedOptions.beforeCleanup?.();
          if (retainedOptions.cleanup) {
            await retainedOptions.cleanup();
          } else {
            await cleanupRunOwnedAnthropicApiKeyHelper(run);
          }
        }, retainedOptions.onReleased),
      };
      return retain(`run:${material.directory}`, {
        durableOwner,
        retryIndex: 0,
        retryTimer: null,
        inFlight: null,
      });
    },

    async retryPendingForTeam(teamName) {
      const failures: unknown[] = [];
      for (const [key, owner] of [...pendingOwners]) {
        if (owner.durableOwner.teamName !== teamName) {
          continue;
        }
        try {
          await retryOwner(key, owner);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `Failed to retry ${failures.length} Anthropic API-key helper cleanup owner(s)`
        );
      }
    },

    hasPendingForTeam(teamName) {
      return [...pendingOwners.values()].some((owner) => owner.durableOwner.teamName === teamName);
    },

    getPendingOwnerCount() {
      return pendingOwners.size;
    },
  };
}
