import type { TeamProvisioningPrepareResult } from '@shared/types/team';

interface Check {
  identity: string;
  superseded: boolean;
  settled: Promise<TeamProvisioningPrepareResult>;
}

/** Latest foreground draft waits for the previous original probe's cleanup. No outcomes are stored. */
export class ForegroundModelChecks {
  private active?: Check;

  run(
    identity: string,
    action: (isLatest: () => boolean) => Promise<TeamProvisioningPrepareResult>
  ): Promise<TeamProvisioningPrepareResult> {
    const previous = this.active;
    if (previous?.identity === identity && !previous.superseded) return previous.settled;
    if (previous) previous.superseded = true;
    const check: Check = {
      identity,
      superseded: false,
      settled: Promise.resolve({ ready: false, message: 'Superseded model check.' }),
    };
    this.active = check;
    check.settled = (async () => {
      try {
        // Cleanup belongs to the previous action's finally and completes before admission.
        if (previous) await previous.settled.catch(() => undefined);
        if (check.superseded) return { ready: false, message: 'Superseded model check.' };
        return await action(() => !check.superseded && this.active === check);
      } finally {
        if (this.active === check) this.active = undefined;
      }
    })();
    return check.settled;
  }
}
