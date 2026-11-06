import { readMemberActions, readMemberActionView } from '../../../contracts/memberActions';

import type { BackendMemberActionPayloads } from '../../../contracts/memberActions';
import type { BackendOperationRequest } from '../../../contracts/operations';
export function isMemberActionRequest(
  request: BackendOperationRequest
): request is Extract<BackendOperationRequest, { operation: keyof BackendMemberActionPayloads }> {
  return request.operation.startsWith('team.member.action');
}
/** Strict finite projection; no private ExpectedLaunchMember recipe can cross this route. */
export function projectMemberActionResult(raw: unknown, request: BackendOperationRequest) {
  if (!request.operation.startsWith('team.member.action'))
    throw new Error('Wrong member action operation');
  const expected = request.payload as {
    launchId: string;
    memberId: string;
    originalCommandId?: string;
    rosterRevision?: string;
    expectedGeneration?: string | null;
    action?: 'restart' | 'skip';
  };
  if (request.operation === 'team.member.actions.read') {
    const value = readMemberActions(raw);
    if (value.launchId !== expected.launchId || value.memberId !== expected.memberId)
      throw new Error('Wrong member action scope');
    return value;
  }
  if (raw === null && request.operation === 'team.member.action.lookup') return null;
  const value = readMemberActionView(raw);
  if (
    value.launchId !== expected.launchId ||
    value.memberId !== expected.memberId ||
    value.commandId !== (expected.originalCommandId ?? request.commandId) ||
    (request.operation !== 'team.member.action.lookup' &&
      (value.action !== expected.action ||
        value.sourceGeneration !== expected.expectedGeneration ||
        value.rosterRevision !== expected.rosterRevision))
  )
    throw new Error('Wrong original member action');
  return value;
}
