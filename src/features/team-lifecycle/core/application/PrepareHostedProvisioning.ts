import {
  HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
  type HostedLifecyclePrepareResult,
  parseHostedLifecyclePreparedState,
  parseHostedLifecyclePrepareRequest,
} from '../../contracts/hosted-lifecycle-commands';

import type { HostedLifecycleCommandGatewayPort } from './ports/HostedLifecycleCommandGatewayPort';
import type { QueryContext } from '@shared/contracts/hosted';

const unavailable = (): HostedLifecyclePrepareResult =>
  Object.freeze({
    schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
    kind: 'unavailable',
    retryAfterMs: null,
  });

export class PrepareHostedProvisioning {
  constructor(
    private readonly gateway: HostedLifecycleCommandGatewayPort,
    private readonly now: () => number = Date.now
  ) {}

  async execute(body: unknown, context: QueryContext): Promise<HostedLifecyclePrepareResult> {
    try {
      const request = parseHostedLifecyclePrepareRequest(body);
      if (!request.ok || context.signal.aborted || this.now() >= context.deadlineAtMs) {
        return unavailable();
      }
      const prepare = this.gateway.prepareProvisioning;
      if (prepare === undefined) return unavailable();
      const result = await prepare.call(this.gateway, request.value, context);
      if (context.signal.aborted || this.now() >= context.deadlineAtMs) return unavailable();
      if (result.kind !== 'prepared') {
        return result.kind === 'not_found' || result.kind === 'unavailable'
          ? result
          : unavailable();
      }
      const parsed = parseHostedLifecyclePreparedState(result);
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
