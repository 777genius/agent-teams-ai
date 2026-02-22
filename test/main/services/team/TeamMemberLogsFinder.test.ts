import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import * as fs from 'fs/promises';

import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';
import { TeamMemberLogsFinder } from '../../../../src/main/services/team/TeamMemberLogsFinder';

describe('TeamMemberLogsFinder', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('returns subagent logs for a member and lead session for team-lead', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-logs-'));
    setClaudeBasePathOverride(tmpDir);

    const teamName = 't1';
    const projectPath = '/Users/test/my-proj';
    const projectId = '-Users-test-my-proj';
    const leadSessionId = 's1';

    await fs.mkdir(path.join(tmpDir, 'teams', teamName), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamName, 'config.json'),
      JSON.stringify(
        {
          name: teamName,
          projectPath,
          leadSessionId,
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'bob', agentType: 'general-purpose' },
          ],
        },
        null,
        2
      ),
      'utf8'
    );

    const projectRoot = path.join(tmpDir, 'projects', projectId);
    await fs.mkdir(path.join(projectRoot, leadSessionId, 'subagents'), { recursive: true });

    await fs.writeFile(
      path.join(projectRoot, `${leadSessionId}.jsonl`),
      [
        JSON.stringify({
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'user',
          message: { role: 'user', content: 'Lead start' },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    await fs.writeFile(
      path.join(projectRoot, leadSessionId, 'subagents', 'agent-abc1234.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-01-01T00:00:01.000Z',
          type: 'user',
          message: { role: 'user', content: 'You are bob, a developer on team "t1" (t1).' },
        }),
        JSON.stringify({
          timestamp: '2026-01-01T00:00:02.000Z',
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const finder = new TeamMemberLogsFinder();

    const bobLogs = await finder.findMemberLogs(teamName, 'bob');
    expect(bobLogs).toHaveLength(1);
    expect(bobLogs[0]?.kind).toBe('subagent');
    if (bobLogs[0]?.kind === 'subagent') {
      expect(bobLogs[0].subagentId).toBe('abc1234');
      expect(bobLogs[0].sessionId).toBe(leadSessionId);
      expect(bobLogs[0].projectId).toBe(projectId);
      expect(bobLogs[0].memberName?.toLowerCase()).toBe('bob');
    }

    const leadLogs = await finder.findMemberLogs(teamName, 'team-lead');
    expect(leadLogs.some((l) => l.kind === 'lead_session')).toBe(true);
    const lead = leadLogs.find((l) => l.kind === 'lead_session');
    expect(lead?.sessionId).toBe(leadSessionId);
    expect(lead?.projectId).toBe(projectId);
  });

  it('detects member via teammate_id attribute in <teammate-message> tag', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-logs-'));
    setClaudeBasePathOverride(tmpDir);

    const teamName = 't2';
    const projectPath = '/Users/test/proj2';
    const projectId = '-Users-test-proj2';
    const leadSessionId = 's2';

    await fs.mkdir(path.join(tmpDir, 'teams', teamName), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamName, 'config.json'),
      JSON.stringify({
        name: teamName,
        projectPath,
        leadSessionId,
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'alice', agentType: 'general-purpose' },
        ],
      }),
      'utf8'
    );

    const projectRoot = path.join(tmpDir, 'projects', projectId);
    await fs.mkdir(path.join(projectRoot, leadSessionId, 'subagents'), { recursive: true });

    // Lead session file
    await fs.writeFile(
      path.join(projectRoot, `${leadSessionId}.jsonl`),
      JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', content: 'Start' },
      }) + '\n',
      'utf8'
    );

    // Subagent file using <teammate-message> format (no "You are" pattern)
    await fs.writeFile(
      path.join(projectRoot, leadSessionId, 'subagents', 'agent-xyz789.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-01-01T00:00:01.000Z',
          type: 'user',
          message: {
            role: 'user',
            content:
              '<teammate-message teammate_id="alice" color="green" summary="Implement feature X">Please implement the login page</teammate-message>',
          },
        }),
        JSON.stringify({
          timestamp: '2026-01-01T00:00:05.000Z',
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it' }] },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const finder = new TeamMemberLogsFinder();
    const aliceLogs = await finder.findMemberLogs(teamName, 'alice');

    expect(aliceLogs).toHaveLength(1);
    expect(aliceLogs[0]?.kind).toBe('subagent');
    if (aliceLogs[0]?.kind === 'subagent') {
      expect(aliceLogs[0].subagentId).toBe('xyz789');
      expect(aliceLogs[0].description).toBe('Implement feature X');
    }
  });

  it('reports accurate messageCount from full file (not limited by scan lines)', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-logs-'));
    setClaudeBasePathOverride(tmpDir);

    const teamName = 't3';
    const projectPath = '/Users/test/proj3';
    const projectId = '-Users-test-proj3';
    const leadSessionId = 's3';

    await fs.mkdir(path.join(tmpDir, 'teams', teamName), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamName, 'config.json'),
      JSON.stringify({
        name: teamName,
        projectPath,
        leadSessionId,
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'carol', agentType: 'general-purpose' },
        ],
      }),
      'utf8'
    );

    const projectRoot = path.join(tmpDir, 'projects', projectId);
    await fs.mkdir(path.join(projectRoot, leadSessionId, 'subagents'), { recursive: true });

    await fs.writeFile(
      path.join(projectRoot, `${leadSessionId}.jsonl`),
      JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', content: 'Go' },
      }) + '\n',
      'utf8'
    );

    // Build a 200-line subagent file — well beyond ATTRIBUTION_SCAN_LINES (50)
    const lines: string[] = [];
    // First line: spawn prompt with teammate_id
    lines.push(
      JSON.stringify({
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'user',
        message: {
          role: 'user',
          content:
            '<teammate-message teammate_id="carol" color="yellow" summary="Big task">Do 200 things</teammate-message>',
        },
      })
    );
    // Lines 2-200: alternating assistant/user messages
    for (let i = 2; i <= 200; i++) {
      const role = i % 2 === 0 ? 'assistant' : 'user';
      lines.push(
        JSON.stringify({
          timestamp: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
          type: role,
          message: { role, content: `Message ${i}` },
        })
      );
    }

    await fs.writeFile(
      path.join(projectRoot, leadSessionId, 'subagents', 'agent-big123.jsonl'),
      lines.join('\n') + '\n',
      'utf8'
    );

    const finder = new TeamMemberLogsFinder();
    const carolLogs = await finder.findMemberLogs(teamName, 'carol');

    expect(carolLogs).toHaveLength(1);
    expect(carolLogs[0]?.kind).toBe('subagent');
    // Full file has 200 messages — must NOT be capped at 50 or 100
    expect(carolLogs[0]?.messageCount).toBe(200);
  });
});
