import { describe, expect, it } from 'vitest';

import {
  findDeliverableOpenCodeRuntimeBootstrapSessionEvidenceInCommittedEvidence,
  getOpenCodeAppMcpTransportMismatchDiagnostic,
  hasMatchingCommittedOpenCodeRuntimeBootstrapSessionEvidence,
  mergeOpenCodeRuntimeSessionRecords,
  parseOpenCodeRuntimeSessionStoreRecords,
  resolveOpenCodeRuntimeBootstrapCheckinIdempotencyFromMember,
} from '../TeamProvisioningOpenCodeBootstrapEvidence';

import type {
  OpenCodeCommittedBootstrapSessionEvidence,
  OpenCodeCommittedBootstrapSessionRecord,
} from '../../opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import type { PersistedTeamLaunchMemberState } from '@shared/types';
import type { OpenCodeAppManagedBootstrapCandidate } from '@shared/types/team';

function buildAppManagedCandidate(
  overrides: Partial<OpenCodeAppManagedBootstrapCandidate> = {}
): OpenCodeAppManagedBootstrapCandidate {
  return {
    schemaVersion: 1,
    source: 'app_managed_bootstrap',
    teamName: 'Team',
    memberName: 'Alice',
    runId: 'run-1',
    laneId: 'lane-a',
    runtimeSessionId: 'session-1',
    messageID: 'message-1',
    contextHash: 'context-hash-1',
    briefingHash: 'briefing-hash-1',
    injectionVerifiedAt: '2026-01-01T00:00:00.000Z',
    candidateAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

function buildCommittedSession(
  overrides: Partial<OpenCodeCommittedBootstrapSessionRecord> = {}
): OpenCodeCommittedBootstrapSessionRecord {
  return {
    id: 'session-1',
    teamName: 'Team',
    memberName: 'Alice',
    laneId: 'lane-a',
    runId: 'run-1',
    observedAt: '2026-01-01T00:00:02.000Z',
    source: 'runtime_bootstrap_checkin',
    ...overrides,
  };
}

function buildCommittedEvidence(
  sessions: OpenCodeCommittedBootstrapSessionRecord[],
  overrides: Partial<OpenCodeCommittedBootstrapSessionEvidence> = {}
): OpenCodeCommittedBootstrapSessionEvidence {
  return {
    state: 'healthy',
    committed: true,
    activeRunId: 'run-1',
    sessions,
    diagnostics: [],
    ...overrides,
  };
}

describe('TeamProvisioningOpenCodeBootstrapEvidence', () => {
  it('merges session records by replacing the same session id and same member/run/lane', () => {
    const replacement = {
      id: 'session-new',
      memberName: 'Alice',
      runId: 'run-1',
      laneId: 'lane-a',
      marker: 'replacement',
    };

    expect(
      mergeOpenCodeRuntimeSessionRecords(
        [
          {
            id: 'session-new',
            memberName: 'Other',
            runId: 'run-other',
            laneId: 'lane-other',
          },
          {
            id: 'session-old',
            memberName: 'Alice',
            runId: 'run-1',
            laneId: 'lane-a',
          },
          {
            id: 'session-keep',
            memberName: 'Alice',
            runId: 'run-2',
            laneId: 'lane-a',
          },
        ],
        replacement
      )
    ).toEqual([
      {
        id: 'session-keep',
        memberName: 'Alice',
        runId: 'run-2',
        laneId: 'lane-a',
      },
      replacement,
    ]);
  });

  it('replaces a stale session when the same member uses different name casing', () => {
    const replacement = {
      id: 'session-new',
      memberName: 'alice',
      runId: 'run-1',
      laneId: 'lane-a',
    };

    expect(
      mergeOpenCodeRuntimeSessionRecords(
        [
          {
            id: 'session-old',
            memberName: 'Alice',
            runId: 'run-1',
            laneId: 'lane-a',
          },
        ],
        replacement
      )
    ).toEqual([replacement]);
  });

  it('matches committed evidence by run, session, source, candidate fields, and member name case', () => {
    const candidate = buildAppManagedCandidate();
    const evidence = buildCommittedEvidence([
      buildCommittedSession({
        memberName: 'Alice',
        source: 'app_managed_bootstrap',
        appManagedBootstrapCandidate: candidate,
      }),
    ]);
    const baseInput = {
      teamName: 'Team',
      runId: 'run-1',
      laneId: 'lane-a',
      memberName: 'alice',
      runtimeSessionId: 'session-1',
      source: 'app_managed_bootstrap' as const,
      appManagedBootstrapCandidate: candidate,
    };

    expect(hasMatchingCommittedOpenCodeRuntimeBootstrapSessionEvidence(evidence, baseInput)).toBe(
      true
    );
    expect(
      hasMatchingCommittedOpenCodeRuntimeBootstrapSessionEvidence(evidence, {
        ...baseInput,
        runId: 'run-2',
      })
    ).toBe(false);
    expect(
      hasMatchingCommittedOpenCodeRuntimeBootstrapSessionEvidence(
        { ...evidence, activeRunId: 'run-2' },
        baseInput
      )
    ).toBe(false);
    expect(
      hasMatchingCommittedOpenCodeRuntimeBootstrapSessionEvidence(evidence, {
        ...baseInput,
        runtimeSessionId: 'session-2',
      })
    ).toBe(false);
    expect(
      hasMatchingCommittedOpenCodeRuntimeBootstrapSessionEvidence(evidence, {
        ...baseInput,
        source: 'runtime_bootstrap_checkin',
      })
    ).toBe(false);

    for (const field of ['runtimeSessionId', 'messageID', 'contextHash', 'briefingHash'] as const) {
      expect(
        hasMatchingCommittedOpenCodeRuntimeBootstrapSessionEvidence(evidence, {
          ...baseInput,
          appManagedBootstrapCandidate: {
            ...candidate,
            [field]: `changed-${field}`,
          },
        })
      ).toBe(false);
    }
  });

  it('returns app MCP transport diagnostics only when committed and current hashes differ', () => {
    const session = buildCommittedSession({ appMcpTransportHash: 'hash-a' });

    expect(getOpenCodeAppMcpTransportMismatchDiagnostic(session, { urlHash: 'hash-a' })).toBeNull();
    expect(getOpenCodeAppMcpTransportMismatchDiagnostic(session, null)).toBeNull();
    expect(
      getOpenCodeAppMcpTransportMismatchDiagnostic(
        buildCommittedSession({ appMcpTransportHash: undefined }),
        { urlHash: 'hash-b' }
      )
    ).toBeNull();
    expect(getOpenCodeAppMcpTransportMismatchDiagnostic(session, { urlHash: '' })).toBeNull();
    expect(getOpenCodeAppMcpTransportMismatchDiagnostic(session, { urlHash: 'hash-b' })).toBe(
      'opencode_app_mcp_transport_changed:hash-a->hash-b'
    );
  });

  it('finds deliverable evidence for the active run with case-insensitive member matching', () => {
    const session = buildCommittedSession({ memberName: 'Alice' });
    const evidence = buildCommittedEvidence([session]);
    const input = {
      teamName: 'Team',
      runId: 'run-1',
      laneId: 'lane-a',
      memberName: 'ALICE',
    };

    expect(
      findDeliverableOpenCodeRuntimeBootstrapSessionEvidenceInCommittedEvidence(evidence, input)
    ).toBe(session);
    expect(
      findDeliverableOpenCodeRuntimeBootstrapSessionEvidenceInCommittedEvidence(
        { ...evidence, activeRunId: 'run-2' },
        input
      )
    ).toBeNull();
    expect(
      findDeliverableOpenCodeRuntimeBootstrapSessionEvidenceInCommittedEvidence(evidence, {
        ...input,
        memberName: 'Bob',
      })
    ).toBeNull();
  });

  it('parses wrapped and direct session stores while treating missing arrays and invalid JSON as empty', () => {
    expect(
      parseOpenCodeRuntimeSessionStoreRecords(
        JSON.stringify({
          data: {
            sessions: [{ id: 'wrapped-1' }, null, 'bad', ['bad'], { id: 'wrapped-2' }],
          },
        })
      )
    ).toEqual([{ id: 'wrapped-1' }, { id: 'wrapped-2' }]);
    expect(
      parseOpenCodeRuntimeSessionStoreRecords(
        JSON.stringify({
          sessions: [{ id: 'direct-1' }],
        })
      )
    ).toEqual([{ id: 'direct-1' }]);
    expect(parseOpenCodeRuntimeSessionStoreRecords(JSON.stringify({ data: {} }))).toEqual([]);
    expect(parseOpenCodeRuntimeSessionStoreRecords(JSON.stringify({ sessions: 'nope' }))).toEqual(
      []
    );
    expect(parseOpenCodeRuntimeSessionStoreRecords('{not-json')).toEqual([]);
  });

  it('resolves bootstrap check-in idempotency from persisted member evidence', () => {
    const previousMember = {
      runtimeSessionId: 'session-1',
      runtimeRunId: 'run-1',
      bootstrapConfirmed: true,
    } as PersistedTeamLaunchMemberState;

    expect(
      resolveOpenCodeRuntimeBootstrapCheckinIdempotencyFromMember({
        previousMember,
        runId: 'run-1',
        runtimeSessionId: 'session-1',
      }).state
    ).toBe('duplicate');
    expect(
      resolveOpenCodeRuntimeBootstrapCheckinIdempotencyFromMember({
        previousMember,
        runId: 'run-1',
        runtimeSessionId: 'session-2',
      }).state
    ).toBe('conflict');
    expect(
      resolveOpenCodeRuntimeBootstrapCheckinIdempotencyFromMember({
        previousMember,
        runId: 'run-2',
        runtimeSessionId: 'session-2',
      }).state
    ).toBe('new');
  });
});
