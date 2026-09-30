import {
  HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
} from '@features/team-lifecycle/contracts';
import {
  type HostedControlStateRead,
  loadHostedTeamRuntimeEvidence,
} from '@features/team-lifecycle/renderer';
import {
  parseBootId,
  parseDeploymentId,
  parseRevision,
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type { CanonicalTeamLifecycleListItem } from '@features/team-lifecycle/contracts';
import type { HostedLifecycleControlStateResult } from '@features/team-lifecycle/contracts/hosted-lifecycle-commands';

const WORKSPACE = parseWorkspaceId(`workspace_${'a'.repeat(32)}`);
const REVISION = parseRevision(`revision_${'b'.repeat(64)}`);
const CONTROL_REVISION = parseRevision(`revision_${'c'.repeat(64)}`);

function item(index: number): CanonicalTeamLifecycleListItem {
  return {
    workspaceId: WORKSPACE,
    teamId: parseTeamId(`team_${String(index).padStart(32, '0')}`),
    displayName: `Team ${index}`,
    lifecycle: 'ready',
    revision: REVISION,
  };
}

function control(
  team: CanonicalTeamLifecycleListItem,
  actions: readonly ('launch' | 'stop' | 'recover')[],
  running: boolean
): HostedLifecycleControlStateResult {
  return {
    schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
    kind: 'control_state',
    workspaceId: team.workspaceId,
    teamId: team.teamId,
    deploymentId: parseDeploymentId(`deployment_${'d'.repeat(32)}`),
    bootId: parseBootId(`boot_${'e'.repeat(32)}`),
    runId: running ? parseRunId(`run_${'f'.repeat(32)}`) : null,
    resourceRevision: CONTROL_REVISION,
    availableActions: actions,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Hosted directory runtime evidence wave', () => {
  it('accepts only exact stop/runId and launch/null shapes, retaining per-team revisions', async () => {
    const teams = [item(1), item(2), item(3), item(4)];
    const read: HostedControlStateRead = vi.fn(async (request) => {
      const team = teams.find((candidate) => candidate.teamId === request.teamId)!;
      if (team === teams[0]) return control(team, ['stop'], true);
      if (team === teams[1]) return control(team, ['launch'], false);
      if (team === teams[2]) return control(team, ['stop', 'recover'], true);
      return control(team, ['launch'], true);
    });
    const wave = await loadHostedTeamRuntimeEvidence(teams, read, new AbortController().signal);

    expect(teams.map((team) => wave.byTeamId.get(team.teamId)?.runtime)).toEqual([
      'running', 'offline', 'unknown', 'unknown',
    ]);
    expect(wave.byTeamId.get(teams[0]!.teamId)).toMatchObject({
      teamRevision: REVISION,
      controlRevision: CONTROL_REVISION,
    });
    expect(wave.complete).toBe(false);
  });

  it('limits concurrency to four and does not start queued reads after the shared deadline', async () => {
    const teams = Array.from({ length: 7 }, (_, index) => item(index));
    const calls: ReturnType<typeof deferred<HostedLifecycleControlStateResult>>[] = [];
    const read: HostedControlStateRead = vi.fn(() => {
      const pending = deferred<HostedLifecycleControlStateResult>();
      calls.push(pending);
      return pending.promise;
    });
    const wave = await loadHostedTeamRuntimeEvidence(teams, read, new AbortController().signal, 15);
    expect(calls).toHaveLength(4);
    expect(wave.complete).toBe(false);
    expect(wave.byTeamId.size).toBe(4);
    calls[0]!.resolve(control(teams[0]!, ['stop'], true));
    await Promise.resolve();
    expect(wave.byTeamId.get(teams[0]!.teamId)?.runtime).toBe('unknown');
  });

  it('stops a scoped wave promptly when its AbortSignal is cancelled', async () => {
    const controller = new AbortController();
    const read: HostedControlStateRead = vi.fn(() => new Promise<HostedLifecycleControlStateResult>(() => {}));
    const pending = loadHostedTeamRuntimeEvidence([item(1), item(2)], read, controller.signal, 5_000);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ complete: false });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('treats a synchronous control-port throw as unknown without rejecting the wave', async () => {
    const team = item(1);
    const read: HostedControlStateRead = () => { throw new Error('port unavailable'); };
    const wave = await loadHostedTeamRuntimeEvidence([team], read, new AbortController().signal, 25);
    expect(wave.complete).toBe(false);
    expect(wave.byTeamId.get(team.teamId)?.runtime).toBe('unknown');
  });
});
