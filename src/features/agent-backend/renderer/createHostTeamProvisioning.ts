import { parseHostTeamRunId } from '../contracts/teamRunSelection';

import {
  captureHostProvisioningMemberSnapshot,
  projectHostMemberSpawnStatuses,
} from './createHostMemberSpawnStatuses';
import { createHostTeamLifecycle } from './createHostTeamLifecycle';
import { captureHostProjectFamily } from './hostProjectBindings';
import { projectHostProjectProgress } from './hostProjectProvisioningOwner';
import { hostTeamSelectionKey } from './hostTeamRouting';
import { projectHostProvisioningProgress } from './projectHostProvisioningProgress';
import { readHostLaunchConfiguration } from './readHostLaunchConfiguration';

import type { AgentBackendApi } from '../contracts/operations';
import type { TeamProductReadOrder } from './TeamProductReadOrder';

/** Existing store polling supplies cadence; this adapter starts no parallel polling loop. */
export function createHostTeamProvisioning(
  backend: AgentBackendApi,
  captureScope: () => () => boolean,
  readOrder?: TeamProductReadOrder
) {
  const lifecycle = createHostTeamLifecycle(backend);
  const reads = new Map<string, number>();
  let sequence = 0;
  async function capture(runId: string) {
    const selected = parseHostTeamRunId(runId);
    const check = captureScope(),
      request = ++sequence;
    const current = () => {
      if (!check()) throw new Error('Team context changed');
    };
    current();
    const snapshot = await backend.getConnections();
    current();
    if (snapshot.state !== 'ready') throw new Error('Host teams unavailable');
    const captured = structuredClone(snapshot);
    const family = captureHostProjectFamily(captured, hostTeamSelectionKey(selected.handleId));
    const original = family.selected;
    const retained = new Set(snapshot.bindings.map((binding) => binding.handle.handleId));
    for (const handleId of reads.keys()) if (!retained.has(handleId)) reads.delete(handleId);
    if ((reads.get(selected.handleId) ?? 0) > request) throw new Error('Stale Host launch read');
    reads.set(selected.handleId, request);
    const assertCurrent = () => {
      current();
      if (reads.get(selected.handleId) !== request) throw new Error('Stale Host launch read');
    };
    const connection = { ...original, handle: { handleId: selected.handleId } };
    readOrder?.capture(check);
    const readFence = readOrder?.launchReadFence(selected.handleId);
    const assertObservationCurrent = () => {
      assertCurrent();
      readFence?.();
    };
    const configuration = await readHostLaunchConfiguration(
      backend,
      connection.handle,
      selected.launchId
    );
    assertObservationCurrent();
    if (
      !configuration ||
      configuration.launch.launchId !== selected.launchId ||
      configuration.launch.rosterRevision !== selected.rosterRevision
    )
      throw new Error('Host launch selection changed');
    family.assertSame(await backend.getConnections());
    assertObservationCurrent();
    return { connection, configuration, captured, assertCurrent: assertObservationCurrent, check };
  }
  return {
    async getProvisioningStatus(runId: string) {
      const selected = await capture(runId);
      selected.assertCurrent();
      return captureHostProvisioningMemberSnapshot(
        projectHostProjectProgress(projectHostProvisioningProgress(selected.connection.handle.handleId, selected.configuration),
          selected.captured, selected.assertCurrent),
        projectHostMemberSpawnStatuses(selected.connection.handle.handleId, selected.configuration),
        selected.assertCurrent
      );
    },
    async cancelProvisioning(runId: string): Promise<void> {
      const selected = await capture(runId);
      selected.assertCurrent();
      // Stop exactly this observed roster/generation, never a later launch read.
      // Once stopping begins a new progress query must not interrupt physical cleanup.
      const handleId = selected.connection.handle.handleId;
      readOrder?.invalidateReads(handleId);
      try {
        await lifecycle.stopCaptured(
          selected.connection,
          selected.configuration.launch,
          selected.check
        );
      } finally {
        if (selected.check()) readOrder?.invalidateReads(handleId);
      }
    },
  };
}
