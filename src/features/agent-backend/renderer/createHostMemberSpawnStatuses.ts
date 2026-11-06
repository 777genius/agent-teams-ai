import { hostTeamRunId } from '../contracts/teamRunSelection';
import { parseHostTeamSelectionKey } from '../contracts/teamSelection';

import { readHostLaunchConfiguration } from './readHostLaunchConfiguration';

import type { BackendLaunchConfigurationView } from '../contracts/launch';
import type { AgentBackendApi } from '../contracts/operations';
import type { TeamProductReadOrder } from './TeamProductReadOrder';
import type { MemberSpawnStatusEntry, MemberSpawnStatusesSnapshot } from '@shared/types/team';

const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0');

/** Current Host launch observations only; no process, heartbeat or control authority is inferred. */
export function projectHostMemberSpawnStatuses(
  handleId: string,
  view: BackendLaunchConfigurationView
): MemberSpawnStatusesSnapshot {
  const { launch, members } = view;
  if (
    !Array.isArray(members) ||
    !Array.isArray(launch.members) ||
    members.length < 1 ||
    members.length > 256 ||
    launch.expected !== members.length ||
    launch.members.length !== members.length ||
    new Set(members.map((member) => member.memberId)).size !== members.length ||
    new Set(members.map((member) => member.label)).size !== members.length ||
    new Set(launch.members.map((member) => member.memberId)).size !== members.length ||
    members.filter((member) => member.role === 'lead').length !== 1 ||
    members.some(
      (member) =>
        !text(member.memberId) || !text(member.label) || !['lead', 'member'].includes(member.role)
    )
  )
    throw new Error('Invalid Host launch roster');
  const observedAt = launch.observedAtMs;
  if (
    !Number.isSafeInteger(observedAt) ||
    Number(observedAt) < 0 ||
    Number(observedAt) > 8_640_000_000_000_000 ||
    (typeof launch.startedAtMs === 'number' && Number(observedAt) < launch.startedAtMs)
  )
    throw new Error('Host launch observation timestamp is unavailable');
  const updatedAt = new Date(Number(observedAt)).toISOString();
  const configured = new Map(members.map((member) => [member.memberId, member]));
  for (const member of launch.members) {
    if (
      !configured.has(member.memberId) ||
      !text(member.attemptId) ||
      !text(member.reason) ||
      (member.generation !== null && !text(member.generation)) ||
      [member.nativeReady, member.usable, member.controlAvailable, member.noAllocation].some(
        (value) => typeof value !== 'boolean'
      ) ||
      ![
        'not-started',
        'pending-bootstrap',
        'pending-human',
        'ready',
        'failed',
        'unknown',
        'skipped',
      ].includes(member.status) ||
      (member.usable && member.status !== 'ready') ||
      (member.status === 'ready' &&
        (!member.usable || !member.nativeReady || member.noAllocation || !member.generation))
    )
      throw new Error('Invalid Host member readiness');
  }
  const ready = launch.members.filter((member) => member.usable).length;
  const allReady =
    ready > 0 &&
    launch.members.every((member) => member.status === 'skipped' || member.status === 'ready');
  if (
    !['ready', 'pending', 'partial', 'failed'].includes(launch.status) ||
    launch.ready !== ready ||
    (launch.status === 'ready') !== allReady
  )
    throw new Error('Invalid Host aggregate readiness');
  const teammates = members.filter((member) => member.role === 'member');
  const statuses = Object.fromEntries(
    launch.members
      .filter((member) => configured.get(member.memberId)!.role === 'member')
      .map((member): [string, MemberSpawnStatusEntry] => {
        const base = { updatedAt, bootstrapConfirmed: false };
        let entry: MemberSpawnStatusEntry;
        switch (member.status) {
          case 'ready':
            entry = {
              updatedAt,
              status: 'online',
              launchState: 'confirmed_alive',
              bootstrapConfirmed: true,
            };
            break;
          case 'pending-human':
            entry = { ...base, status: 'waiting', launchState: 'runtime_pending_permission' };
            break;
          case 'failed':
            entry = {
              ...base,
              status: 'error',
              launchState: 'failed_to_start',
              error: member.reason,
              hardFailureReason: member.reason,
            };
            break;
          case 'skipped':
            entry = {
              ...base,
              status: 'skipped',
              launchState: 'skipped_for_launch',
              skippedForLaunch: true,
              skipReason: member.reason,
            };
            break;
          case 'unknown':
            entry = {
              ...base,
              status: 'waiting',
              launchState: 'runtime_pending_bootstrap',
              runtimeDiagnostic: `Runtime observation unavailable: ${member.reason}`,
              runtimeDiagnosticSeverity: 'warning',
            };
            break;
          default:
            entry = {
              ...base,
              status: member.status === 'not-started' ? 'waiting' : 'spawning',
              launchState: 'runtime_pending_bootstrap',
            };
        }
        return [configured.get(member.memberId)!.label, entry];
      })
  );
  return {
    statuses,
    runId: hostTeamRunId(handleId, launch.launchId, launch.rosterRevision),
    expectedMembers: teammates.map((member) => member.label),
    updatedAt,
  };
}

/** Existing Team subscribers supply cadence; this adapter performs one captured read. */
export function createHostMemberSpawnStatuses(
  backend: AgentBackendApi,
  captureScope: () => () => boolean,
  readOrder: TeamProductReadOrder
) {
  const reads = new Map<string, number>();
  let sequence = 0;
  return async (key: string): Promise<MemberSpawnStatusesSnapshot> => {
    const handleId = parseHostTeamSelectionKey(key);
    const check = captureScope(),
      request = ++sequence;
    reads.set(handleId, request);
    const current = () => {
      if (!check()) throw new Error('Team context changed');
      if (reads.get(handleId) !== request) throw new Error('Stale Host member spawn read');
    };
    try {
      readOrder.capture(check);
      const snapshot = await backend.getConnections();
      current();
      if (snapshot.state !== 'ready') throw new Error('Host teams unavailable');
      const connections = snapshot.bindings.filter(
        (binding) => binding.handle.handleId === handleId
      );
      if (connections.length !== 1) throw new Error('Host team unavailable');
      const handle = { ...connections[0].handle };
      const readFence = readOrder.launchReadFence(handleId);
      const configuration = await readHostLaunchConfiguration(backend, handle);
      current();
      readFence();
      return configuration
        ? projectHostMemberSpawnStatuses(handleId, configuration)
        : { statuses: {}, runId: null };
    } finally {
      if (reads.get(handleId) === request) reads.delete(handleId);
    }
  };
}
