import { reapCursorAgentLeadTreesForStoppedTeam } from '@main/services/team/lifecycle/teamLeadProcessTreeReap';
import {
  configureCursorAgentAtomicReapBridge,
  type CursorAgentAtomicReapPort,
} from '@main/services/team/opencode/bridge/CursorAgentAtomicReapBridge';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AttributedCursorAgentProcess } from '@main/services/team/opencode/bridge/CursorAgentAttributionRecords';

const teamsBasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-lead-reap-'));
vi.mock('@main/utils/pathDecoder', () => ({ getTeamsBasePath: () => teamsBasePath }));

function record(
  kind: 'cursor-agent' | 'readiness-probe' = 'cursor-agent'
): AttributedCursorAgentProcess {
  return {
    record: {
      schemaVersion: 1,
      kind,
      attributionId: 'aaaa1111aaaa1111aaaa1111aaaa1111',
      pid: 4321,
      parentPid: 4320,
      startedAtMs: 1000,
      startTimeToleranceMs: 2000,
      nativeStartToken: null,
      workspacePath: '/different/snapshot/workspace',
      cwd: '/different/snapshot/workspace',
      appInstanceId: 'fixture',
      appProfileScope: 'fixture',
      hostPid: 999,
      runtimeVersion: 'fixture',
      writtenAtMs: 1001,
      exitedAtMs: null,
    },
    host: null,
    owners: [
      {
        teamId: 'another-live-team',
        teamName: null,
        laneId: null,
        memberName: null,
        runId: null,
        sessionId: null,
        createdAt: null,
        updatedAt: null,
      },
    ],
  };
}

const readAttributedProcesses = vi.fn<() => Promise<readonly AttributedCursorAgentProcess[]>>();
const reapUnleasedCursorAgentTrees =
  vi.fn<CursorAgentAtomicReapPort['reapUnleasedCursorAgentTrees']>();
const workspace = path.join(teamsBasePath, 'fixture-workspace');
const note =
  'cursor-agent attribution: 1 runtime process record(s) available, 1 cursor-agent record(s); diagnostic snapshot only';
function input() {
  return {
    teamName: 'stopped',
    otherAliveTeams: ['another-live-team'],
    requestedAtMs: 2000,
    cursorAgentAttribution: { readAttributedProcesses },
    cursorAgentAtomicReap: { reapUnleasedCursorAgentTrees },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  configureCursorAgentAtomicReapBridge(null);
  fs.mkdirSync(path.join(teamsBasePath, 'stopped'), { recursive: true });
  fs.writeFileSync(
    path.join(teamsBasePath, 'stopped', 'config.json'),
    JSON.stringify({ projectPath: workspace })
  );
  readAttributedProcesses.mockResolvedValue([record()]);
  reapUnleasedCursorAgentTrees.mockResolvedValue({
    contractVersion: 1,
    status: 'completed',
    killedPids: [8100],
    diagnostics: [],
  });
});
afterEach(() => configureCursorAgentAtomicReapBridge(null));
afterAll(() => fs.rmSync(teamsBasePath, { recursive: true, force: true }));

describe('runtime-owned stopped-team cursor cleanup', () => {
  it('forwards only the team workspace and stop fence, regardless of snapshot owners or live-team lists', async () => {
    const result = await reapCursorAgentLeadTreesForStoppedTeam(input());
    expect(reapUnleasedCursorAgentTrees).toHaveBeenCalledExactlyOnceWith({
      contractVersion: 1,
      reason: 'team-stop',
      ownedWorkspaceCwds: [workspace],
      startedBeforeMs: 2000,
    });
    expect(result).toEqual({
      killedPids: [8100],
      incomplete: false,
      diagnostics: [note, 'Reaped 1 cursor-agent process(es)'],
    });
  });

  it('does not dispatch without a readable workspace', async () => {
    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      ...input(),
      teamName: 'missing',
    });
    expect(result).toEqual({
      killedPids: [],
      incomplete: false,
      diagnostics: ['Skipped cursor-agent reap: this team has no readable project path'],
    });
    expect(reapUnleasedCursorAgentTrees).not.toHaveBeenCalled();
  });

  it.each([{ records: [] }, { records: [record('readiness-probe')] }])(
    'does not dispatch when there are no cursor-agent records: %j',
    async ({ records }) => {
      readAttributedProcesses.mockResolvedValue(records);
      const result = await reapCursorAgentLeadTreesForStoppedTeam(input());
      expect(result.killedPids).toEqual([]);
      expect(result.incomplete).toBe(false);
      expect(result.diagnostics).toContain(
        'Skipped cursor-agent reap: no cursor-agent attribution record'
      );
      expect(reapUnleasedCursorAgentTrees).not.toHaveBeenCalled();
    }
  );

  it('preserves the runtime relaunch veto', async () => {
    reapUnleasedCursorAgentTrees.mockResolvedValue({
      contractVersion: 1,
      status: 'kept',
      killedPids: [],
      diagnostics: ['Kept: active relaunch lease'],
    });
    expect(await reapCursorAgentLeadTreesForStoppedTeam(input())).toEqual({
      killedPids: [],
      incomplete: false,
      diagnostics: [note, 'Kept: active relaunch lease'],
    });
  });

  it.each(['kept', 'incomplete'] as const)(
    'preserves partial killed counts and exact diagnostics for %s',
    async (status) => {
      reapUnleasedCursorAgentTrees.mockResolvedValue({
        contractVersion: 1,
        status,
        killedPids: [8100],
        diagnostics: ['Kept pid=8200: lease active', 'identity unavailable'],
      });
      expect(await reapCursorAgentLeadTreesForStoppedTeam(input())).toEqual({
        killedPids: [8100],
        incomplete: status === 'incomplete',
        diagnostics: [
          note,
          'Reaped 1 cursor-agent process(es)',
          'Kept pid=8200: lease active',
          'identity unavailable',
        ],
      });
    }
  );

  it.each(['unsupported', 'unknown', 'incomplete'] as const)(
    'fails closed on %s',
    async (status) => {
      reapUnleasedCursorAgentTrees.mockResolvedValue({
        contractVersion: 1,
        status,
        killedPids: [],
        diagnostics: ['runtime unavailable'],
      });
      expect(await reapCursorAgentLeadTreesForStoppedTeam(input())).toEqual({
        killedPids: [],
        incomplete: true,
        diagnostics: [note, 'runtime unavailable'],
      });
      expect(reapUnleasedCursorAgentTrees).toHaveBeenCalledOnce();
    }
  );

  it('reports a rejected injected port without retrying', async () => {
    reapUnleasedCursorAgentTrees.mockRejectedValue(new Error('offline'));
    expect(await reapCursorAgentLeadTreesForStoppedTeam(input())).toEqual({
      killedPids: [],
      incomplete: true,
      diagnostics: [note, 'cursor-agent runtime reap failed: offline'],
    });
    expect(reapUnleasedCursorAgentTrees).toHaveBeenCalledOnce();
  });

  it('uses an inert default when no bridge is configured', async () => {
    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      ...input(),
      cursorAgentAtomicReap: undefined,
    });
    expect(result.killedPids).toEqual([]);
    expect(result.incomplete).toBe(true);
    expect(result.diagnostics.join(' ')).toContain('not configured');
    expect(reapUnleasedCursorAgentTrees).not.toHaveBeenCalled();
  });
});
