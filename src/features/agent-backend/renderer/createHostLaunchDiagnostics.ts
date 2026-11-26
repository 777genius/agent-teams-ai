import { sanitizeRuntimeDiagnosticText } from '@shared/utils/runtimeDiagnosticText';

import { hostTeamRunId, parseHostTeamRunId } from '../contracts/teamRunSelection';
import { hostTeamSelectionKey, parseHostTeamSelectionKey } from '../contracts/teamSelection';

import { HostTeamOperationError } from './createHostTeamMutations';
import { captureHostProjectFamily } from './hostProjectBindings';
import { readHostLaunchConfiguration } from './readHostLaunchConfiguration';

import type { BackendLaunchConfigurationView } from '../contracts/launch';
import type { AgentBackendApi } from '../contracts/operations';
import type { TeamProductReadOrder } from './TeamProductReadOrder';
import type {
  TeamLaunchDiagnosticsObservation,
  TeamLaunchFailureDiagnosticsBundle,
} from '@shared/types/team';

function identity(view: BackendLaunchConfigurationView): string {
  return JSON.stringify([
    view.launch.launchId,
    view.launch.rosterRevision,
    view.launch.members.map(({ memberId, generation, attemptId }) => [
      memberId,
      generation,
      attemptId,
    ]),
  ]);
}

function observation(label: string, value: unknown): TeamLaunchDiagnosticsObservation {
  const content = JSON.stringify(
    value,
    (_key, item: unknown) =>
      typeof item === 'string' ? (sanitizeRuntimeDiagnosticText(item, 4096) ?? '') : item,
    2
  );
  return { label, content };
}

/** Copy diagnostics reads the original Host; it neither mutates a run nor reads legacy artifacts. */
export function createHostLaunchDiagnostics(
  backend: AgentBackendApi,
  captureScope: () => () => boolean,
  readOrder: TeamProductReadOrder
) {
  return async (teamName: string, runId?: string): Promise<TeamLaunchFailureDiagnosticsBundle> => {
    const requestedHandle = parseHostTeamSelectionKey(teamName);
    const requestedRun = runId === undefined ? null : parseHostTeamRunId(runId);
    const check = captureScope();
    const current = () => {
      if (!check()) throw new HostTeamOperationError('context-changed', 'not-dispatched');
    };
    current();
    const snapshot = await backend.getConnections();
    current();
    const handleId = requestedRun?.handleId ?? requestedHandle;
    const family = captureHostProjectFamily(snapshot, hostTeamSelectionKey(handleId));
    if (requestedHandle !== handleId && requestedHandle !== family.logical.handle.handleId)
      throw new HostTeamOperationError('conflict', 'not-dispatched');
    const handle = { ...family.selected.handle };
    readOrder.capture(check);
    // Diagnostics do not publish progress and must not retire an ordinary progress read.
    const fence = readOrder.readFence(handleId);
    const assertCurrent = () => {
      current();
      fence();
    };
    const view = await readHostLaunchConfiguration(backend, handle, requestedRun?.launchId);
    assertCurrent();
    if (
      !view ||
      (requestedRun &&
        (view.launch.launchId !== requestedRun.launchId ||
          view.launch.rosterRevision !== requestedRun.rosterRevision))
    )
      throw new HostTeamOperationError('conflict', 'not-dispatched');
    if (
      view.launch.members.length > 256 ||
      view.launch.expected !== view.launch.members.length ||
      new Set(view.launch.members.map((member) => member.memberId)).size !==
        view.launch.members.length
    )
      throw new HostTeamOperationError('invalid-result', 'unknown');
    const originalIdentity = identity(view);
    const observations: TeamLaunchDiagnosticsObservation[] = [
      observation('Host launch snapshot', {
        launchId: view.launch.launchId,
        rosterRevision: view.launch.rosterRevision,
        startedAtMs: view.launch.startedAtMs,
        observedAtMs: view.launch.observedAtMs,
        status: view.launch.status,
        ready: view.launch.ready,
        expected: view.launch.expected,
        retryCapability: view.launch.retryCapability,
        admission: view.launch.admission && {
          commandId: view.launch.admission.commandId,
          sourceRosterRevision: view.launch.admission.sourceRosterRevision,
        },
        members: view.launch.members.map((member) => ({
          memberId: member.memberId,
          label: view.members.find((configured) => configured.memberId === member.memberId)?.label,
          generation: member.generation,
          attemptId: member.attemptId,
          status: member.status,
          nativeReady: member.nativeReady,
          usable: member.usable,
          controlAvailable: member.controlAvailable,
          noAllocation: member.noAllocation,
          reason: member.reason,
        })),
      }),
    ];
    for (const member of view.launch.members) {
      if (member.generation === null) continue;
      assertCurrent();
      const label = `Runtime ${member.memberId}`;
      try {
        const result = await backend.invoke({
          handle,
          commandId: crypto.randomUUID(),
          operation: 'runtime.read',
          payload: { memberId: member.memberId, expectedGeneration: member.generation },
        });
        assertCurrent();
        if (!result.ok) {
          if (result.code === 'forbidden' || result.code === 'conflict')
            throw new HostTeamOperationError(result.code, result.outcome);
          observations.push({ label, issue: `${result.code} (${result.outcome})` });
          continue;
        }
        const runtime = result.value;
        if (
          !runtime ||
          !('attached' in runtime) ||
          runtime.memberId !== member.memberId ||
          runtime.generation !== member.generation
        )
          throw new HostTeamOperationError('invalid-result', 'unknown');
        observations.push(
          observation(label, {
            memberId: runtime.memberId,
            generation: runtime.generation,
            phase: runtime.phase,
            sealed: runtime.sealed,
            custody: runtime.custody,
            nativeReady: runtime.nativeReady,
            attached: runtime.attached,
            diagnostic: runtime.diagnostic ?? null,
            inputs: runtime.inputs.map(({ inputId, phase, terminal }) => ({
              inputId,
              phase,
              terminal,
            })),
            interactions: runtime.interactions.map(
              ({ interactionRef, inputId, kind, expiresAt, phase }) => ({
                interactionRef,
                inputId,
                kind,
                expiresAt,
                phase,
              })
            ),
          })
        );
      } catch (error) {
        assertCurrent();
        if (error instanceof HostTeamOperationError) throw error;
        // Transport error bodies are not public diagnostics and may contain private configuration.
        observations.push({ label, issue: 'Runtime observation unavailable' });
      }
    }
    const finalView = await readHostLaunchConfiguration(backend, handle, view.launch.launchId);
    assertCurrent();
    if (!finalView || identity(finalView) !== originalIdentity)
      throw new HostTeamOperationError('conflict', 'not-dispatched');
    family.assertSame(await backend.getConnections());
    assertCurrent();
    if (new TextEncoder().encode(JSON.stringify(observations)).byteLength > 512 * 1024)
      throw new HostTeamOperationError('output-limit', 'unknown');
    return {
      teamName,
      runId: hostTeamRunId(handleId, view.launch.launchId, view.launch.rosterRevision),
      source: 'captured-host',
      observations,
      files: [],
    };
  };
}
