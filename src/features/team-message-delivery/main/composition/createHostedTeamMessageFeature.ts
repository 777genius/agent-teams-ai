import { GetHostedMessagePage } from '../../core/application/use-cases/GetHostedMessagePage';
import { SendHostedTeamMessage } from '../../core/application/use-cases/SendHostedTeamMessage';
import { HOSTED_TEAM_MESSAGE_ROUTE_DESCRIPTORS } from '../adapters/input/http/hostedTeamMessageRoutes';

import type {
  HostedMessageClockPort,
  HostedMessagePageSourcePort,
  HostedTeamMessagePersistencePort,
  HostedTeamMessageRuntimeDeliveryPort,
} from '../../core/application/ports/HostedTeamMessagePorts';
import type { HostedTeamMessageHttpFacade } from '../adapters/input/http/registerHostedTeamMessageHttp';

export interface HostedTeamMessageFeature extends HostedTeamMessageHttpFacade {
  readonly routes: typeof HOSTED_TEAM_MESSAGE_ROUTE_DESCRIPTORS;
}

export function createHostedTeamMessageFeature(dependencies: {
  readonly pageSource: HostedMessagePageSourcePort;
  readonly persistence: HostedTeamMessagePersistencePort;
  readonly runtimeDelivery: HostedTeamMessageRuntimeDeliveryPort;
  readonly clock?: HostedMessageClockPort;
}): HostedTeamMessageFeature {
  const clock = dependencies.clock ?? Object.freeze({ now: Date.now });
  const getPage = new GetHostedMessagePage(dependencies.pageSource, clock);
  const sendMessage = new SendHostedTeamMessage(
    dependencies.persistence,
    dependencies.runtimeDelivery
  );
  return Object.freeze({
    routes: HOSTED_TEAM_MESSAGE_ROUTE_DESCRIPTORS,
    getPage: getPage.execute.bind(getPage),
    sendMessage: sendMessage.execute.bind(sendMessage),
  });
}
