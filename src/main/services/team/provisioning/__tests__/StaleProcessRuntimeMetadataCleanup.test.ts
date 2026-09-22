import { describe, expect, it } from 'vitest';

import { resolveTeamMemberRuntimeLiveness } from '../../TeamRuntimeLivenessResolver';
import {
  clearStaleProcessRuntimeMetadataFromMember,
  collectStaleProcessRuntimeMetadataCleanupCandidate,
  hasDirectProcessRuntimeMetadataForStaleCleanup,
  shouldSkipStaleProcessRuntimeMetadataCleanupForRuntimeGuard,
  STALE_PROCESS_RUNTIME_METADATA_DIAGNOSTIC,
} from '../StaleProcessRuntimeMetadataCleanup';

import type { RuntimeProcessTableRow } from '@features/tmux-installer/main';

const baseCandidateInput = {
  memberName: 'tom',
  providerId: 'codex',
  backendType: 'process',
  agentId: 'tom@signal-ops-2',
  tmuxPaneId: 'process:37749',
  runtimePid: 37749,
  runtimeSessionId: undefined,
  livenessKind: 'stale_metadata',
  runtimeDiagnostic: STALE_PROCESS_RUNTIME_METADATA_DIAGNOSTIC,
  processTableAvailable: true,
  isLead: false,
  isRemoved: false,
} as const;

function createRuntimeMember(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'tom',
    agentId: 'tom@signal-ops-2',
    provider: 'codex',
    providerId: 'codex',
    model: 'gpt-5.5',
    role: 'developer',
    prompt: 'Build things',
    color: 'yellow',
    cwd: '/repo',
    subscriptions: ['team-lead'],
    backendType: 'process',
    tmuxPaneId: 'process:37749',
    runtimePid: 37749,
    bootstrapExpectedAfter: '2026-05-16T18:35:52.562Z',
    bootstrapProofToken: 'token',
    bootstrapRunId: 'run-1',
    bootstrapProofMode: 'native_app_managed_context',
    bootstrapContextHash: 'context-hash',
    bootstrapBriefingHash: 'briefing-hash',
    bootstrapRuntimeEventsPath: '/repo/.agent-teams/tom.runtime.jsonl',
    ...overrides,
  };
}

describe('stale process runtime metadata cleanup planner', () => {
  it('clears only stale direct-process runtime fields and preserves member identity', () => {
    const candidate = collectStaleProcessRuntimeMetadataCleanupCandidate(baseCandidateInput);

    expect(candidate).toEqual({
      memberName: 'tom',
      runtimePid: 37749,
      processPaneId: 'process:37749',
      agentId: 'tom@signal-ops-2',
    });

    const result = clearStaleProcessRuntimeMetadataFromMember(createRuntimeMember(), candidate!);

    expect(result.changed).toBe(true);
    expect(result.member).toMatchObject({
      name: 'tom',
      agentId: 'tom@signal-ops-2',
      provider: 'codex',
      providerId: 'codex',
      model: 'gpt-5.5',
      role: 'developer',
      prompt: 'Build things',
      color: 'yellow',
      cwd: '/repo',
      subscriptions: ['team-lead'],
      backendType: 'process',
    });
    expect(result.member.runtimePid).toBeUndefined();
    expect(result.member.tmuxPaneId).toBeUndefined();
    expect(result.member.bootstrapRunId).toBeUndefined();
    expect(result.member.bootstrapRuntimeEventsPath).toBeUndefined();
  });

  it('skips OpenCode members', () => {
    expect(
      collectStaleProcessRuntimeMetadataCleanupCandidate({
        ...baseCandidateInput,
        providerId: 'opencode',
      })
    ).toBeNull();

    const candidate = collectStaleProcessRuntimeMetadataCleanupCandidate(baseCandidateInput)!;
    const result = clearStaleProcessRuntimeMetadataFromMember(
      createRuntimeMember({ providerId: 'opencode', provider: 'opencode' }),
      candidate
    );

    expect(result.changed).toBe(false);
    expect(result.member.runtimePid).toBe(37749);
  });

  it('skips normal tmux pane metadata', () => {
    expect(
      collectStaleProcessRuntimeMetadataCleanupCandidate({
        ...baseCandidateInput,
        backendType: 'tmux',
        tmuxPaneId: '%12',
      })
    ).toBeNull();
  });

  it('skips mismatched process pane metadata', () => {
    expect(
      collectStaleProcessRuntimeMetadataCleanupCandidate({
        ...baseCandidateInput,
        tmuxPaneId: 'process:99999',
      })
    ).toBeNull();
  });

  it('matches only direct-process runtime metadata shapes', () => {
    expect(
      hasDirectProcessRuntimeMetadataForStaleCleanup({
        backendType: 'process',
        tmuxPaneId: 'process:37749',
        runtimePid: 37749,
      })
    ).toBe(true);
    expect(
      hasDirectProcessRuntimeMetadataForStaleCleanup({
        backendType: 'process',
        tmuxPaneId: 'process:99999',
        runtimePid: 37749,
      })
    ).toBe(false);
    expect(
      hasDirectProcessRuntimeMetadataForStaleCleanup({
        backendType: 'tmux',
        tmuxPaneId: '%12',
        runtimePid: 37749,
      })
    ).toBe(false);
  });

  it('skips active or uncertain cleanup guards', () => {
    expect(
      collectStaleProcessRuntimeMetadataCleanupCandidate({
        ...baseCandidateInput,
        processTableAvailable: false,
      })
    ).toBeNull();
    expect(
      collectStaleProcessRuntimeMetadataCleanupCandidate({
        ...baseCandidateInput,
        isLead: true,
      })
    ).toBeNull();
    expect(
      collectStaleProcessRuntimeMetadataCleanupCandidate({
        ...baseCandidateInput,
        isRemoved: true,
      })
    ).toBeNull();
    expect(
      collectStaleProcessRuntimeMetadataCleanupCandidate({
        ...baseCandidateInput,
        runtimeSessionId: 'session-1',
      })
    ).toBeNull();

    expect(
      shouldSkipStaleProcessRuntimeMetadataCleanupForRuntimeGuard({ hasTrackedRun: true })
    ).toBe(true);
    expect(
      shouldSkipStaleProcessRuntimeMetadataCleanupForRuntimeGuard({
        hasRuntimeAdapterRun: true,
      })
    ).toBe(true);
    expect(
      shouldSkipStaleProcessRuntimeMetadataCleanupForRuntimeGuard({
        hasActiveLaunchState: true,
      })
    ).toBe(true);
    expect(shouldSkipStaleProcessRuntimeMetadataCleanupForRuntimeGuard({})).toBe(false);
  });

  it('skips lane metadata but allows direct bootstrap run ids', () => {
    expect(
      collectStaleProcessRuntimeMetadataCleanupCandidate({
        ...baseCandidateInput,
        laneId: 'secondary:bob',
      })
    ).toBeNull();
    expect(
      collectStaleProcessRuntimeMetadataCleanupCandidate({
        ...baseCandidateInput,
        runtimeRunId: 'bootstrap-run-1',
      })?.runtimePid
    ).toBe(37749);

    const candidate = collectStaleProcessRuntimeMetadataCleanupCandidate(baseCandidateInput)!;
    const result = clearStaleProcessRuntimeMetadataFromMember(
      createRuntimeMember({ laneId: 'secondary:bob' }),
      candidate
    );

    expect(result.changed).toBe(false);
    expect(result.member.runtimePid).toBe(37749);
  });

  it('does not clear if the process table shows the same pid is alive', () => {
    const candidate = collectStaleProcessRuntimeMetadataCleanupCandidate(baseCandidateInput)!;
    const processRows: RuntimeProcessTableRow[] = [
      { pid: 37749, ppid: 1, command: 'node some-other-process.js' },
    ];

    const processStillExists = processRows.some((row) => row.pid === candidate.runtimePid);

    expect(processStillExists).toBe(true);
  });
});

describe('stale process runtime metadata cleanup runtime flow', () => {
  it('plans cleanup for stale metadata when process table is available and no pid exists', () => {
    const resolved = resolveTeamMemberRuntimeLiveness({
      teamName: 'signal-ops-2',
      memberName: 'tom',
      agentId: 'tom@signal-ops-2',
      providerId: 'codex',
      backendType: 'process',
      tmuxPaneId: 'process:37749',
      persistedRuntimePid: 37749,
      processRows: [],
      processTableAvailable: true,
      nowIso: '2026-05-28T00:00:00.000Z',
    });

    const candidate = collectStaleProcessRuntimeMetadataCleanupCandidate({
      ...baseCandidateInput,
      livenessKind: resolved.livenessKind,
      runtimeDiagnostic: resolved.runtimeDiagnostic,
      runtimePid: resolved.pid,
    });

    expect(resolved.livenessKind).toBe('stale_metadata');
    expect(candidate?.runtimePid).toBe(37749);
  });

  it('does not plan cleanup for registered-only metadata', () => {
    const resolved = resolveTeamMemberRuntimeLiveness({
      teamName: 'signal-ops-2',
      memberName: 'bob',
      agentId: 'bob@signal-ops-2',
      providerId: 'opencode',
      backendType: 'process',
      processRows: [],
      processTableAvailable: true,
      nowIso: '2026-05-28T00:00:00.000Z',
    });

    expect(resolved.livenessKind).toBe('registered_only');
    expect(
      collectStaleProcessRuntimeMetadataCleanupCandidate({
        ...baseCandidateInput,
        memberName: 'bob',
        providerId: 'opencode',
        runtimePid: undefined,
        livenessKind: resolved.livenessKind,
        runtimeDiagnostic: resolved.runtimeDiagnostic,
      })
    ).toBeNull();
  });

  it('does not plan cleanup for verified runtime process evidence', () => {
    const resolved = resolveTeamMemberRuntimeLiveness({
      teamName: 'signal-ops-2',
      memberName: 'tom',
      agentId: 'tom@signal-ops-2',
      providerId: 'codex',
      backendType: 'process',
      persistedRuntimePid: 37749,
      processRows: [
        {
          pid: 55555,
          ppid: 1,
          command: 'node runtime.js --team-name signal-ops-2 --agent-id tom@signal-ops-2',
        },
      ],
      processTableAvailable: true,
      nowIso: '2026-05-28T00:00:00.000Z',
    });

    expect(resolved.livenessKind).toBe('runtime_process');
    expect(
      collectStaleProcessRuntimeMetadataCleanupCandidate({
        ...baseCandidateInput,
        runtimePid: resolved.pid,
        livenessKind: resolved.livenessKind,
        runtimeDiagnostic: resolved.runtimeDiagnostic,
      })
    ).toBeNull();
  });

  it('does not plan cleanup for confirmed bootstrap evidence', () => {
    const resolved = resolveTeamMemberRuntimeLiveness({
      teamName: 'signal-ops-2',
      memberName: 'alice',
      agentId: 'alice@signal-ops-2',
      providerId: 'anthropic',
      backendType: 'process',
      trackedSpawnStatus: {
        status: 'online',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        updatedAt: '2026-05-28T00:00:00.000Z',
      },
      processRows: [],
      processTableAvailable: true,
      nowIso: '2026-05-28T00:00:00.000Z',
    });

    expect(resolved.livenessKind).toBe('confirmed_bootstrap');
    expect(
      collectStaleProcessRuntimeMetadataCleanupCandidate({
        ...baseCandidateInput,
        memberName: 'alice',
        providerId: 'anthropic',
        runtimePid: undefined,
        livenessKind: resolved.livenessKind,
        runtimeDiagnostic: resolved.runtimeDiagnostic,
      })
    ).toBeNull();
  });
});
