import { HostTeamOperationError } from './createHostTeamMutations';

import type { BackendConnectionSnapshot } from '../contracts/connections';
import type { BackendLaunchSnapshot } from '../contracts/launch';
import type { AgentBackendApi, BackendRuntimeSnapshot } from '../contracts/operations';

type Connection = BackendConnectionSnapshot['bindings'][number];
type CurrentScope = () => boolean;
export interface HostTeamRuntimeState {
  launch: BackendLaunchSnapshot;
  sessions: BackendRuntimeSnapshot[];
  alive: boolean | undefined;
  unknownMembers: string[];
}

/** Ordinary controls keep the original captured owner and every selected member generation. */
export function createHostTeamLifecycle(backend: AgentBackendApi) {
  function current(
    check: CurrentScope,
    outcome: 'not-dispatched' | 'unknown' = 'not-dispatched'
  ): void {
    if (!check()) throw new HostTeamOperationError('forbidden', outcome);
  }
  async function readLaunch(
    connection: Connection,
    check: CurrentScope
  ): Promise<BackendLaunchSnapshot | null> {
    current(check);
    const result = await backend.invoke({
      handle: connection.handle,
      commandId: crypto.randomUUID(),
      operation: 'team.launch.read',
      payload: {},
    });
    current(check);
    if (!result.ok) throw new HostTeamOperationError(result.code, result.outcome);
    if (result.value === null) return null;
    if (!('launchId' in result.value) || !('members' in result.value))
      throw new HostTeamOperationError('invalid-result', 'unknown');
    return result.value;
  }
  async function read(
    connection: Connection,
    check: CurrentScope
  ): Promise<HostTeamRuntimeState | null> {
    const launch = await readLaunch(connection, check);
    if (!launch) return null;
    // Keep one control request in flight even for the maximum roster, rather
    // than exhausting the Host's reserved control slots with our own read.
    const sessions: BackendRuntimeSnapshot[] = [];
    const unknownMembers: string[] = [];
    for (const member of launch.members.filter((member) => member.generation !== null)) {
      current(check);
      try {
        const state = await backend.invoke({
          handle: connection.handle,
          commandId: crypto.randomUUID(),
          operation: 'runtime.read',
          payload: { memberId: member.memberId, expectedGeneration: member.generation! },
        });
        current(check);
        if (!state.ok) {
          if (state.code === 'forbidden' || state.code === 'conflict')
            throw new HostTeamOperationError(state.code, state.outcome);
          unknownMembers.push(member.memberId);
          continue;
        }
        if (
          !state.value ||
          !('attached' in state.value) ||
          state.value.memberId !== member.memberId ||
          state.value.generation !== member.generation
        )
          throw new HostTeamOperationError('invalid-result', 'unknown');
        sessions.push(state.value);
      } catch (error) {
        current(check);
        if (
          error instanceof HostTeamOperationError &&
          ['forbidden', 'conflict', 'invalid-result'].includes(error.code)
        )
          throw error;
        unknownMembers.push(member.memberId);
      }
    }
    current(check);
    const alive = sessions.some((state) => state.attached)
      ? true
      : unknownMembers.length > 0 || sessions.some((state) => state.custody !== 'released')
        ? undefined
        : false;
    return { launch, sessions, alive, unknownMembers };
  }
  async function stop(connection: Connection, check: CurrentScope): Promise<void> {
    const launch = await readLaunch(connection, check);
    if (!launch) throw new HostTeamOperationError('unsupported', 'not-dispatched');
    await stopCaptured(connection, launch, check);
  }
  async function stopCaptured(
    connection: Connection,
    launch: BackendLaunchSnapshot,
    check: CurrentScope
  ): Promise<void> {
    current(check);
    // Capture all destinations before the first effect. A concurrent replacement
    // conflicts instead of moving this Stop intent to a new generation.
    const requests = launch.members
      .filter((member) => member.generation !== null)
      .map((member) => ({
        handle: connection.handle,
        commandId: crypto.randomUUID(),
        operation: 'runtime.stop' as const,
        payload: { memberId: member.memberId, expectedGeneration: member.generation! },
      }));
    const failures: unknown[] = [];
    for (const request of requests) {
      try {
        current(check);
        const result = await backend.invoke(request);
        current(check, 'unknown');
        if (!result.ok)
          throw new HostTeamOperationError(result.code, result.outcome, request.commandId);
        if (
          !result.value ||
          !('attached' in result.value) ||
          result.value.memberId !== request.payload.memberId ||
          result.value.generation !== request.payload.expectedGeneration ||
          result.value.attached ||
          result.value.custody !== 'released'
        )
          throw new HostTeamOperationError('hold', 'unknown', request.commandId);
      } catch (error) {
        failures.push(error);
      }
    }
    current(check, requests.length ? 'unknown' : 'not-dispatched');
    if (failures.length) throw failures[0];
  }
  return { read, stop, stopCaptured };
}
