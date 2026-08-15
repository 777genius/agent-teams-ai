import type {
  AnthropicApiKeyHelperCleanupRetentionResult,
  AnthropicApiKeyHelperCleanupRetryOwner,
  AnthropicApiKeyHelperDurableCleanupOwner,
  AnthropicApiKeyHelperRunOwner,
} from './TeamProvisioningAnthropicApiKeyHelperLease';
import type { ChildProcess } from 'child_process';

export interface TeamProvisioningAuthRetryCleanupOwnerRun extends AnthropicApiKeyHelperRunOwner {
  runId: string;
  teamName: string;
  child: ChildProcess | null;
  authRetryCleanupSourceOwner?: AnthropicApiKeyHelperDurableCleanupOwner | null;
  authRetryCleanupSourceRetryIndex?: number;
  authRetryCleanupSourceRetryTimer?: NodeJS.Timeout | null;
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

export async function retainAuthRetryCleanupOwnership<
  TRun extends TeamProvisioningAuthRetryCleanupOwnerRun,
>(input: {
  run: TRun;
  child: ChildProcess | null;
  terminationConfirmed: boolean;
  ports: TeamProvisioningAuthRetryCleanupOwnershipPorts<TRun>;
}): Promise<AnthropicApiKeyHelperCleanupRetentionResult> {
  const { run, child, ports } = input;
  let terminationConfirmed = input.terminationConfirmed;
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
      await ports.handleProcessExit(run, null);
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
    run.authRetryCleanupSourceOwner = retention.owner;
    run.authRetryCleanupSourceRetryIndex = 0;
    scheduleSourceOwnedCleanupRetry(run);
  }
  return retention;
}

function scheduleSourceOwnedCleanupRetry<TRun extends TeamProvisioningAuthRetryCleanupOwnerRun>(
  run: TRun
): void {
  if (run.authRetryCleanupSourceRetryTimer || !run.authRetryCleanupSourceOwner) return;
  const retryIndex = run.authRetryCleanupSourceRetryIndex ?? 0;
  if (retryIndex >= AUTH_RETRY_SOURCE_OWNED_CLEANUP_RETRY_DELAYS_MS.length) return;
  run.authRetryCleanupSourceRetryIndex = retryIndex + 1;
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
  }, AUTH_RETRY_SOURCE_OWNED_CLEANUP_RETRY_DELAYS_MS[retryIndex]);
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
}): Promise<'released' | 'retained'> {
  const { run, child, ports } = input;
  let terminationConfirmed = input.terminationConfirmed;
  try {
    if (child && !terminationConfirmed) {
      await ports.killTeamProcessAndWait(child);
      terminationConfirmed = true;
    }
    await ports.cleanupRunOwnedAnthropicApiKeyHelper(run);
  } catch {
    await retainAuthRetryCleanupOwnership({ run, child, terminationConfirmed, ports });
    return 'retained';
  }

  if (!child || run.child === child) {
    run.child = null;
  }
  return 'released';
}
