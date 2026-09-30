import { assertSafeTeamName } from './TeamPermanentDeletionTypes';

/**
 * Cooperative desktop writer contract for this Electron main process:
 * - Routed desktop mutations start a lease or enter the short per-commit
 *   identity fence.
 * - Spawned runs hold a lease until cleanup; detached work enters a new lease or
 *   remains counted by its run owner. Each local commit checks its generation.
 * - Deletion closes admission under the file fence, then drains leases for at
 *   most 30 seconds before it records a prepared intent. Provider I/O never
 *   runs under that file fence.
 * This registry cannot coordinate an external process or make pathname removal
 * identity-bound. Protected quarantine removal therefore remains fail-closed.
 */
export class TeamWriterAuthorityRegistry {
  private readonly deletionClaims = new Map<string, Map<symbol, string>>();
  private readonly activeWorkflows = new Map<string, number>();
  private readonly drainWaiters = new Map<string, Set<() => void>>();
  private readonly admissionClosed = new Map<string, Set<symbol>>();

  constructor(
    private readonly ports: {
      withFence<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
      isFenced(teamName: string): Promise<boolean>;
      hasPreparedIntent(teamName: string): boolean;
    }
  ) {}

  addDeletionClaim(teamName: string, identityId: string): symbol {
    const token = Symbol(teamName);
    const claims = this.deletionClaims.get(teamName) ?? new Map<symbol, string>();
    claims.set(token, identityId);
    this.deletionClaims.set(teamName, claims);
    return token;
  }

  removeDeletionClaim(teamName: string, token: symbol | null): void {
    if (!token) return;
    const claims = this.deletionClaims.get(teamName);
    if (!claims) return;
    claims.delete(token);
    if (claims.size === 0) this.deletionClaims.delete(teamName);
  }

  isIdentityClaimed(teamName: string, identityId: string): boolean {
    return [...(this.deletionClaims.get(teamName)?.values() ?? [])].some(
      (claimedIdentityId) => claimedIdentityId === identityId
    );
  }

  isFencedForWriter(teamName: string): Promise<boolean> {
    return this.admissionClosed.has(teamName) || this.ports.hasPreparedIntent(teamName)
      ? Promise.resolve(true)
      : this.ports.isFenced(teamName);
  }

  /** The lease spans provider startup; the lifecycle lock only protects admission. */
  async withWorkflowLease<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    assertSafeTeamName(teamName);
    await this.ports.withFence(teamName, async () => {
      if (
        this.admissionClosed.has(teamName) ||
        this.ports.hasPreparedIntent(teamName) ||
        (await this.ports.isFenced(teamName))
      ) {
        throw new Error(`operator_required: team writer admission closed: ${teamName}`);
      }
      this.activeWorkflows.set(teamName, (this.activeWorkflows.get(teamName) ?? 0) + 1);
    });
    try {
      return await operation();
    } finally {
      this.releaseWorkflow(teamName);
    }
  }

  /** A run admitted before deletion may finish its already owned work while
   * deletion drains it. The generation check executes inside the short fence;
   * provider I/O remains outside it and the original run lease stays counted. */
  async withRetainedRunLease<T>(
    teamName: string,
    assertGeneration: () => void,
    operation: () => Promise<T>
  ): Promise<T> {
    assertSafeTeamName(teamName);
    await this.ports.withFence(teamName, async () => {
      if ((this.activeWorkflows.get(teamName) ?? 0) === 0) {
        throw new Error(
          `operator_required: provisioning run writer authority expired: ${teamName}`
        );
      }
      assertGeneration();
      this.activeWorkflows.set(teamName, (this.activeWorkflows.get(teamName) ?? 0) + 1);
    });
    try {
      return await operation();
    } finally {
      this.releaseWorkflow(teamName);
    }
  }

  /** Close admission before waiting, so no new provider start can race the boundary. */
  async closeAndDrain(teamName: string): Promise<symbol> {
    const token = Symbol(teamName);
    await this.ports.withFence(teamName, async () => {
      const claims = this.admissionClosed.get(teamName) ?? new Set<symbol>();
      claims.add(token);
      this.admissionClosed.set(teamName, claims);
    });
    if (!this.activeWorkflows.has(teamName)) return token;
    try {
      await new Promise<void>((resolve, reject) => {
        const waiters = this.drainWaiters.get(teamName) ?? new Set<() => void>();
        const notify = (): void => {
          clearTimeout(timeout);
          waiters.delete(notify);
          resolve();
        };
        const timeout = setTimeout(() => {
          waiters.delete(notify);
          if (waiters.size === 0) this.drainWaiters.delete(teamName);
          reject(new Error(`operator_required: team writers did not quiesce: ${teamName}`));
        }, 30_000);
        waiters.add(notify);
        this.drainWaiters.set(teamName, waiters);
      });
    } catch (error) {
      this.reopen(teamName, token);
      throw error;
    }
    return token;
  }

  reopen(teamName: string, token?: symbol): void {
    const claims = this.admissionClosed.get(teamName);
    if (!claims) return;
    if (token) claims.delete(token);
    else claims.clear();
    if (claims.size === 0) this.admissionClosed.delete(teamName);
  }

  private releaseWorkflow(teamName: string): void {
    const remaining = (this.activeWorkflows.get(teamName) ?? 1) - 1;
    if (remaining > 0) {
      this.activeWorkflows.set(teamName, remaining);
    } else {
      this.activeWorkflows.delete(teamName);
      for (const notify of this.drainWaiters.get(teamName) ?? []) notify();
      this.drainWaiters.delete(teamName);
    }
  }
}
