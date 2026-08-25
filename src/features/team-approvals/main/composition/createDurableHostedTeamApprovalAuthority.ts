import { InternalStorageHostedTeamApprovalAuthority } from '../adapters/output/InternalStorageHostedTeamApprovalAuthority';

import { createHostedTeamApprovalOutputAdapters } from './createHostedTeamApprovalOutputAdapters';

import type { InternalStorageHostedTeamApprovalAuthorityDependencies } from '../adapters/output/InternalStorageHostedTeamApprovalAuthority';
import type { HostedTeamApprovalAuthorityPort } from '../ports/HostedTeamApprovalAuthorityPort';
import type {
  HostedTeamApprovalDeliveryOutboxPort,
  HostedTeamApprovalPendingIngressPort,
} from '../ports/HostedTeamApprovalAuthorityStoragePort';
import type { HostedTeamApprovalOutputAdapters } from './createHostedTeamApprovalOutputAdapters';

export interface DurableHostedTeamApprovalAuthority {
  readonly authority: HostedTeamApprovalAuthorityPort;
  readonly ingress: HostedTeamApprovalPendingIngressPort;
  readonly deliveryOutbox: HostedTeamApprovalDeliveryOutboxPort;
  readonly outputAdapters: HostedTeamApprovalOutputAdapters;
}

/**
 * Builds the durable authority boundary without mounting it in Electron or
 * creating a runtime. The external lifecycle owner receives ingress/outbox
 * ports explicitly from its own composition.
 */
export function createDurableHostedTeamApprovalAuthority(
  dependencies: InternalStorageHostedTeamApprovalAuthorityDependencies
): DurableHostedTeamApprovalAuthority {
  const authority = new InternalStorageHostedTeamApprovalAuthority(dependencies);
  return Object.freeze({
    authority,
    ingress: authority,
    deliveryOutbox: authority,
    outputAdapters: createHostedTeamApprovalOutputAdapters(authority, dependencies.clock),
  });
}
