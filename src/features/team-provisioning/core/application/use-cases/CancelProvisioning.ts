import type { TeamProvisioningCancellationPort } from '../ports/TeamProvisioningPorts';

export class CancelProvisioning {
  constructor(private readonly cancellation: TeamProvisioningCancellationPort) {}

  execute(runId: string): Promise<void> {
    return this.cancellation.cancel(runId);
  }
}
