import { describe, expect, it } from 'vitest';

import { hostTeamRunId } from '../../../src/features/agent-backend/contracts/teamRunSelection';
import { hostTeamSelectionKey } from '../../../src/features/agent-backend/contracts/teamSelection';
import { cloneHostProjectProgress, hostProjectProgressOwners, projectHostProjectProgress } from '../../../src/features/agent-backend/renderer/hostProjectProvisioningOwner';
import { captureHostProvisioningStatusRead } from '../../../src/renderer/store/team/teamRuntimeRunAdoption';

import type { BackendConnectionSnapshot } from '../../../src/features/agent-backend/contracts/connections';
import type { TeamProvisioningProgress } from '../../../src/shared/types/team';

function fixture() {
  const logical = hostTeamSelectionKey('TEST-logical'), child = hostTeamSelectionKey('TEST-child');
  const runId = hostTeamRunId('TEST-child', 'TEST-launch', 'TEST-revision');
  const snapshot: BackendConnectionSnapshot = { state: 'ready', bindings: [
    { handle: { handleId: 'TEST-logical' }, label: 'TEST logical', members: [],
      ownerResourceRef: 'TEST-owner', teamResourceRef: 'TEST-logical-ref', projectContextMode: 'per_project' },
    { handle: { handleId: 'TEST-child' }, label: 'TEST execution', members: [],
      ownerResourceRef: 'TEST-owner', teamResourceRef: 'TEST-child-ref', projectContextMode: 'shared',
      projectContext: { logicalHandleId: 'TEST-logical', projectPath: '/TEST/work', workContextId: 'TEST-work' } },
  ] };
  const state = { teamByName: { [logical]: {}, [child]: {} },
    currentRuntimeRunIdByTeam: { [logical]: runId } as Record<string, string | null>,
    currentProvisioningRunIdByTeam: { [logical]: runId } as Record<string, string | null> };
  let current = true;
  const physical = { teamName: child, runId, state: 'ready', message: 'Ready',
    startedAt: '2026-11-25T00:00:00.000Z', updatedAt: '2026-11-25T00:00:01.000Z' } as TeamProvisioningProgress;
  const progress = projectHostProjectProgress(physical, snapshot, () => { if (!current) throw new Error('Original context changed'); });
  return { logical, child, runId, state, physical, progress,
    capture: () => captureHostProvisioningStatusRead(runId, () => state, () => () => current),
    invalidate: () => { current = false; } };
}

describe('logical project progress retains local physical provenance', () => {
  it('maps only the display owner and preserves the actual execution run through an authorized observer clone', () => {
    const f = fixture(), current = f.capture(), clone = cloneHostProjectProgress(f.progress);
    expect(f.progress.teamName).toBe(f.logical);
    expect(f.progress.runId).toBe(f.runId);
    expect(hostProjectProgressOwners(clone)).toEqual([f.logical, f.child]);
    expect(current(clone)).toBe(true);
    expect(current({ ...clone })).toBe(false);
    expect(hostProjectProgressOwners({ ...clone })).toBeUndefined();
  });

  it('rejects a changed logical pin and a late-added owner instead of adopting a new owner after await', () => {
    const f = fixture(), current = f.capture();
    f.state.currentRuntimeRunIdByTeam[f.logical] = hostTeamRunId('TEST-child', 'TEST-new-launch', 'TEST-revision');
    expect(current(f.progress)).toBe(false);
    const next = fixture(), captured = next.capture();
    next.state.currentProvisioningRunIdByTeam[hostTeamSelectionKey('TEST-late-owner')] = next.runId;
    expect(captured(next.progress)).toBe(false);
  });

  it('rejects stale original proof or DTO identity mutation without granting synthetic progress authority', () => {
    const f = fixture(), current = f.capture();
    f.invalidate();
    expect(hostProjectProgressOwners(f.progress)).toBeNull();
    expect(current(f.progress)).toBe(false);
    const altered = fixture();
    altered.progress.teamName = altered.child;
    expect(hostProjectProgressOwners(altered.progress)).toBeNull();
  });
});
