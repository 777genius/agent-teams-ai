import { TEAM_GET_RUNTIME_DELIVERY_STATUS } from '../channels';

import type { RuntimeDeliveryStatus } from '../runtime-delivery';
import type { OpenCodeRuntimeDeliveryStatus as LegacyOpenCodeRuntimeDeliveryStatus } from '@shared/types';
import type { TeamProviderId } from '@shared/types';

export const TEAM_GET_OPENCODE_RUNTIME_DELIVERY_STATUS = TEAM_GET_RUNTIME_DELIVERY_STATUS;

export type OpenCodeRuntimeDeliveryStatus = LegacyOpenCodeRuntimeDeliveryStatus;

export function toRuntimeDeliveryStatus(
  status: OpenCodeRuntimeDeliveryStatus
): RuntimeDeliveryStatus {
  return status;
}

export function toOpenCodeRuntimeDeliveryStatus(
  status: RuntimeDeliveryStatus
): OpenCodeRuntimeDeliveryStatus {
  if (status.providerId !== 'opencode') {
    throw new Error(`Expected OpenCode runtime delivery status, received ${status.providerId}`);
  }
  return status as RuntimeDeliveryStatus & { providerId: 'opencode' };
}

export interface LegacyRuntimeRecipientResolver {
  resolveRuntimeRecipientProviderId(
    teamName: string,
    memberName: string
  ): Promise<TeamProviderId | undefined>;
}

export async function requiresRuntimeDeliveryFromLegacyResolver(
  resolver: LegacyRuntimeRecipientResolver,
  teamName: string,
  memberName: string
): Promise<boolean> {
  return (await resolver.resolveRuntimeRecipientProviderId(teamName, memberName)) === 'opencode';
}
