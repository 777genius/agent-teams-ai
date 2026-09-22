import { describe, expect, it } from 'vitest';

import {
  buildMemberSpawnFailureMessage,
  buildMemberSpawnStatusTransition,
  buildMemberSpawnTranscriptConfirmationTransition,
} from '../TeamProvisioningMemberSpawnTransitions';

import type { MemberSpawnStatusEntry } from '@shared/types';

const baseStatus = (overrides: Partial<MemberSpawnStatusEntry> = {}): MemberSpawnStatusEntry => ({
  status: 'offline',
  launchState: 'starting',
  agentToolAccepted: false,
  runtimeAlive: false,
  bootstrapConfirmed: false,
  hardFailure: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('member spawn transition helpers', () => {
  it('formats immediate spawn failure messages for launches and restarts', () => {
    expect(
      buildMemberSpawnFailureMessage({
        memberName: 'api',
        resultPreview: ' terminal exited ',
      })
    ).toBe('Teammate "api" failed to start: terminal exited');

    expect(
      buildMemberSpawnFailureMessage({
        memberName: 'api',
        resultPreview: '',
        pendingRestart: { requestedAt: '2026-01-01T00:01:00.000Z' },
      })
    ).toBe(
      'Failed to restart teammate "api": Teammate spawn failed immediately after launch.'
    );
  });

  it('resets tracked runtime evidence when a spawn starts', () => {
    const transition = buildMemberSpawnStatusTransition({
      previous: baseStatus({
        status: 'online',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        firstSpawnAcceptedAt: '2026-01-01T00:00:30.000Z',
        lastHeartbeatAt: '2026-01-01T00:00:45.000Z',
        livenessSource: 'heartbeat',
        livenessKind: 'confirmed_bootstrap',
      }),
      requestedStatus: 'spawning',
      updatedAt: '2026-01-01T00:02:00.000Z',
      pendingRestart: { requestedAt: '2026-01-01T00:01:30.000Z' },
    });

    expect(transition.changed).toBe(true);
    expect(transition.next).toMatchObject({
      status: 'spawning',
      launchState: 'starting',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      firstSpawnAcceptedAt: '2026-01-01T00:01:30.000Z',
      runtimeDiagnostic: 'Manual restart is already in progress; waiting for teammate bootstrap.',
      runtimeDiagnosticSeverity: 'info',
    });
    expect(transition.next.lastHeartbeatAt).toBeUndefined();
    expect(transition.diagnosticText).toBe('Agent tool invoked');
    expect(transition.shouldClearPendingRestart).toBe(false);
  });

  it('projects waiting to online when runtime evidence already exists', () => {
    const transition = buildMemberSpawnStatusTransition({
      previous: baseStatus({
        status: 'online',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: true,
        livenessSource: 'process',
      }),
      requestedStatus: 'waiting',
      updatedAt: '2026-01-01T00:02:00.000Z',
    });

    expect(transition.status).toBe('online');
    expect(transition.next).toMatchObject({
      status: 'online',
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: false,
      livenessSource: 'process',
    });
    expect(transition.diagnosticText).toBe(
      'runtime process is alive, teammate check-in not yet received'
    );
    expect(transition.shouldClearPendingRestart).toBe(true);
  });

  it('confirms heartbeat liveness and keeps the newest heartbeat timestamp', () => {
    const transition = buildMemberSpawnStatusTransition({
      previous: baseStatus({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        firstSpawnAcceptedAt: '2026-01-01T00:00:30.000Z',
        lastHeartbeatAt: '2026-01-01T00:01:30.000Z',
      }),
      requestedStatus: 'online',
      updatedAt: '2026-01-01T00:02:00.000Z',
      livenessSource: 'heartbeat',
      heartbeatAt: '2026-01-01T00:01:00.000Z',
    });

    expect(transition.next).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      bootstrapConfirmed: true,
      livenessSource: 'heartbeat',
      firstSpawnAcceptedAt: '2026-01-01T00:00:30.000Z',
      lastHeartbeatAt: '2026-01-01T00:01:30.000Z',
    });
    expect(transition.runtimeTransitionAt).toBe('2026-01-01T00:01:00.000Z');
    expect(transition.diagnosticText).toBe('bootstrap confirmed via first heartbeat');
  });

  it('reports unchanged transitions without changing persistence-sensitive fields', () => {
    const previous = baseStatus({
      status: 'online',
      launchState: 'confirmed_alive',
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      livenessSource: 'heartbeat',
      firstSpawnAcceptedAt: '2026-01-01T00:00:30.000Z',
      lastHeartbeatAt: '2026-01-01T00:01:00.000Z',
    });

    const transition = buildMemberSpawnStatusTransition({
      previous,
      requestedStatus: 'online',
      updatedAt: '2026-01-01T00:02:00.000Z',
      livenessSource: 'heartbeat',
      heartbeatAt: '2026-01-01T00:01:00.000Z',
    });

    expect(transition.changed).toBe(false);
    expect(transition.next.updatedAt).toBe('2026-01-01T00:02:00.000Z');
  });

  it('confirms transcript and runtime-proof bootstrap evidence', () => {
    const transcript = buildMemberSpawnTranscriptConfirmationTransition({
      previous: baseStatus({
        status: 'waiting',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
      }),
      updatedAt: '2026-01-01T00:02:00.000Z',
      observedAt: '2026-01-01T00:01:30.000Z',
      source: 'transcript',
    });

    expect(transcript.next).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      agentToolAccepted: true,
      runtimeAlive: false,
      bootstrapConfirmed: true,
      firstSpawnAcceptedAt: '2026-01-01T00:01:30.000Z',
      lastHeartbeatAt: '2026-01-01T00:01:30.000Z',
    });
    expect(transcript.runtimeTransitionAt).toBe('2026-01-01T00:02:00.000Z');
    expect(transcript.diagnosticText).toBe('bootstrap confirmed via transcript');

    const runtimeProof = buildMemberSpawnTranscriptConfirmationTransition({
      previous: baseStatus(),
      updatedAt: '2026-01-01T00:02:00.000Z',
      observedAt: '2026-01-01T00:01:30.000Z',
      source: 'runtime-proof',
    });

    expect(runtimeProof.next).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      bootstrapConfirmed: true,
      livenessSource: 'process',
    });
    expect(runtimeProof.runtimeTransitionAt).toBe('2026-01-01T00:01:30.000Z');
    expect(runtimeProof.diagnosticText).toBe('bootstrap confirmed via runtime proof');
  });
});
