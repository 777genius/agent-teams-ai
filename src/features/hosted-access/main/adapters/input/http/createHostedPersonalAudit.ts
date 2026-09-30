import type { HostedPrincipal } from '../../../../contracts';
import type { HostedHttpRequest } from '../../../../core/domain';
import type { HostedAuthHttpControllerDependencies } from './HostedAuthHttpControllerDependencies';

export type HostedPersonalAudit = (
  request: HostedHttpRequest,
  userId: HostedPrincipal['userId'] | null,
  action:
    | 'auth.personal.pair'
    | 'auth.personal.renew'
    | 'auth.personal.logout'
    | 'auth.personal.forget-device',
  outcome: 'success' | 'denied' | 'failure',
  reason?: string
) => Promise<void>;

export function createHostedPersonalAudit(
  dependencies: Pick<HostedAuthHttpControllerDependencies, 'personal'>
): HostedPersonalAudit {
  return async (request, userId, action, outcome, reason) => {
    try {
      await dependencies.personal?.auditPersonalAuthentication({
        userId,
        action,
        outcome,
        sourceIp: request.ip,
        reason,
      });
    } catch {
      // Never roll back a completed authority transition when its secondary audit append fails.
    }
  };
}
