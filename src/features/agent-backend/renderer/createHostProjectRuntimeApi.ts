import { hostTeamRunId } from '../contracts/teamRunSelection';
import { hostTeamSelectionKey } from '../contracts/teamSelection';

import { HostTeamOperationError } from './createHostTeamMutations';
import { captureHostProjectFamily } from './hostProjectBindings';
import { readHostLaunchConfiguration } from './readHostLaunchConfiguration';
import { readHostPagedSnapshot } from './readHostPagedSnapshot';

import type { BackendConnectionSnapshot } from '../contracts/connections';
import type { AgentBackendApi } from '../contracts/operations';
import type { createHostTeamLifecycle, HostTeamRuntimeState } from './createHostTeamLifecycle';
import type { HostProjectConnection } from './hostProjectBindings';
import type { TeamProductReadOrder } from './TeamProductReadOrder';
import type { TeamAgentRuntimeSnapshot } from '@shared/types/team';

/** Logical controls keep every physical original generation, including retained project histories. */
export function createHostProjectRuntimeApi(options: {
  backend: AgentBackendApi;
  captureScope(): () => boolean;
  readOrder: TeamProductReadOrder;
  lifecycle: ReturnType<typeof createHostTeamLifecycle>;
}) {
  const unavailable = () => {
    const error = new HostTeamOperationError('runtime-unavailable', 'not-dispatched');
    error.message = 'Host runtime state unavailable (not-dispatched)';
    return error;
  };
  const check = (current: () => boolean) => {
    if (!current()) throw new HostTeamOperationError('context-changed', 'not-dispatched');
  };
  async function catalog(current: () => boolean, allowEmptyUnconfigured = false) {
    check(current);
    const value = await options.backend.getConnections();
    check(current);
    if (
      value.state !== 'ready' &&
      !(
        allowEmptyUnconfigured &&
        value.state === 'unconfigured' &&
        value.bindings.length === 0 &&
        (value.unavailableOwners?.length ?? 0) === 0
      )
    )
      throw new HostTeamOperationError('unavailable', 'not-dispatched');
    return structuredClone(value);
  }
  async function observe(
    connection: HostProjectConnection,
    current: () => boolean,
    missingLaunchUnsupported = false
  ) {
    options.readOrder.capture(current);
    const fence = options.readOrder.readFence(connection.handle.handleId);
    const state = await options.lifecycle.read(connection, current);
    check(current);
    fence();
    if (!state) {
      if (missingLaunchUnsupported)
        throw new HostTeamOperationError('unsupported', 'not-dispatched');
      const source = await readHostPagedSnapshot(
        options.backend,
        connection,
        current,
        options.readOrder
      );
      source.assertCurrent();
      fence();
      check(current);
      if (!source.data.runtimeNeverLaunched || source.data.lifecycle?.cleanupPending)
        throw unavailable();
    }
    return {
      connection,
      state,
      assertCurrent() {
        check(current);
        fence();
      },
    };
  }
  async function captured(key: string, stopping = false) {
    const current = options.captureScope(),
      snapshot = await catalog(current);
    const family = captureHostProjectFamily(snapshot, key);
    const observations = [];
    for (const connection of family.targets)
      observations.push(
        await observe(connection, current, stopping && family.targets.length === 1)
      );
    family.assertSame(await catalog(current));
    for (const entry of observations) entry.assertCurrent();
    return { current, family, observations };
  }
  function alive(states: (HostTeamRuntimeState | null)[]): boolean {
    if (states.some((state) => state?.alive === true)) return true;
    if (states.some((state) => state?.alive === undefined && state !== null)) throw unavailable();
    return false;
  }
  return {
    async processAlive(key: string): Promise<boolean> {
      const original = await captured(key);
      return alive(original.observations.map((entry) => entry.state));
    },
    async stop(key: string): Promise<void> {
      // Capture every launch before any Stop; a later project never becomes this command's target.
      const original = await captured(key, true),
        failures: unknown[] = [];
      if (original.observations.every((entry) => !entry.state))
        throw new HostTeamOperationError('unsupported', 'not-dispatched');
      let effectStarted = false;
      for (const { connection } of original.observations)
        options.readOrder.invalidateReads(connection.handle.handleId);
      try {
        for (const { connection, state } of original.observations) {
          if (!state) continue;
          try {
            original.family.assertSame(await catalog(original.current));
            effectStarted ||= state.launch.members.some((member) => member.generation !== null);
            await options.lifecycle.stopCaptured(
              connection,
              structuredClone(state.launch),
              original.current
            );
          } catch (error) {
            failures.push(error);
          }
        }
        original.family.assertSame(await catalog(original.current));
        if (failures.length) throw failures[0];
      } catch (error) {
        if (!effectStarted) throw error;
        throw new HostTeamOperationError(
          error instanceof HostTeamOperationError ? error.code : 'stop-unconfirmed',
          'unknown',
          error instanceof HostTeamOperationError ? error.commandId : undefined
        );
      } finally {
        if (original.current())
          for (const { connection } of original.observations)
            options.readOrder.invalidateReads(connection.handle.handleId);
      }
    },
    async aliveList(): Promise<string[]> {
      const current = options.captureScope(),
        snapshot = await catalog(current, true);
      const observations = new Map<string, Awaited<ReturnType<typeof observe>>>();
      for (const binding of snapshot.bindings)
        observations.set(binding.handle.handleId, await observe(binding, current));
      const latest: BackendConnectionSnapshot = await catalog(current, true),
        result: string[] = [];
      if (latest.state !== snapshot.state)
        throw new HostTeamOperationError('unavailable', 'not-dispatched');
      for (const binding of snapshot.bindings) {
        const key = hostTeamSelectionKey(binding.handle.handleId),
          family = captureHostProjectFamily(snapshot, key);
        family.assertSame(latest);
        const states = family.targets.map((target) => {
          const selected = observations.get(target.handle.handleId);
          if (!selected) throw new HostTeamOperationError('runtime-unavailable', 'not-dispatched');
          selected.assertCurrent();
          return selected.state;
        });
        if (alive(states)) result.push(key);
      }
      return result;
    },
    async getTeamAgentRuntime(key: string): Promise<TeamAgentRuntimeSnapshot> {
      const original = await captured(key);
      const live = original.observations.filter((entry) => entry.state?.alive === true);
      if (
        original.observations.some((entry) => entry.state && entry.state.alive === undefined) ||
        live.length > 1
      )
        throw new HostTeamOperationError('runtime-unavailable', 'not-dispatched');
      const historical = original.observations
        .filter((entry) => entry.state)
        .sort((a, b) => (b.state!.launch.startedAtMs ?? -1) - (a.state!.launch.startedAtMs ?? -1));
      if (
        !live.length &&
        historical.length > 1 &&
        (historical[0].state!.launch.startedAtMs ?? -1) ===
          (historical[1].state!.launch.startedAtMs ?? -1)
      )
        throw new HostTeamOperationError('runtime-unavailable', 'not-dispatched');
      const selected = live[0] ?? historical[0];
      if (!selected?.state)
        return { teamName: key, runId: null, members: {}, updatedAt: new Date().toISOString() };
      const configuration = await readHostLaunchConfiguration(
        options.backend,
        selected.connection.handle,
        selected.state.launch.launchId
      );
      original.family.assertSame(await catalog(original.current));
      for (const entry of original.observations) entry.assertCurrent();
      if (
        !configuration ||
        configuration.launch.launchId !== selected.state.launch.launchId ||
        configuration.launch.rosterRevision !== selected.state.launch.rosterRevision ||
        !Number.isSafeInteger(configuration.launch.observedAtMs)
      )
        throw new HostTeamOperationError('runtime-unavailable', 'not-dispatched');
      const updatedAt = new Date(configuration.launch.observedAtMs!).toISOString();
      const members: TeamAgentRuntimeSnapshot['members'] = {};
      for (const member of configuration.members) {
        const launch = selected.state.launch.members.find(
          (row) => row.memberId === member.memberId
        );
        const observed = configuration.launch.members.find(
          (row) => row.memberId === member.memberId
        );
        if (
          !launch ||
          !observed ||
          launch.generation !== observed.generation ||
          launch.attemptId !== observed.attemptId ||
          Object.hasOwn(members, member.label)
        )
          throw new HostTeamOperationError('runtime-unavailable', 'not-dispatched');
        const runtime = selected.state.sessions.find(
          (row) => row.memberId === member.memberId && row.generation === launch.generation
        );
        if (launch.generation && !runtime)
          throw new HostTeamOperationError('runtime-unavailable', 'not-dispatched');
        members[member.label] = {
          memberName: member.label,
          alive: runtime?.attached === true,
          restartable: runtime?.attached === true && launch.controlAvailable,
          ...(launch.generation ? { runtimeGeneration: launch.generation } : {}),
          ...(member.selected
            ? {
                providerId:
                  member.selected.provider === 'claude'
                    ? ('anthropic' as const)
                    : member.selected.provider,
                runtimeModel:
                  member.selected.provider === 'opencode'
                    ? member.selected.qualifiedModel
                    : member.selected.model,
                cwd: member.selected.workspace,
              }
            : {}),
          updatedAt,
        };
      }
      return {
        teamName: key,
        updatedAt,
        members,
        runId: hostTeamRunId(
          selected.connection.handle.handleId,
          configuration.launch.launchId,
          configuration.launch.rosterRevision
        ),
      };
    },
  };
}
