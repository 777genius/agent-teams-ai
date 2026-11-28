import type { BackendLaunchModelProbe } from '../../../contracts/launch';
import type { BackendOperationRequest } from '../../../contracts/operations';

/** Only application scope and finite model observations cross the Desktop boundary. */
export function projectLaunchModelProbe(
  raw: unknown,
  request: BackendOperationRequest
): BackendLaunchModelProbe | null {
  if (raw === null && request.operation === 'team.launch.probe.read') return null;
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Buffer.byteLength(JSON.stringify(raw)) > 8192 ||
    !request.operation.startsWith('team.launch.probe.') ||
    !('model' in request.payload)
  )
    throw new Error('Invalid launch model probe');
  const value = raw as Record<string, unknown>,
    input = request.payload;
  for (const key of ['launchId', 'rosterRevision', 'memberId', 'model'] as const)
    if (value[key] !== input[key]) throw new Error('Wrong launch model probe');
  if (
    value.commandId !== request.commandId ||
    !['running', 'completed', 'cancelled', 'held'].includes(String(value.phase)) ||
    typeof value.ok !== 'boolean' ||
    (value.ok && value.phase !== 'completed') ||
    !Number.isSafeInteger(value.expiresAt) ||
    Number(value.expiresAt) < 1 ||
    Number(value.expiresAt) > Date.now() + 195000
  )
    throw new Error('Invalid launch model probe');
  const result: BackendLaunchModelProbe = {
    commandId: request.commandId,
    launchId: input.launchId,
    rosterRevision: input.rosterRevision,
    memberId: input.memberId,
    model: input.model,
    ...(input.draft === undefined ? {} : { draft: input.draft }),
    phase: value.phase as BackendLaunchModelProbe['phase'],
    ok: value.ok && Number(value.expiresAt) > Date.now(),
    expiresAt: Number(value.expiresAt),
  };
  if (value.effort !== undefined) {
    if (
      !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(
        String(value.effort)
      )
    )
      throw new Error('Invalid probe effort');
    result.effort = value.effort as BackendLaunchModelProbe['effort'];
  }
  if (value.context !== undefined) {
    if (value.context !== 'model-default' && value.context !== 'one-million')
      throw new Error('Invalid probe context');
    result.context = value.context;
  }
  if (
    (input.effort !== undefined && result.effort !== input.effort) ||
    (input.context !== undefined && result.context !== input.context)
  )
    throw new Error('Wrong launch model probe selection');
  return result;
}
