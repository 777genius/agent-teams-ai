// eslint-disable-next-line no-restricted-imports -- Main composition owns bounded production route admission.
import { HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS } from '@features/team-approvals/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Main composition owns bounded production route admission.
import { HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS } from '@features/team-lifecycle/main/hosted';

import { HOSTED_RUNTIME_CREATING_LIFECYCLE_ACTIONS } from './hostedRuntimeCreationAdmission';

import type { HostedLifecycleProductionOwnerAdmission } from './hostedLifecycleProductionOwnerAdmission';
import type { RouteDescriptor } from './routing';
import type { HostedAuthMode } from '@features/hosted-access';

const PERSONAL_ONLY_LIFECYCLE_ROUTE_IDS: ReadonlySet<string> = new Set(
  HOSTED_RUNTIME_CREATING_LIFECYCLE_ACTIONS.map((action) => `team-lifecycle.${action}.v1`)
);

/**
 * Runtime-creating lifecycle routes are cataloged only for the personal trusted_process operator;
 * under OIDC their handlers find no admitted route and answer the typed lifecycle `unavailable`.
 */
export function hostedProductionOwnerRouteDescriptors(
  admission: HostedLifecycleProductionOwnerAdmission | null,
  authMode: HostedAuthMode
): readonly RouteDescriptor[] {
  if (admission === null) return Object.freeze([]);
  return Object.freeze([
    ...(authMode === 'personal'
      ? HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS
      : HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS.filter(
          (descriptor) => !PERSONAL_ONLY_LIFECYCLE_ROUTE_IDS.has(descriptor.id)
        )),
    ...(admission.approvalRoutes.length === 0 ? [] : HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS),
  ]);
}
