import type { BackendHandle } from '../contracts';
import type { AgentBackendApi } from '../contracts/operations';
import type { BackendRosterConfiguration } from '../contracts/roster';
import type { BackendTeamSnapshot } from '../contracts/teamSnapshot';

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

/** Verify a captured roster belongs to the exact product snapshot before projecting launch settings. */
export function assertMatchingConfiguration(
  snapshot: BackendTeamSnapshot,
  configuration: BackendRosterConfiguration
): void {
  if (
    snapshot.configurationRevision !== undefined &&
    snapshot.configurationRevision !== configuration.revision
  )
    throw new Error('Team configuration changed');
  if (
    configuration.members.length !== snapshot.members.length ||
    configuration.members.some(
      (member) =>
        !snapshot.members.some((row) => row.name === member.name && row.role === member.role)
    )
  )
    throw new Error('Team roster changed');
}

/** Only persisted, non-empty working directories may be used for Host project association. */
export function savedProjectPath(configuration: BackendRosterConfiguration): string | undefined {
  const cwd = configuration.savedSettings?.cwd;
  return typeof cwd === 'string' && cwd.trim().length > 0 && !cwd.includes('\0')
    ? cwd
    : undefined;
}
