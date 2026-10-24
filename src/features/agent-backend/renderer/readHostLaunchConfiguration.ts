import type { BackendHandle } from '../contracts';
import type { BackendLaunchConfigurationView } from '../contracts/launch';
import type { AgentBackendApi } from '../contracts/operations';

/** Authorized read only. The caller retains its scope/read fence across this await. */
export async function readHostLaunchConfiguration(
  backend: AgentBackendApi,
  handle: BackendHandle,
  launchId?: string
): Promise<BackendLaunchConfigurationView | null> {
  const result = await backend.invoke({
    handle,
    commandId: crypto.randomUUID(),
    operation: 'team.launch.configuration.read',
    payload: launchId === undefined ? {} : { launchId },
  });
  if (!result.ok) throw new Error(`Launch settings unavailable (${result.code})`);
  if (result.value === null) return null;
  if (!result.value || !('launch' in result.value) || !('members' in result.value))
    throw new Error('Invalid launch settings');
  return result.value as BackendLaunchConfigurationView;
}
