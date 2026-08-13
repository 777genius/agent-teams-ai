import {
  HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
  type HostedLifecycleProgressResult,
  parseHostedLifecycleProgressRequest,
  parseHostedLifecycleProvisioningStatus,
} from '../../contracts/hosted-lifecycle-commands';

import type { HostedLifecycleCommandGatewayPort } from './ports/HostedLifecycleCommandGatewayPort';
import type { QueryContext } from '@shared/contracts/hosted';

const unavailable = (): HostedLifecycleProgressResult =>
  Object.freeze({
    schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
    kind: 'unavailable',
    retryAfterMs: null,
  });

export class GetHostedProvisioningStatus {
  constructor(
    private readonly gateway: HostedLifecycleCommandGatewayPort,
    private readonly now: () => number = Date.now
  ) {}

  async execute(body: unknown, context: QueryContext): Promise<HostedLifecycleProgressResult> {
    try {
      const request = parseHostedLifecycleProgressRequest(body);
      if (!request.ok || context.signal.aborted || this.now() >= context.deadlineAtMs) {
        return unavailable();
      }
      const getStatus = this.gateway.getProvisioningStatus;
      if (getStatus === undefined) return unavailable();
      const result = await getStatus.call(this.gateway, request.value, context);
      if (context.signal.aborted || this.now() >= context.deadlineAtMs) return unavailable();
      if (result.kind !== 'provisioning_status') {
        return result.kind === 'not_found' || result.kind === 'unavailable'
          ? result
          : unavailable();
      }
      const parsed = parseHostedLifecycleProvisioningStatus(result);
      return parsed.ok &&
        parsed.value.workspaceId === request.value.workspaceId &&
        parsed.value.teamId === request.value.teamId &&
        parsed.value.deploymentId === context.deploymentId &&
        parsed.value.bootId === context.bootId
        ? parsed.value
        : unavailable();
    } catch {
      return unavailable();
    }
  }
}
