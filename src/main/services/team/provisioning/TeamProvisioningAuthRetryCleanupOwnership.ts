import type {
  AnthropicApiKeyHelperCleanupRetentionResult,
  AnthropicApiKeyHelperCleanupRetryOwner,
  AnthropicApiKeyHelperDurableCleanupOwner,
  AnthropicApiKeyHelperRunOwner,
} from './TeamProvisioningAnthropicApiKeyHelperLease';
import type { ChildProcess } from 'child_process';

export interface TeamProvisioningCleanupSourceOwnerRun {
  authRetryCleanupSourceOwner?: AnthropicApiKeyHelperDurableCleanupOwner | null;
  authRetryCleanupSourceRetryIndex?: number;
  authRetryCleanupSourceRetryTimer?: NodeJS.Timeout | null;
}

export interface TeamProvisioningAuthRetryCleanupOwnerRun
  extends AnthropicApiKeyHelperRunOwner, TeamProvisioningCleanupSourceOwnerRun {
  runId: string;
  teamName: string;
  child: ChildProcess | null;
}

const AUTH_RETRY_SOURCE_OWNED_CLEANUP_RETRY_DELAYS_MS = [
  1_000, 5_000, 30_000, 120_000, 300_000,
] as const;

export interface TeamProvisioningAuthRetryCleanupOwnershipPorts<
  TRun extends TeamProvisioningAuthRetryCleanupOwnerRun,
> {
  killTeamProcessAndWait(child: ChildProcess | null): Promise<void>;
  handleProcessExit(run: TRun, code: number | null): Promise<void>;
  cleanupRunOwnedAnthropicApiKeyHelper(run: TRun): Promise<void>;
  retainAnthropicApiKeyHelperCleanupRetryOwner: AnthropicApiKeyHelperCleanupRetryOwner['retainRunOwner'];
  cleanupRun(run: TRun): void;
}

export type TeamProvisioningCleanupOwnershipTransferResult =
  | { kind: 'released' }
  | { kind: 'retained' };

export async function retainAuthRetryCleanupOwnership<
  TRun extends TeamProvisioningAuthRetryCleanupOwnerRun,
>(input: {
  run: TRun;
  child: ChildProcess | null;
  terminationConfirmed: boolean;
  revocationConfirmed: boolean;
  ports: TeamProvisioningAuthRetryCleanupOwnershipPorts<TRun>;
}): Promise<AnthropicApiKeyHelperCleanupRetentionResult> {
  const { run, child, ports } = input;
  let terminationConfirmed = input.terminationConfirmed;
  let revocationConfirmed = input.revocationConfirmed;
  const retention = await ports.retainAnthropicApiKeyHelperCleanupRetryOwner(run, {
    ownerIdentity: {
      teamName: run.teamName,
      ownerKey: `auth-retry:${run.runId}`,
    },
    beforeCleanup: async () => {
      if (child && !terminationConfirmed) {
        await ports.killTeamProcessAndWait(child);
        terminationConfirmed = true;
      }
      if (!revocationConfirmed) {
        await ports.handleProcessExit(run, null);
        revocationConfirmed = true;
      }
    },
    cleanup: () => ports.cleanupRunOwnedAnthropicApiKeyHelper(run),
    onReleased: () => {
      if (!child || run.child === child) {
        run.child = null;
      }
      ports.cleanupRun(run);
    },
  });
  if (retention.kind === 'source-owned') {
    retainSourceOwnedCleanupOwner(run, retention.owner);
  }
  return retention;
}

export function retainSourceOwnedCleanupOwner<
  TRun extends TeamProvisioningCleanupSourceOwnerRun,
>(run: TRun, owner: AnthropicApiKeyHelperDurableCleanupOwner): void {
  run.authRetryCleanupSourceOwner = owner;
  run.authRetryCleanupSourceRetryIndex = 0;
  scheduleSourceOwnedCleanupRetry(run);
}

function scheduleSourceOwnedCleanupRetry<TRun extends TeamProvisioningCleanupSourceOwnerRun>(
  run: TRun
): void {
  if (run.authRetryCleanupSourceRetryTimer || !run.authRetryCleanupSourceOwner) return;
  const retryIndex = run.authRetryCleanupSourceRetryIndex ?? 0;
  // Capacity overflow leaves the exact owner on the tracked run. Once the
  // bounded backoff is consumed, rearm one unref'ed timer at its terminal
  // cadence so cleanup cannot become permanently inert.
  const delay =
    AUTH_RETRY_SOURCE_OWNED_CLEANUP_RETRY_DELAYS_MS[
      Math.min(retryIndex, AUTH_RETRY_SOURCE_OWNED_CLEANUP_RETRY_DELAYS_MS.length - 1)
    ];
  run.authRetryCleanupSourceRetryIndex = Math.min(
    retryIndex + 1,
    AUTH_RETRY_SOURCE_OWNED_CLEANUP_RETRY_DELAYS_MS.length
  );
  run.authRetryCleanupSourceRetryTimer = setTimeout(() => {
    run.authRetryCleanupSourceRetryTimer = null;
    const owner = run.authRetryCleanupSourceOwner;
    if (!owner) return;
    void owner.retryCleanup().then(
      () => {
        if (run.authRetryCleanupSourceOwner === owner) {
          run.authRetryCleanupSourceOwner = null;
          run.authRetryCleanupSourceRetryIndex = 0;
        }
      },
      () => scheduleSourceOwnedCleanupRetry(run)
    );
  }, delay);
  run.authRetryCleanupSourceRetryTimer.unref?.();
}

/**
 * Releases a failed auth-retry run only after the old process tree and helper
 * are both confirmed gone. A failure transfers the exact run owner into the
 * bounded provisioning retry owner before terminal progress can be published.
 */
export async function finalizeAuthRetryCleanupOwnership<
  TRun extends TeamProvisioningAuthRetryCleanupOwnerRun,
>(input: {
  run: TRun;
  child: ChildProcess | null;
  terminationConfirmed: boolean;
  ports: TeamProvisioningAuthRetryCleanupOwnershipPorts<TRun>;
}): Promise<TeamProvisioningCleanupOwnershipTransferResult> {
  const { run, child, ports } = input;
  let terminationConfirmed = input.terminationConfirmed;
  try {
    if (child && !terminationConfirmed) {
      await ports.killTeamProcessAndWait(child);
      terminationConfirmed = true;
    }
    await ports.cleanupRunOwnedAnthropicApiKeyHelper(run);
  } catch {
    await retainAuthRetryCleanupOwnership({
      run,
      child,
      terminationConfirmed,
      revocationConfirmed: true,
      ports,
    });
    return { kind: 'retained' };
  }

  if (!child || run.child === child) {
    run.child = null;
  }
  return { kind: 'released' };
}
