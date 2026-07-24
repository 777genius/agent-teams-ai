import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import { WorkspaceMountBinding, WorkspaceRegistration } from '@features/workspace-registry';
import {
  type AuthoritativeTeamRuntimeEvidenceSource,
  createMountBindingScopedRuntimeEvidencePort,
  TeamRuntimeEvidenceUnavailableError,
} from '@main/composition/hosted/teamRuntimeEvidenceSource';
import {
  createQueryContext,
  parseActorId,
  parseAuthorizedScope,
  parseBootId,
  parseDeploymentId,
  parseRequestId,
  parseSessionId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type { TeamIdentityRecord } from '@features/internal-storage/contracts';

const NOW_MS = 1_800_000_000_000;
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'1'.repeat(32)}`);
const TEAM_ID = parseTeamId(`team_${'2'.repeat(32)}`);
const BOOT_ID = parseBootId(`boot_${'3'.repeat(32)}`);
const DEPLOYMENT_ID = parseDeploymentId(`deployment_${'4'.repeat(32)}`);

function identity(): TeamIdentityRecord {
  return Object.freeze({
    teamId: TEAM_ID,
    state: 'active',
    legacyKey: 'team-alpha' as TeamIdentityRecord['legacyKey'],
    directoryFingerprint: '5'.repeat(64) as TeamIdentityRecord['directoryFingerprint'],
    workspaceBinding: Object.freeze({ workspaceId: WORKSPACE_ID, generation: 1 }),
    adoptionIntentId: `adoption_${'6'.repeat(32)}` as TeamIdentityRecord['adoptionIntentId'],
    identityChecksum: '7'.repeat(64) as TeamIdentityRecord['identityChecksum'],
    createdAt: '2026-07-18T08:00:00.000Z',
    activatedAt: '2026-07-18T08:02:00.000Z',
    tombstonedAt: null,
  });
}

function scope() {
  const registration = new WorkspaceRegistration({
    schemaVersion: 1,
    registrationKey: 'registration-runtime-evidence',
    workspaceId: WORKSPACE_ID,
    displayName: 'Runtime evidence',
    registrationRevision: 1,
    declaredRootHash: '8'.repeat(64),
    enabled: true,
  });
  const mountBinding = new WorkspaceMountBinding({
    registration,
    bootId: BOOT_ID,
    mountGeneration: 1,
    declaredRootHash: registration.declaredRootHash,
    observedAt: NOW_MS,
    health: 'read-only',
    allowedOperations: [],
  });
  const runtimeInstance = createRuntimeInstanceContext({
    deploymentId: DEPLOYMENT_ID,
    bootId: BOOT_ID,
    claudeRoot: { kind: 'claude', reference: '/runtime/team-lifecycle-read/claude' },
    appDataRoot: { kind: 'app-data', reference: '/runtime/team-lifecycle-read/app-data' },
    workspaceRoots: [{ kind: 'workspace', reference: '/runtime/team-lifecycle-read/workspace' }],
    tempRoot: { kind: 'temp', reference: '/runtime/team-lifecycle-read/temp' },
    logsRoot: { kind: 'logs', reference: '/runtime/team-lifecycle-read/logs' },
  });
  return { mountBinding, runtimeInstance };
}

function context(signal: AbortSignal = new AbortController().signal) {
  return createQueryContext({
    actorId: parseActorId(`actor_${'9'.repeat(32)}`),
    sessionId: parseSessionId('session_team-runtime-evidence'),
    deploymentId: DEPLOYMENT_ID,
    bootId: BOOT_ID,
    requestId: parseRequestId('request_team-runtime-evidence'),
    authorizedScope: parseAuthorizedScope('scope_team-lifecycle.read'),
    deadlineAtMs: NOW_MS + 10_000,
    signal,
  });
}

function port(
  options: {
    readonly source?: AuthoritativeTeamRuntimeEvidenceSource;
    readonly nowMs?: () => number;
  } = {}
) {
  return createMountBindingScopedRuntimeEvidencePort({
    ...scope(),
    identitiesForCurrentSnapshot: () => [identity()],
    nowMs: options.nowMs ?? (() => NOW_MS),
    source: options.source,
  });
}

describe('team mount-scoped runtime evidence', () => {
  it('returns typed unavailable when no authoritative source exists', async () => {
    const runtime = port();

    await expect(runtime.getRuntimeState('team-alpha', context())).rejects.toBeInstanceOf(
      TeamRuntimeEvidenceUnavailableError
    );
    await expect(runtime.getAliveTeams(context())).rejects.toBeInstanceOf(
      TeamRuntimeEvidenceUnavailableError
    );
  });

  it.each([true, false])('preserves authoritative isAlive=%s evidence', async (isAlive) => {
    const readRuntimeState = vi.fn(() => Promise.resolve({ teamId: TEAM_ID, isAlive }));
    const runtime = port({
      source: {
        readRuntimeState,
        listAliveTeamIds: () => Promise.resolve(isAlive ? [TEAM_ID] : []),
      },
    });

    await expect(runtime.getRuntimeState('team-alpha', context())).resolves.toEqual({
      teamName: 'team-alpha',
      isAlive,
    });
    expect(readRuntimeState).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          workspaceId: WORKSPACE_ID,
          mountGeneration: 1,
          deploymentId: DEPLOYMENT_ID,
          bootId: BOOT_ID,
        },
        identity: {
          teamId: TEAM_ID,
          legacyTeamName: 'team-alpha',
          directoryFingerprint: '5'.repeat(64),
        },
      })
    );
    await expect(runtime.getAliveTeams(context())).resolves.toEqual(isAlive ? ['team-alpha'] : []);
  });

  it('rejects alive evidence for a team outside the admitted identity snapshot', async () => {
    const foreignTeamId = parseTeamId(`team_${'a'.repeat(32)}`);
    const runtime = port({
      source: {
        readRuntimeState: () => Promise.resolve({ teamId: TEAM_ID, isAlive: true }),
        listAliveTeamIds: () => Promise.resolve([foreignTeamId]),
      },
    });

    await expect(runtime.getAliveTeams(context())).rejects.toThrow('team-runtime-evidence-invalid');
  });

  it('checks cancellation immediately after successful runtime evidence I/O', async () => {
    const controller = new AbortController();
    const source: AuthoritativeTeamRuntimeEvidenceSource = {
      readRuntimeState: async () => {
        controller.abort();
        return { teamId: TEAM_ID, isAlive: true };
      },
      listAliveTeamIds: () => Promise.resolve([]),
    };

    await expect(
      port({ source }).getRuntimeState('team-alpha', context(controller.signal))
    ).rejects.toThrow('team-lifecycle-read-request-cancelled');
  });

  it('checks cancellation immediately after failed runtime evidence I/O', async () => {
    const controller = new AbortController();
    const source: AuthoritativeTeamRuntimeEvidenceSource = {
      readRuntimeState: async () => {
        controller.abort();
        throw new Error('source-failed');
      },
      listAliveTeamIds: () => Promise.resolve([]),
    };

    await expect(
      port({ source }).getRuntimeState('team-alpha', context(controller.signal))
    ).rejects.toThrow('team-lifecycle-read-request-cancelled');
  });

  it('checks the deadline immediately after alive-team evidence I/O', async () => {
    let nowMs = NOW_MS;
    const source: AuthoritativeTeamRuntimeEvidenceSource = {
      readRuntimeState: () => Promise.resolve({ teamId: TEAM_ID, isAlive: true }),
      listAliveTeamIds: async () => {
        nowMs = NOW_MS + 10_000;
        return [TEAM_ID];
      },
    };

    await expect(port({ source, nowMs: () => nowMs }).getAliveTeams(context())).rejects.toThrow(
      'team-lifecycle-read-request-expired'
    );
  });
});
