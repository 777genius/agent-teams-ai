import type { TeamMessageTransportPort } from '../ports/TeamMessageDeliveryPorts';

export class SendTeamProcessMessageUseCase {
  constructor(private readonly messaging: Pick<TeamMessageTransportPort, 'sendMessageToTeam'>) {}

  execute(teamName: string, message: string): Promise<void> {
    return this.messaging.sendMessageToTeam(teamName, message);
  }
}
