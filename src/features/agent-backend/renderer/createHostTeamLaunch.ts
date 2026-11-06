import { hostTeamSelectionKey } from './hostTeamRouting';
import { readHostLaunchConfiguration } from './readHostLaunchConfiguration';

import type { BackendHandle } from '../contracts';
import type {
  BackendLaunchConfiguration,
  BackendLaunchConfigurationView,
  BackendLaunchSnapshot,
} from '../contracts/launch';
import type { AgentBackendApi } from '../contracts/operations';

/** A single user intent stays on its captured owner, including an uncertain response. */
export function createHostTeamLaunch(
  backend: AgentBackendApi,
  selection: string,
  current: () => boolean
) {
  let handle: BackendHandle | undefined;
  let intent: { commandId: string; launchId: string; rosterRevision: string } | undefined;
  function assertCurrent(): void {
    if (!current()) throw new Error('Team context changed');
  }
  async function resolveHandle(): Promise<BackendHandle> {
    assertCurrent();
    if (!handle) {
      const connections = await backend.getConnections();
      assertCurrent();
      if (connections.state !== 'ready') throw new Error('Team backend unavailable');
      const selectedHandle = connections.bindings.find(
        (binding) => hostTeamSelectionKey(binding.handle.handleId) === selection
      )?.handle;
      if (!selectedHandle) throw new Error('Team backend unavailable');
      handle = { ...selectedHandle };
    }
    return { ...handle };
  }
  async function read(): Promise<BackendLaunchConfigurationView> {
    const result = await readHostLaunchConfiguration(backend, await resolveHandle());
    assertCurrent();
    if (!result) throw new Error('Launch runtime unconfigured');
    return result;
  }
  async function capture(
    rosterCommandId: string,
    commandId: string
  ): Promise<BackendLaunchConfigurationView> {
    const original = await resolveHandle();
    let result;
    try {
      result = await backend.invoke({
        handle: original,
        commandId,
        operation: 'team.launch.capture',
        payload: { rosterCommandId },
      });
    } catch {
      throw new Error('Launch capture result unknown. Retry the same intent.');
    }
    assertCurrent();
    if (!result.ok)
      throw new Error(
        result.outcome === 'unknown'
          ? 'Launch capture result unknown. Retry the same intent.'
          : `Launch capture refused (${result.code})`
      );
    if (!result.value || !('launch' in result.value) || !('members' in result.value))
      throw new Error('Launch capture result unknown. Retry the same intent.');
    return result.value;
  }
  async function start(
    view: BackendLaunchConfigurationView,
    configuration?: BackendLaunchConfiguration,
    originalCommandId?: string
  ): Promise<BackendLaunchSnapshot> {
    assertCurrent();
    const original = originalCommandId && view.launch.admission?.commandId === originalCommandId;
    if (
      !handle ||
      intent ||
      (!original &&
        (view.launch.admission ||
          view.launch.members.some(
            (member) => member.status !== 'not-started' && member.status !== 'skipped'
          )))
    )
      throw new Error('Launch already submitted; refresh its status');
    const commandId = originalCommandId ?? crypto.randomUUID();
    intent = {
      commandId,
      launchId: view.launch.launchId,
      rosterRevision: view.launch.rosterRevision,
    };
    let result;
    try {
      result = await backend.invoke({
        handle,
        commandId,
        operation: 'team.launch.start',
        payload: {
          launchId: intent.launchId,
          rosterRevision: intent.rosterRevision,
          ...(configuration === undefined ? {} : { configuration }),
        },
      });
    } catch {
      // Transport exceptions do not prove that the original launch was rejected.
      throw new Error('Launch result unknown. Refresh status; the launch will not be repeated.');
    }
    assertCurrent();
    if (!result.ok) {
      if (result.outcome !== 'unknown') intent = undefined;
      throw new Error(
        result.outcome === 'unknown'
          ? 'Launch result unknown. Refresh status; the launch will not be repeated.'
          : `Launch refused (${result.code})`
      );
    }
    if (!result.value || !('launchId' in result.value) || !('members' in result.value))
      throw new Error('Launch result unknown. Refresh status; the launch will not be repeated.');
    if (originalCommandId && result.value.admission?.commandId !== originalCommandId)
      throw new Error('Launch result unknown. Original admission unavailable.');
    return result.value;
  }
  return { read, capture, start, hasSubmitted: () => intent !== undefined };
}
