import { registerMemberWorkSyncHttpAdapter } from '../adapters/input/registerMemberWorkSyncHttp';

import type { MemberWorkSyncFeatureFacade } from './createMemberWorkSyncFeature';
import type { MemberWorkSyncHttpHostPorts } from './memberWorkSyncHttpPorts';
import type { FastifyInstance } from 'fastify';

export function registerMemberWorkSyncHttp(
  app: FastifyInstance,
  feature: MemberWorkSyncFeatureFacade | undefined,
  host: MemberWorkSyncHttpHostPorts
): void {
  registerMemberWorkSyncHttpAdapter(app, feature, host);
}
