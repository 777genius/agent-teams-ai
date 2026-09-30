import { drainTeamLifecycle, type LifecycleDrainDependencies } from './StopTeam';

import type { CancelProvisioningRequest, CancelProvisioningResult } from '../../contracts';
import type { TeamLifecycleCommandContext } from './ports/TeamLifecycleCommandPorts';

export class CancelProvisioning {
  constructor(private readonly dependencies: LifecycleDrainDependencies) {}

  async execute(
    request: CancelProvisioningRequest,
    context: TeamLifecycleCommandContext
  ): Promise<CancelProvisioningResult> {
    return await drainTeamLifecycle(this.dependencies, request, context, 'cancel');
  }
}
