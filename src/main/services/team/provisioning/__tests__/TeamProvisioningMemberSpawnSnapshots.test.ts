import { describe, expect, it, vi } from 'vitest';

import {
  type MemberSpawnStatusMutationPorts,
  type MemberSpawnStatusRun,
  setMemberSpawnStatusForRun,
} from '../TeamProvisioningMemberSpawnSnapshots';

import type { MemberSpawnStatusEntry } from '@shared/types';

const baseStatus = (overrides: Partial<MemberSpawnStatusEntry> = {}): MemberSpawnStatusEntry => ({
  status: 'waiting',
  launchState: 'runtime_pending_bootstrap',
  agentToolAccepted: true,
  runtimeAlive: false,
  bootstrapConfirmed: false,
  hardFailure: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
  firstSpawnAcceptedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const createRun = (): MemberSpawnStatusRun => ({
  runId: 'run-1',
  teamName: 'team-a',
  progress: {} as never,
  onProgress: vi.fn(),
  expectedMembers: ['api'],
  isLaunch: true,
  provisioningComplete: false,
  memberSpawnStatuses: new Map([['api', baseStatus()]]),
});

const createPorts = (): MemberSpawnStatusMutationPorts<MemberSpawnStatusRun> => ({
  nowIso: () => '2026-01-01T00:01:00.000Z',
  syncMemberTaskActivityForRuntimeTransition: vi.fn(),
  syncMemberLaunchGraceCheck: vi.fn(),
  updateLaunchDiagnostics: vi.fn(),
  appendMemberBootstrapDiagnostic: vi.fn(),
  isCurrentTrackedRun: vi.fn(() => true),
  emitMemberSpawnChange: vi.fn(),
  persistLaunchStateSnapshot: vi.fn(async () => undefined),
});

describe('member spawn snapshot mutations', () => {
  it('emits and persists changed online transitions without diagnostic text', () => {
    const run = createRun();
    const ports = createPorts();

    setMemberSpawnStatusForRun(
      {
        run,
        memberName: 'api',
        status: 'online',
      },
      ports
    );

    expect(run.memberSpawnStatuses.get('api')).toMatchObject({
      status: 'online',
      runtimeAlive: true,
    });
    expect(ports.appendMemberBootstrapDiagnostic).not.toHaveBeenCalled();
    expect(ports.emitMemberSpawnChange).toHaveBeenCalledWith(run, 'api');
    expect(ports.persistLaunchStateSnapshot).toHaveBeenCalledWith(run, 'active');
  });
});
