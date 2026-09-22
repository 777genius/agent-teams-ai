import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningBootstrapFailureMarker,
  type TeamProvisioningBootstrapFailureMarkingPorts,
  type TeamProvisioningBootstrapFailureMarkingRun,
} from '../TeamProvisioningBootstrapFailureMarking';

import type { MemberSpawnStatusEntry } from '@shared/types';

const NOW = '2026-01-01T00:00:00.000Z';

function status(overrides: Partial<MemberSpawnStatusEntry> = {}): MemberSpawnStatusEntry {
  return {
    status: 'waiting',
    launchState: 'starting',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function run(
  overrides: Partial<TeamProvisioningBootstrapFailureMarkingRun> = {}
): TeamProvisioningBootstrapFailureMarkingRun {
  return {
    teamName: 'Team',
    expectedMembers: ['Builder'],
    memberSpawnStatuses: new Map(),
    pendingMemberRestarts: new Map(),
    ...overrides,
  };
}

function createPorts(
  overrides: Partial<
    TeamProvisioningBootstrapFailureMarkingPorts<TeamProvisioningBootstrapFailureMarkingRun>
  > = {}
): TeamProvisioningBootstrapFailureMarkingPorts<TeamProvisioningBootstrapFailureMarkingRun> {
  return {
    nowIso: vi.fn(() => NOW),
    createInitialMemberSpawnStatusEntry: vi.fn(() => status()),
    isMemberLifecycleOperationActive: vi.fn(() => false),
    syncMemberTaskActivityForRuntimeTransition: vi.fn(),
    appendMemberBootstrapDiagnostic: vi.fn(),
    isCurrentTrackedRun: vi.fn(() => true),
    emitMemberSpawnChange: vi.fn(),
    ...overrides,
  };
}

describe('TeamProvisioningBootstrapFailureMarking', () => {
  it('skips confirmed, launch-skipped, lifecycle-active, and pending-restart members', () => {
    const targetRun = run({
      expectedMembers: ['confirmed', 'skipped', 'lifecycle', 'restarting'],
      pendingMemberRestarts: new Map([['restarting', {}]]),
      memberSpawnStatuses: new Map([
        ['confirmed', status({ bootstrapConfirmed: true })],
        ['skipped', status({ skippedForLaunch: true })],
        ['lifecycle', status()],
        ['restarting', status()],
      ]),
    });
    const ports = createPorts({
      isMemberLifecycleOperationActive: vi.fn(
        (_teamName, memberName) => memberName === 'lifecycle'
      ),
    });

    createTeamProvisioningBootstrapFailureMarker(ports).markUnconfirmedBootstrapMembersFailed(
      targetRun,
      'bootstrap failed'
    );

    expect([...targetRun.memberSpawnStatuses.entries()]).toEqual([
      ['confirmed', status({ bootstrapConfirmed: true })],
      ['skipped', status({ skippedForLaunch: true })],
      ['lifecycle', status()],
      ['restarting', status()],
    ]);
    expect(ports.syncMemberTaskActivityForRuntimeTransition).not.toHaveBeenCalled();
    expect(ports.appendMemberBootstrapDiagnostic).not.toHaveBeenCalled();
    expect(ports.emitMemberSpawnChange).not.toHaveBeenCalled();
  });

  it('marks unconfirmed members failed and emits changes for the current tracked run', () => {
    const previous = status({ runtimeDiagnostic: 'pending' });
    const targetRun = run({
      memberSpawnStatuses: new Map([['Builder', previous]]),
    });
    const ports = createPorts();

    createTeamProvisioningBootstrapFailureMarker(ports).markUnconfirmedBootstrapMembersFailed(
      targetRun,
      ' bootstrap failed '
    );

    const next = targetRun.memberSpawnStatuses.get('Builder');
    expect(next).toEqual({
      ...previous,
      status: 'error',
      updatedAt: NOW,
      error: 'bootstrap failed',
      hardFailure: true,
      hardFailureReason: 'bootstrap failed',
      bootstrapConfirmed: false,
      bootstrapStalled: undefined,
      runtimeAlive: undefined,
      livenessSource: undefined,
      runtimeDiagnostic: 'pending',
      runtimeDiagnosticSeverity: undefined,
      launchState: 'failed_to_start',
    });
    expect(ports.syncMemberTaskActivityForRuntimeTransition).toHaveBeenCalledWith(
      targetRun,
      'Builder',
      previous,
      next,
      NOW
    );
    expect(ports.appendMemberBootstrapDiagnostic).toHaveBeenCalledWith(
      targetRun,
      'Builder',
      'bootstrap failed'
    );
    expect(ports.emitMemberSpawnChange).toHaveBeenCalledWith(targetRun, 'Builder');
  });

  it('preserves an existing hard failure reason when requested', () => {
    const previous = status({
      status: 'error',
      error: 'transient wrapper message',
      hardFailureReason: 'model unavailable',
      hardFailure: true,
      launchState: 'failed_to_start',
    });
    const targetRun = run({
      memberSpawnStatuses: new Map([['Builder', previous]]),
    });
    const ports = createPorts();

    createTeamProvisioningBootstrapFailureMarker(ports).markUnconfirmedBootstrapMembersFailed(
      targetRun,
      'new bootstrap failure',
      { preserveExistingFailure: true }
    );

    expect(targetRun.memberSpawnStatuses.get('Builder')).toEqual({
      ...previous,
      updatedAt: NOW,
      error: 'model unavailable',
      hardFailureReason: 'model unavailable',
      bootstrapConfirmed: false,
      bootstrapStalled: undefined,
      runtimeAlive: undefined,
      livenessSource: undefined,
      runtimeDiagnostic: undefined,
      runtimeDiagnosticSeverity: undefined,
    });
    expect(ports.appendMemberBootstrapDiagnostic).toHaveBeenCalledWith(
      targetRun,
      'Builder',
      'model unavailable'
    );
  });

  it('adds runtime-alive cleanup diagnostics and clears liveness when cleanup is requested', () => {
    const previous = status({
      runtimeAlive: true,
      livenessSource: 'process',
      runtimeDiagnostic: 'runtime process candidate',
    });
    const targetRun = run({
      memberSpawnStatuses: new Map([['Builder', previous]]),
    });
    const ports = createPorts();

    createTeamProvisioningBootstrapFailureMarker(ports).markUnconfirmedBootstrapMembersFailed(
      targetRun,
      'Launch ended before teammate bootstrap completed.',
      { cleanupRequested: true }
    );

    expect(targetRun.memberSpawnStatuses.get('Builder')).toEqual({
      ...previous,
      status: 'error',
      updatedAt: NOW,
      error:
        'Launch ended before teammate bootstrap completed. Runtime process was alive after bootstrap failure; launch-owned cleanup requested.',
      hardFailure: true,
      hardFailureReason:
        'Launch ended before teammate bootstrap completed. Runtime process was alive after bootstrap failure; launch-owned cleanup requested.',
      bootstrapConfirmed: false,
      bootstrapStalled: undefined,
      runtimeAlive: false,
      livenessSource: undefined,
      runtimeDiagnostic:
        'Bootstrap failed before teammate check-in; launch-owned runtime cleanup requested.',
      runtimeDiagnosticSeverity: 'warning',
      launchState: 'failed_to_start',
    });
  });

  it('updates stale runs without emitting member changes', () => {
    const previous = status();
    const targetRun = run({
      memberSpawnStatuses: new Map([['Builder', previous]]),
    });
    const ports = createPorts({
      isCurrentTrackedRun: vi.fn(() => false),
    });

    createTeamProvisioningBootstrapFailureMarker(ports).markUnconfirmedBootstrapMembersFailed(
      targetRun,
      ''
    );

    expect(targetRun.memberSpawnStatuses.get('Builder')).toMatchObject({
      status: 'error',
      error: 'Deterministic bootstrap failed before teammate check-in.',
      launchState: 'failed_to_start',
    });
    expect(ports.appendMemberBootstrapDiagnostic).toHaveBeenCalledTimes(1);
    expect(ports.emitMemberSpawnChange).not.toHaveBeenCalled();
  });
});
