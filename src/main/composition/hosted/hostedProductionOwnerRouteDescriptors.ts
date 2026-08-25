// eslint-disable-next-line no-restricted-imports -- Main composition owns bounded production route admission.
import { HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS } from '@features/team-approvals/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Main composition owns bounded production route admission.
import { HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS } from '@features/team-lifecycle/main/hosted';

import type { HostedLifecycleProductionOwnerAdmission } from './hostedLifecycleProductionOwnerAdmission';
import type { RouteDescriptor } from './routing';

export function hostedProductionOwnerRouteDescriptors(
  admission: HostedLifecycleProductionOwnerAdmission | null
): readonly RouteDescriptor[] {
  if (admission === null) return Object.freeze([]);
  return Object.freeze([
    ...HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS,
    ...(admission.approvalRoutes.length === 0 ? [] : HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS),
  ]);
}
