import { HOSTED_AUTH_HEADERS, type HostedRole } from '../../../../contracts';
import { roleAllows } from '../../../../core/domain';

import type { HostedHttpReply, HostedHttpRequest } from '../../../../core/domain';

function successful(reply: HostedHttpReply): boolean {
  const statusCode = Reflect.get(reply, 'statusCode');
  return Number.isSafeInteger(statusCode) && statusCode < 400;
}

function advertisesTaskBoardMutations(
  reply: HostedHttpReply,
  role: HostedRole,
  routeEnabled: boolean
): boolean {
  try {
    return routeEnabled && successful(reply) && roleAllows(role, 'hosted.command');
  } catch {
    return false;
  }
}

function advertisesTeamMessageSend(
  request: HostedHttpRequest,
  reply: HostedHttpReply,
  role: HostedRole,
  routeEnabled: boolean
): boolean {
  try {
    return (
      routeEnabled &&
      request.method === 'POST' &&
      request.url.split('?', 1)[0] === '/api/hosted/v1/team-messages/page' &&
      successful(reply) &&
      roleAllows(role, 'hosted.command')
    );
  } catch {
    return false;
  }
}

export function applyHostedCapabilityAdvertisements(
  request: HostedHttpRequest,
  reply: HostedHttpReply,
  role: HostedRole,
  taskBoardMutationRouteEnabled: boolean,
  teamMessageSendRouteEnabled: boolean
): void {
  if (advertisesTaskBoardMutations(reply, role, taskBoardMutationRouteEnabled)) {
    reply.header(HOSTED_AUTH_HEADERS.taskBoardMutationAdvertisement, 'enabled');
  }
  if (advertisesTeamMessageSend(request, reply, role, teamMessageSendRouteEnabled)) {
    reply.header(HOSTED_AUTH_HEADERS.teamMessageSendAdvertisement, 'enabled');
  }
}
