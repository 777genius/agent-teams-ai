import { validRoute } from './duplicate-route';

import type { CapabilityDescriptor, RouteDescriptor } from '@main/composition/hosted/routing';

export const testOnlyRoute: RouteDescriptor = validRoute;

export const validCapability = Object.freeze({
  id: 'team-lifecycle.list.capability.v1',
  actionId: 'team.lifecycle.list',
  facetId: 'team-read',
  owner: 'team-lifecycle',
  productionSupport: 'absent',
} satisfies CapabilityDescriptor);

export const productionSupportedCapability = Object.freeze({
  ...validCapability,
  productionSupport: 'supported',
}) as unknown as CapabilityDescriptor;
