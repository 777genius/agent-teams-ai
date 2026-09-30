import { randomUUID } from 'node:crypto';

import type { HostedCoordinationEventStreamIdentityFactory } from '@features/coordination-events/main';

export const hostedCoordinationEventStreamIdentityFactory = Object.freeze({
  createStreamId: randomUUID,
}) satisfies HostedCoordinationEventStreamIdentityFactory;
