import type { BackendHandle } from '../contracts';
import type { AgentBackendApi } from '../contracts/operations';
import type { BackendRosterConfiguration } from '../contracts/roster';

/** One authoritative app-settings read; never reconstruct intent from native profiles. */
export async function readHostRosterConfiguration(
  backend: AgentBackendApi,
  handle: BackendHandle
): Promise<BackendRosterConfiguration> {
  const result = await backend.invoke({
    handle,
    commandId: crypto.randomUUID(),
    operation: 'team.roster.read',
    payload: {},
  });
  if (!result.ok) throw new Error(`Saved team settings unavailable (${result.code})`);
  if (
    !result.value ||
    !('revision' in result.value) ||
    !('members' in result.value) ||
    !('removedMembers' in result.value)
  )
    throw new Error('Invalid saved team settings');
  return result.value;
}
