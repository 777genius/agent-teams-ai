import type {
  AnthropicApiKeyHelperCleanupRetentionResult,
  AnthropicApiKeyHelperCleanupRetryOwner,
  AnthropicApiKeyHelperRunOwner,
} from './TeamProvisioningAnthropicApiKeyHelperLease';
import type { ChildProcess } from 'child_process';

export interface TeamProvisioningAuthRetryCleanupOwnerRun extends AnthropicApiKeyHelperRunOwner {
  child: ChildProcess | null;
}

export interface TeamProvisioningAuthRetryCleanupOwnershipPorts<
  TRun extends TeamProvisioningAuthRetryCleanupOwnerRun,
> {
  killTeamProcessAndWait(child: ChildProcess | null): Promise<void>;
  cleanupRunOwnedAnthropicApiKeyHelper(run: TRun): Promise<void>;
  retainAnthropicApiKeyHelperCleanupRetryOwner: AnthropicApiKeyHelperCleanupRetryOwner['retainRunOwner'];
  cleanupRun(run: TRun): void;
}

export function retainAuthRetryCleanupOwnership<
  TRun extends TeamProvisioningAuthRetryCleanupOwnerRun,
>(input: {
  run: TRun;
  child: ChildProcess | null;
  terminationConfirmed: boolean;
  ports: TeamProvisioningAuthRetryCleanupOwnershipPorts<TRun>;
}): Promise<AnthropicApiKeyHelperCleanupRetentionResult> {
  const { run, child, ports } = input;
  let terminationConfirmed = input.terminationConfirmed;
  return ports.retainAnthropicApiKeyHelperCleanupRetryOwner(run, {
    beforeCleanup:
      child && !terminationConfirmed
        ? async () => {
            if (terminationConfirmed) {
              return;
            }
            await ports.killTeamProcessAndWait(child);
            terminationConfirmed = true;
          }
        : undefined,
    cleanup: () => ports.cleanupRunOwnedAnthropicApiKeyHelper(run),
    onReleased: () => {
      if (!child || run.child === child) {
        run.child = null;
      }
      ports.cleanupRun(run);
    },
  });
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
