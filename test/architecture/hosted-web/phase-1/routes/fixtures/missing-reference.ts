import { validRoute } from './duplicate-route';

import type { RouteDescriptor } from '@main/composition/hosted/routing';

export const missingHandlerReference = Object.freeze({
  ...validRoute,
  handlerId: undefined,
}) as unknown as RouteDescriptor;
