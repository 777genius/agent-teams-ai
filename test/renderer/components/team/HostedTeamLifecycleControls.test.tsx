import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
  parseHostedLifecycleCommandId,
  parseHostedLifecycleIdempotencyKey,
} from '@features/team-lifecycle/contracts/hosted-lifecycle-commands';
import { HostedTeamLifecycleControls } from '@features/team-lifecycle/renderer/ui/HostedTeamLifecycleControls';
import {
  parseBootId,
  parseDeploymentId,
  parseRevision,
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostedLifecycleControlState } from '@features/team-lifecycle/contracts/hosted-lifecycle-commands';
import type { HostedTeamLifecycleTransport } from '@features/team-lifecycle/renderer';

const WORKSPACE_ID = parseWorkspaceId(`workspace_${'a'.repeat(32)}`);
const TEAM_ID = parseTeamId(`team_${'b'.repeat(32)}`);
const DEPLOYMENT_ID = parseDeploymentId('deployment_lifecycle-controls');
const BOOT_ID = parseBootId('boot_lifecycle-controls');
const RUN_ID = parseRunId(`run_${'c'.repeat(32)}`);
const REVISION = parseRevision('revision_lifecycle-controls');
const COMMAND_ID = parseHostedLifecycleCommandId('lifecycle-command_controls-0001');
const IDEMPOTENCY_KEY = parseHostedLifecycleIdempotencyKey('idempotency_controls-0001');

describe('HostedTeamLifecycleControls', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));

  afterEach(async () => {
    if (root !== null) await act(async () => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('uses authenticated owner health, prepares, and launches with the live revision', async () => {
    const projection = {
      schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
      workspaceId: WORKSPACE_ID,
      teamId: TEAM_ID,
      deploymentId: DEPLOYMENT_ID,
      bootId: BOOT_ID,
      runId: null,
      resourceRevision: REVISION,
      availableActions: ['launch'] as const,
    };
    const getProgress = vi.fn<HostedTeamLifecycleTransport['getProgress']>(async () => ({
      ...projection,
      kind: 'provisioning_status',
      recentCommands: [],
    }));
    const getControlState = vi.fn<HostedTeamLifecycleTransport['getControlState']>(async () => ({
      ...projection,
      kind: 'control_state',
    }));
    const prepare = vi.fn<HostedTeamLifecycleTransport['prepare']>(async () => ({
      ...projection,
      kind: 'prepared',
      lanes: [{ laneKey: 'lane-1', backend: 'provisioning_cli', status: 'ready' }],
    }));
    const execute = vi.fn<HostedTeamLifecycleTransport['execute']>(async (command) => ({
      schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
      kind: 'accepted',
      action: command.action,
      commandId: command.commandId,
      workspaceId: command.workspaceId,
      teamId: command.teamId,
      runId: RUN_ID,
      resourceRevision: REVISION,
    }));

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <HostedTeamLifecycleControls
          workspaceId={WORKSPACE_ID}
          teamId={TEAM_ID}
          transport={{ getControlState, getProgress, prepare, execute }}
          healthPollIntervalMs={60_000}
          createCommandIdentity={() => ({
            commandId: COMMAND_ID,
            idempotencyKey: IDEMPOTENCY_KEY,
          })}
        />
      );
      await Promise.resolve();
    });
    expect(getControlState).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('Lifecycle owner is available.');

    const button = (name: string): HTMLButtonElement => {
      const match = Array.from(host!.querySelectorAll('button')).find(
        (candidate) => candidate.textContent === name
      );
      if (match === undefined) throw new Error(`missing lifecycle control: ${name}`);
      return match;
    };
    await act(async () => button('Prepare').click());
    expect(prepare).toHaveBeenCalledWith({
      schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
      workspaceId: WORKSPACE_ID,
      teamId: TEAM_ID,
    });
    expect(host.textContent).toContain('Lifecycle controls prepared.');

    await act(async () => button('Launch').click());
    expect(execute).toHaveBeenCalledWith({
      schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
      action: 'launch',
      commandId: COMMAND_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      workspaceId: WORKSPACE_ID,
      teamId: TEAM_ID,
      expectedRevision: REVISION,
    });
    expect(getControlState).toHaveBeenCalledTimes(3);
  });

  it('fails closed and disables every lifecycle action when owner health is lost', async () => {
    vi.useFakeTimers();
    const projection = {
      schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
      workspaceId: WORKSPACE_ID,
      teamId: TEAM_ID,
      deploymentId: DEPLOYMENT_ID,
      bootId: BOOT_ID,
      runId: null,
      resourceRevision: REVISION,
      availableActions: ['launch'] as const,
    };
    const getControlState = vi
      .fn<HostedTeamLifecycleTransport['getControlState']>()
      .mockResolvedValueOnce({ ...projection, kind: 'control_state' })
      .mockResolvedValue({
        schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
        kind: 'unavailable',
        retryAfterMs: 1_000,
      });
    const getProgress = vi.fn<HostedTeamLifecycleTransport['getProgress']>();
    const prepare = vi.fn<HostedTeamLifecycleTransport['prepare']>();
    const execute = vi.fn<HostedTeamLifecycleTransport['execute']>();

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <HostedTeamLifecycleControls
          workspaceId={WORKSPACE_ID}
          teamId={TEAM_ID}
          transport={{ getControlState, getProgress, prepare, execute }}
          healthPollIntervalMs={100}
        />
      );
      await Promise.resolve();
    });
    expect(Array.from(host.querySelectorAll('button')).some((button) => !button.disabled)).toBe(
      true
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(host.textContent).toContain('Lifecycle controls are temporarily unavailable.');
    expect(Array.from(host.querySelectorAll('button')).every((button) => button.disabled)).toBe(
      true
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not let a health poll invalidate a slow lifecycle command', async () => {
    vi.useFakeTimers();
    let resolveExecute!: (value: Awaited<ReturnType<HostedTeamLifecycleTransport['execute']>>) => void;
    const executePromise = new Promise<Awaited<ReturnType<HostedTeamLifecycleTransport['execute']>>>((resolve) => { resolveExecute = resolve; });
    const projection = {
      schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
      workspaceId: WORKSPACE_ID, teamId: TEAM_ID, deploymentId: DEPLOYMENT_ID, bootId: BOOT_ID,
      runId: null, resourceRevision: REVISION, availableActions: ['launch'] as const,
    };
    const getControlState = vi.fn(async () => ({ ...projection, kind: 'control_state' as const }));
    const execute = vi.fn(() => executePromise);
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root?.render(<HostedTeamLifecycleControls workspaceId={WORKSPACE_ID} teamId={TEAM_ID} transport={{ getControlState, getProgress: vi.fn(), prepare: vi.fn(), execute }} healthPollIntervalMs={100} createCommandIdentity={() => ({ commandId: COMMAND_ID, idempotencyKey: IDEMPOTENCY_KEY })} />); await Promise.resolve(); });
    const launch = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Launch')!;
    await act(async () => { launch.click(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(getControlState).toHaveBeenCalledOnce();
    await act(async () => { resolveExecute({ schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION, kind: 'accepted', action: 'launch', commandId: COMMAND_ID, workspaceId: WORKSPACE_ID, teamId: TEAM_ID, runId: RUN_ID, resourceRevision: REVISION }); await executePromise; });
    expect(host.textContent).toContain('Lifecycle command accepted.');
  });

  it('fences an old health read and forces a fresh read after command completion', async () => {
    vi.useFakeTimers();
    let resolveOld!: (value: HostedLifecycleControlState) => void;
    const old = new Promise<HostedLifecycleControlState>((resolve) => { resolveOld = resolve; });
    const first = { schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION, workspaceId: WORKSPACE_ID, teamId: TEAM_ID, deploymentId: DEPLOYMENT_ID, bootId: BOOT_ID, runId: null, resourceRevision: REVISION, availableActions: ['launch'] as const, kind: 'control_state' as const };
    const fresh = { ...first, availableActions: [] as const, resourceRevision: parseRevision('revision_lifecycle-controls-fresh') };
    const getControlState = vi.fn<HostedTeamLifecycleTransport['getControlState']>()
      .mockResolvedValueOnce(first).mockReturnValueOnce(old).mockResolvedValueOnce(fresh);
    const execute = vi.fn<HostedTeamLifecycleTransport['execute']>(async () => ({ schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION, kind: 'accepted', action: 'launch', commandId: COMMAND_ID, workspaceId: WORKSPACE_ID, teamId: TEAM_ID, runId: RUN_ID, resourceRevision: REVISION }));
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root?.render(<HostedTeamLifecycleControls workspaceId={WORKSPACE_ID} teamId={TEAM_ID} transport={{ getControlState, getProgress: vi.fn(), prepare: vi.fn(), execute }} healthPollIntervalMs={60_000} createCommandIdentity={() => ({ commandId: COMMAND_ID, idempotencyKey: IDEMPOTENCY_KEY })} />); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    const launch = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Launch')!;
    await act(async () => { launch.click(); await Promise.resolve(); });
    expect(execute).toHaveBeenCalledOnce();
    await act(async () => { resolveOld(first); await old; await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(getControlState).toHaveBeenCalledTimes(3);
    expect(launch.disabled).toBe(true);
  });
});
