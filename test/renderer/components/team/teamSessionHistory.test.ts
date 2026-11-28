import { describe, expect, it, vi } from 'vitest';

import { hostTeamSelectionKey } from '@features/agent-backend/contracts';
import { projectTeamTasks } from '@renderer/components/team/kanban/teamTaskProjection';
import { loadTeamSessionHistory, sessionsForTeam, teamSessionWindow } from '@renderer/components/team/teamSessionHistory';

import type { HostTeamSessionSummary } from '@features/agent-backend/contracts';
import type { Session } from '@renderer/types/data';
import type { TeamTaskWithKanban } from '@shared/types';

const hostKey = hostTeamSelectionKey('TEST-execution');
const owned: HostTeamSessionSummary = {
  kind: 'host_session', id: 'host-session-' + 'a'.repeat(64), startedAt: 1000,
  window: { start: 1000, end: 2000 }, clock: 'qualified', members: 1, generations: 2,
  isOngoing: false, gaps: [],
};
const foreign: Session = {
  id: 'unrelated-legacy-session', projectId: 'shared-project', projectPath: '/TEST/shared',
  createdAt: 1500, hasSubagents: false, messageCount: 1,
};
function fixture() {
  return {
    teams: { getHostTeamSessions: vi.fn().mockResolvedValue({ kind: 'team-session-history', revision: 'a'.repeat(64), sessions: [owned] }) },
    getSessionsByIds: vi.fn().mockResolvedValue([foreign]),
    getSessionsPaginated: vi.fn().mockResolvedValue({ sessions: [foreign], nextCursor: null, hasMore: false, totalCount: 1 }),
  };
}
describe('Team Sessions original source routing', () => {
  it('a Host Team in the same project never adopts foreign legacy sessions', async () => {
    const api = fixture();
    expect(await loadTeamSessionHistory(api, hostKey, 'shared-project', {})).toEqual([owned]);
    expect(api.teams.getHostTeamSessions).toHaveBeenCalledWith(hostKey);
    expect(api.getSessionsByIds).not.toHaveBeenCalled();
    expect(api.getSessionsPaginated).not.toHaveBeenCalled();
    expect(sessionsForTeam(hostKey, { leadSessionId: foreign.id }, [foreign, owned])).toEqual([owned]);
  });
  it('empty, failed, missing or unindexed Host reads cannot fall back to project sessions', async () => {
    const api = fixture();
    api.teams.getHostTeamSessions.mockResolvedValueOnce({ kind: 'team-session-history', revision: 'b'.repeat(64), sessions: [] });
    expect(await loadTeamSessionHistory(api, hostKey, null, {})).toEqual([]);
    api.teams.getHostTeamSessions.mockRejectedValueOnce(new Error('original owner unavailable'));
    await expect(loadTeamSessionHistory(api, hostKey, 'shared-project', {})).rejects.toThrow('original owner unavailable');
    await expect(loadTeamSessionHistory({ ...api, teams: {} }, hostKey, 'shared-project', {})).rejects.toThrow('unavailable');
    expect(api.getSessionsByIds).not.toHaveBeenCalled();
    expect(api.getSessionsPaginated).not.toHaveBeenCalled();
  });
  it('legacy teams preserve targeted reads and the original light project fallback', async () => {
    const api = fixture();
    expect(await loadTeamSessionHistory(api, 'legacy-team', 'shared-project', {})).toEqual([foreign]);
    expect(api.getSessionsPaginated).toHaveBeenCalledWith('shared-project', null, 20,
      { includeTotalCount: false, prefilterAll: false, metadataLevel: 'light' });
    await loadTeamSessionHistory(api, 'legacy-team', 'shared-project', { leadSessionId: foreign.id });
    expect(api.getSessionsByIds).toHaveBeenCalledWith('shared-project', [foreign.id], { metadataLevel: 'light' });
    expect(api.teams.getHostTeamSessions).not.toHaveBeenCalled();
  });
  it('launch clocks include chat-created and old tasks independently of retained input/event attribution', () => {
    const task = (id: string, createdAt?: number): TeamTaskWithKanban => ({
      id, subject: id, status: 'pending', ...(createdAt === undefined ? {} : { createdAt: new Date(createdAt).toISOString() }),
    });
    const tasks = [task('before', 999), task('chat-created', 1200), task('older-than-ring', 1500),
      task('never-started', 1700), task('undated'), task('next-launch', 2000)];
    const filter = { sessionId: owned.id, selectedOwners: new Set<string>(), columns: new Set<never>() };
    expect(projectTeamTasks(tasks, filter, teamSessionWindow(owned.id, [owned])).map(row => row.id))
      .toEqual(['chat-created', 'older-than-ring', 'never-started', 'undated']);
    const unknown: HostTeamSessionSummary = { ...owned, clock: 'unqualified', window: null };
    expect(teamSessionWindow(unknown.id, [unknown])).toBeNull();
    expect(projectTeamTasks(tasks, filter, teamSessionWindow(unknown.id, [unknown]))).toEqual(tasks);
  });
  it('legacy time windows and mixed-source rejection retain their original semantics', () => {
    const newer = { ...foreign, id: 'newer', createdAt: 3000 };
    expect(teamSessionWindow(foreign.id, [newer, foreign])).toEqual({ start: 1500, end: 3000 });
    expect(sessionsForTeam('legacy-team', {}, [owned, foreign])).toEqual([foreign]);
  });
});
