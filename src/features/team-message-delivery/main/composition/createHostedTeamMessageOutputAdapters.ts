import { HostedTeamMessageAuthorityAdapter } from '../adapters/output/HostedTeamMessageAuthorityAdapter';

import type {
  HostedMessagePageSourcePort,
  HostedTeamMessagePersistencePort,
  HostedTeamMessageRuntimeDeliveryPort,
} from '../../core/application/ports/HostedTeamMessagePorts';
import type { HostedTeamMessageAuthorityPort } from '../ports/HostedTeamMessageAuthorityPort';

export interface HostedTeamMessageOutputAdapters {
  readonly pageSource: HostedMessagePageSourcePort;
  readonly persistence: HostedTeamMessagePersistencePort;
  readonly runtimeDelivery: HostedTeamMessageRuntimeDeliveryPort;
}

/** Uses one authority adapter instance so reads, persistence, and delivery share the same fence. */
export function createHostedTeamMessageOutputAdapters(
  authority: HostedTeamMessageAuthorityPort
): HostedTeamMessageOutputAdapters {
  const adapter = new HostedTeamMessageAuthorityAdapter(authority);
  return Object.freeze({ pageSource: adapter, persistence: adapter, runtimeDelivery: adapter });
}
