import {
  HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
  type HostedLifecycleControlStateResult,
  parseHostedLifecycleControlState,
  parseHostedLifecycleControlStateRequest,
} from '../../contracts/hosted-lifecycle-commands';

import {
  hostedLifecycleDiagnosticCode,
  type HostedLifecycleDiagnosticReporter,
  reportHostedLifecycleDiagnostic,
} from './hostedLifecycleDiagnostics';

import type { HostedLifecycleCommandGatewayPort } from './ports/HostedLifecycleCommandGatewayPort';
import type { QueryContext } from '@shared/contracts/hosted';

const invalidRequest = (): HostedLifecycleControlStateResult =>
  Object.freeze({
    schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
    kind: 'invalid_request',
  });

const unavailable = (): HostedLifecycleControlStateResult =>
  Object.freeze({
    schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
    kind: 'unavailable',
    retryAfterMs: null,
  });

/** Queries the one external authority; it never derives run identity from local or browser state. */
export class GetHostedLifecycleControlState {
  constructor(
    private readonly gateway: HostedLifecycleCommandGatewayPort,
    private readonly now: () => number = Date.now,
    private readonly report?: HostedLifecycleDiagnosticReporter
  ) {}

  async execute(value: unknown, context: QueryContext): Promise<HostedLifecycleControlStateResult> {
    const request = parseHostedLifecycleControlStateRequest(value);
    if (!request.ok) return invalidRequest();
    try {
      const now = this.now();
      if (
        context.signal.aborted ||
        !Number.isSafeInteger(now) ||
        now < 0 ||
        now >= context.deadlineAtMs
      ) {
        return this.unavailable('deadline-before-owner');
      }
      const result = await this.gateway.getControlState(request.value, context);
      if (context.signal.aborted || this.now() >= context.deadlineAtMs) {
        return this.unavailable('deadline-after-owner');
      }
      if (result.kind === 'control_state') {
        const parsed = parseHostedLifecycleControlState(result, {
          ...request.value,
          deploymentId: context.deploymentId,
          bootId: context.bootId,
        });
        return parsed.ok ? parsed.value : this.unavailable('owner-state-scope-invalid');
      }
      if (result.kind === 'not_found') {
        reportHostedLifecycleDiagnostic(this.report, 'control-state', 'owner-not-found');
        return Object.freeze({
          schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
          kind: 'not_found',
        });
      }
      if (result.kind === 'unavailable') {
        reportHostedLifecycleDiagnostic(this.report, 'control-state', 'owner-unavailable');
        return result;
      }
      return this.unavailable('owner-result-unrecognized');
    } catch (error) {
      return this.unavailable(hostedLifecycleDiagnosticCode(error));
    }
  }

  private unavailable(code: string): HostedLifecycleControlStateResult {
    reportHostedLifecycleDiagnostic(this.report, 'control-state', code);
    return unavailable();
  }
}
