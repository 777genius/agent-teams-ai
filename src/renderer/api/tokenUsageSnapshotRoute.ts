import { TOKEN_USAGE_SNAPSHOT_ROUTE, type TokenUsageSnapshotRequest } from '@features/token-usage/contracts';

export function buildTokenUsageSnapshotRoute(request?: TokenUsageSnapshotRequest): string {
  const query = new URLSearchParams();
  if (request?.teamIds !== undefined) {
    for (const teamId of request.teamIds) query.append('teamIds', teamId);
  } else {
    if (request?.teamName) query.set('teamName', request.teamName);
    for (const teamName of request?.teamNames ?? []) query.append('teamNames', teamName);
  }
  if (request?.agentId) query.set('agentId', request.agentId);
  if (request?.commandId) query.set('commandId', request.commandId);
  if (request?.commandInvocationId) {
    query.set('commandInvocationId', request.commandInvocationId);
  }
  if (request?.nativeSessionId) query.set('nativeSessionId', request.nativeSessionId);
  if (request?.from) query.set('from', request.from);
  if (request?.to) query.set('to', request.to);
  const suffix = query.toString();
  return suffix ? `${TOKEN_USAGE_SNAPSHOT_ROUTE}?${suffix}` : TOKEN_USAGE_SNAPSHOT_ROUTE;
}
