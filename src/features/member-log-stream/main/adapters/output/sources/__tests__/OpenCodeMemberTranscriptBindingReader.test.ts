import { describe, expect, it, vi } from 'vitest';

import { OpenCodeMemberTranscriptBindingReader } from '../OpenCodeMemberTranscriptBindingReader';

import type { OpenCodeCommittedBootstrapSessionEvidence } from '@main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import type { TeamLaunchFreshness } from '@main/services/team/TeamLaunchFreshness';
import type { TeamLaunchStateReadResult } from '@main/services/team/TeamLaunchStateStore';

function fixture() {
  const evidence: OpenCodeCommittedBootstrapSessionEvidence = {
    state: 'healthy',
    committed: true,
    activeRunId: 'sdk-original',
    diagnostics: [],
    sessions: ['team-lead', 'alice'].map((memberName) => ({
      id: `ses_${memberName.replace('-', '')}`,
      teamName: 'TEST-team',
      memberName,
      laneId: 'primary',
      runId: 'sdk-original',
      source: 'runtime_bootstrap_checkin',
      observedAt: null,
    })),
  };
  let freshness: TeamLaunchFreshness = {
    version: 1,
    teamName: 'TEST-team',
    kind: 'launch',
    runId: 'app-publication',
  };
  let publication: TeamLaunchStateReadResult = {
    status: 'snapshot',
    snapshot: {
      publicationRunId: 'app-publication',
      members: {},
    } as never,
  };
  const readEvidence = vi.fn(async () => evidence);
  const reader = new OpenCodeMemberTranscriptBindingReader({
    readEvidence,
    readFreshness: async () => freshness,
    stateStore: { readResult: async () => publication },
    teamsBasePath: () => '/TEST-only/teams',
  });
  const request = { teamName: 'TEST-team', memberName: 'alice', laneId: 'primary' };
  return {
    reader,
    request,
    evidence,
    readEvidence,
    setFreshness: (next: TeamLaunchFreshness) => {
      freshness = next;
    },
    setPublication: (next: TeamLaunchStateReadResult) => {
      publication = next;
    },
  };
}

describe('original OpenCode transcript identity', () => {
  it('selects exact lead/member SDK identities independently of the app publication ID', async () => {
    const f = fixture();
    for (const memberName of ['team-lead', 'alice']) {
      expect(await f.reader.read({ ...f.request, memberName })).toMatchObject({
        kind: 'bound',
        mode: 'active',
        runId: 'sdk-original',
        laneId: 'primary',
        sessionId: `ses_${memberName.replace('-', '')}`,
      });
    }
    expect(f.readEvidence).toHaveBeenCalledWith({
      teamsBasePath: '/TEST-only/teams',
      teamName: 'TEST-team',
      laneId: 'primary',
    });
    expect(await f.reader.read({ ...f.request, memberName: 'Alice' })).toMatchObject({
      kind: 'unavailable',
    });
  });

  it('refuses partial, conflicting, unreadable and duplicate active evidence', async () => {
    const f = fixture();
    f.evidence.sessions[1]!.runId = null;
    expect(await f.reader.read(f.request)).toMatchObject({
      kind: 'unavailable',
      reason: 'missing',
    });
    f.evidence.sessions[1]!.runId = 'sdk-original';
    f.setPublication({
      status: 'snapshot',
      snapshot: {
        publicationRunId: 'app-publication',
        members: { alice: { name: 'alice', providerId: 'codex' } },
      } as never,
    });
    expect(await f.reader.read(f.request)).toMatchObject({
      kind: 'unavailable',
      reason: 'conflicting',
    });
    f.setPublication({ status: 'unreadable', reason: 'fixture' });
    expect(await f.reader.read(f.request)).toMatchObject({
      kind: 'unavailable',
      reason: 'unreadable',
    });
    f.setPublication({
      status: 'snapshot',
      snapshot: { publicationRunId: 'app-publication', members: {} } as never,
    });
    f.evidence.sessions.push({ ...f.evidence.sessions[1]! });
    expect(await f.reader.read(f.request)).toMatchObject({
      kind: 'unavailable',
      reason: 'ambiguous',
    });
    expect(await f.reader.read({ ...f.request, laneId: undefined })).toMatchObject({
      kind: 'unavailable',
      reason: 'missing',
    });
  });

  it('rejects mismatched app bootstrap candidates and unreadable committed stores', async () => {
    const f = fixture();
    f.evidence.sessions[1]!.appManagedBootstrapCandidate = {
      teamName: 'TEST-team',
      memberName: 'alice',
      laneId: 'primary',
      runId: 'wrong-run',
      runtimeSessionId: 'ses_alice',
    } as never;
    expect(await f.reader.read(f.request)).toMatchObject({
      kind: 'unavailable',
      reason: 'conflicting',
    });
    f.evidence.committed = false;
    expect(await f.reader.read(f.request)).toMatchObject({
      kind: 'unavailable',
      reason: 'unreadable',
    });
  });

  it('keeps only an exact retained stopped tuple eligible for runtime V1/V2 dispatch', async () => {
    const f = fixture();
    const active = await f.reader.read(f.request);
    f.setFreshness({
      version: 1,
      teamName: 'TEST-team',
      kind: 'stop',
      stopId: 'stop-1',
      stoppedRunId: 'app-publication',
      transcriptBindings: [
        { memberName: 'alice', laneId: 'primary', runId: 'sdk-original', sessionId: 'ses_alice' },
      ],
    });
    expect(await f.reader.isCurrent(f.request, active)).toBe(false);
    expect(await f.reader.read(f.request)).toMatchObject({
      kind: 'bound',
      mode: 'stopped',
      runId: 'sdk-original',
      sessionId: 'ses_alice',
    });
    f.setFreshness({ version: 1, teamName: 'TEST-team', kind: 'stop', stopId: 'prepatch' });
    expect(await f.reader.read(f.request)).toMatchObject({
      kind: 'unavailable',
      reason: 'inactive',
    });
  });

  it('invalidates the captured tuple on a successor publication or stop during a read', async () => {
    const f = fixture();
    const before = await f.reader.read(f.request);
    f.setFreshness({ version: 1, teamName: 'TEST-team', kind: 'launch', runId: 'successor-app' });
    expect(await f.reader.isCurrent(f.request, before)).toBe(false);
  });
});
