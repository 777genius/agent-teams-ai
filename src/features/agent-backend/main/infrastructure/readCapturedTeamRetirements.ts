import { assertBackendRequestGuard, BackendRoutingError } from '../application/backendBinding';

import { type CapturedHostClient, observeCapturedHostStartup } from './CapturedHostClient';

import type { BackendOwnerBinding, BackendRequestGuard } from '../application/backendBinding';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';

/** Display filtering only; original immutable handles remain bound for exact deletion receipt lookup. */
export async function readCapturedTeamRetirements(options: {
  owner: BackendOwnerBinding;
  contextId: string;
  client: Pick<CapturedHostClient, 'request'>;
  start(): Promise<unknown>;
  available(): boolean;
  guard?: BackendRequestGuard;
}): Promise<readonly string[]> {
  const { client, start, available, guard, contextId } = options,
    owner = structuredClone(options.owner);
  const current = () => {
    assertBackendRequestGuard(guard);
    if (!available()) throw new BackendRoutingError('unavailable');
  };
  current();
  observeCapturedHostStartup('owner-start', 'retirement-read');
  await start();
  observeCapturedHostStartup('owner-started', 'retirement-read');
  current();
  observeCapturedHostStartup('read-start', 'retirement-read');
  const result = await client.request(
    'team.lifecycle.retired.read',
    {
      owner: owner as unknown as JsonValue,
      contextId,
    },
    { control: true }
  );
  current();
  observeCapturedHostStartup('read-complete', 'retirement-read');
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    result.ok !== true ||
    !result.value ||
    typeof result.value !== 'object' ||
    Array.isArray(result.value) ||
    Object.keys(result.value).some((key) => key !== 'teamIds') ||
    !Array.isArray(result.value.teamIds) ||
    result.value.teamIds.length > 256 ||
    result.value.teamIds.some(
      (id) => typeof id !== 'string' || !id || id.length > 256 || id.includes('\0')
    ) ||
    new Set(result.value.teamIds).size !== result.value.teamIds.length
  )
    throw new BackendRoutingError('hold');
  return result.value.teamIds as string[];
}
