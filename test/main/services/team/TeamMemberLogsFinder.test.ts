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

  it('listAttributedSubagentFiles only returns files from the current lead session for live tracking', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-logs-'));
    setClaudeBasePathOverride(tmpDir);

    const teamName = 'live-tools';
    const projectPath = '/Users/test/live-tools';
    const projectId = '-Users-test-live-tools';
    const currentSessionId = 'session-current';
    const oldSessionId = 'session-old';

    await fs.mkdir(path.join(tmpDir, 'teams', teamName), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamName, 'config.json'),
      JSON.stringify(
        {
          name: teamName,
          projectPath,
          leadSessionId: currentSessionId,
          sessionHistory: [oldSessionId],
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'alice', agentType: 'general-purpose' },
          ],
        },
        null,
        2
      ),
      'utf8'
    );

    const projectRoot = path.join(tmpDir, 'projects', projectId);
    await fs.mkdir(path.join(projectRoot, currentSessionId, 'subagents'), { recursive: true });
    await fs.mkdir(path.join(projectRoot, oldSessionId, 'subagents'), { recursive: true });

    const attributedLog = [
      JSON.stringify({
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'user',
        message: { role: 'user', content: `You are alice, a developer on team "${teamName}" (${teamName}).` },
      }),
      JSON.stringify({
        timestamp: '2026-01-01T00:00:02.000Z',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
      }),
    ].join('\n') + '\n';

    await fs.writeFile(
      path.join(projectRoot, currentSessionId, 'subagents', 'agent-current.jsonl'),
      attributedLog,
      'utf8'
    );
    await fs.writeFile(
      path.join(projectRoot, oldSessionId, 'subagents', 'agent-old.jsonl'),
      attributedLog,
      'utf8'
    );

    const finder = new TeamMemberLogsFinder();
    const files = await finder.listAttributedSubagentFiles(teamName);

    expect(files).toHaveLength(1);
    expect(files[0]?.sessionId).toBe(currentSessionId);
    expect(files[0]?.filePath).toContain(path.join(currentSessionId, 'subagents'));
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

  it('routing.sender overrides teammate_id="team-lead" from spawn message', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-logs-'));
    setClaudeBasePathOverride(tmpDir);

    const teamName = 'tA';
    const projectPath = '/Users/test/projA';
    const projectId = '-Users-test-projA';
    const leadSessionId = 'sA';

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

    // Subagent file: first message has teammate_id="team-lead" (sender),
    // but routing.sender="carol" (the actual agent) appears later.
    await fs.writeFile(
      path.join(projectRoot, leadSessionId, 'subagents', 'agent-carol01.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-01-01T00:00:01.000Z',
          type: 'user',
          message: {
            role: 'user',
            content:
              '<teammate-message teammate_id="team-lead" color="yellow" summary="Fix button layout">You are carol, a developer.</teammate-message>',
          },
        }),
        JSON.stringify({
          timestamp: '2026-01-01T00:00:02.000Z',
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it' }] },
        }),
        JSON.stringify({
          timestamp: '2026-01-01T00:00:03.000Z',
          toolUseResult: { routing: { sender: 'carol' } },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const finder = new TeamMemberLogsFinder();
    const carolLogs = await finder.findMemberLogs(teamName, 'carol');

    expect(carolLogs).toHaveLength(1);
    expect(carolLogs[0]?.kind).toBe('subagent');
    if (carolLogs[0]?.kind === 'subagent') {
      expect(carolLogs[0].subagentId).toBe('carol01');
      expect(carolLogs[0].description).toBe('Fix button layout');
    }
  });

  it('process.team.memberName overrides teammate_id and text_mention', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-logs-'));
    setClaudeBasePathOverride(tmpDir);

    const teamName = 'tB';
    const projectPath = '/Users/test/projB';
    const projectId = '-Users-test-projB';
    const leadSessionId = 'sB';

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
          { name: 'bob', agentType: 'general-purpose' },
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

    // Subagent file: teammate_id="alice" but process.team.memberName="bob"
    await fs.writeFile(
      path.join(projectRoot, leadSessionId, 'subagents', 'agent-bob01.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-01-01T00:00:01.000Z',
          type: 'user',
          message: {
            role: 'user',
            content:
              '<teammate-message teammate_id="alice" color="green" summary="Refactor code">Do the work</teammate-message>',
          },
        }),
        JSON.stringify({
          timestamp: '2026-01-01T00:00:02.000Z',
          process: { team: { memberName: 'bob' } },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const finder = new TeamMemberLogsFinder();
    const bobLogs = await finder.findMemberLogs(teamName, 'bob');

    expect(bobLogs).toHaveLength(1);
    expect(bobLogs[0]?.kind).toBe('subagent');
    if (bobLogs[0]?.kind === 'subagent') {
      expect(bobLogs[0].subagentId).toBe('bob01');
    }

    // Verify alice does NOT get this file
    const aliceLogs = await finder.findMemberLogs(teamName, 'alice');
    const aliceSubagents = aliceLogs.filter((l) => l.kind === 'subagent');
    expect(aliceSubagents).toHaveLength(0);
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

  it('findLogsForTask does not treat arbitrary "#<id>" as a task reference', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-task-logs-'));
    setClaudeBasePathOverride(tmpDir);

    const teamName = 't4';
    const projectPath = '/Users/test/proj4';
    const projectId = '-Users-test-proj4';
    const leadSessionId = 's4';

    await fs.mkdir(path.join(tmpDir, 'teams', teamName), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamName, 'config.json'),
      JSON.stringify({
        name: teamName,
        projectPath,
        leadSessionId,
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'bob', agentType: 'general-purpose' },
        ],
      }),
      'utf8'
    );

    const projectRoot = path.join(tmpDir, 'projects', projectId);
    await fs.mkdir(path.join(projectRoot, leadSessionId, 'subagents'), { recursive: true });

    // Lead session mentions "PR #1" but NOT a task reference
    await fs.writeFile(
      path.join(projectRoot, `${leadSessionId}.jsonl`),
      [
        JSON.stringify({
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Fix PR #1 please' }] },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    // Subagent session includes a structured taskId reference (should match)
    await fs.writeFile(
      path.join(projectRoot, leadSessionId, 'subagents', 'agent-abc111.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-01-01T00:00:01.000Z',
          type: 'user',
          message: { role: 'user', content: 'You are bob, a developer on team "t4" (t4).' },
        }),
        JSON.stringify({
          timestamp: '2026-01-01T00:00:02.000Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                name: 'TaskUpdate',
                input: { team_name: teamName, taskId: '1', status: 'in_progress' },
              },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const finder = new TeamMemberLogsFinder();
    const logs = await finder.findLogsForTask(teamName, '1');

    // Should include the subagent log, but must NOT include the lead session just because it had "PR #1"
    expect(logs.some((l) => l.kind === 'lead_session')).toBe(false);
    expect(logs.some((l) => l.kind === 'subagent')).toBe(true);
  });

  it('findLogsForTask includes only owner sessions overlapping workIntervals', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-task-owner-since-'));
    setClaudeBasePathOverride(tmpDir);

    const teamName = 't5';
    const projectPath = '/Users/test/proj5';
    const projectId = '-Users-test-proj5';
    const leadSessionId = 's5';

    await fs.mkdir(path.join(tmpDir, 'teams', teamName), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamName, 'config.json'),
      JSON.stringify({
        name: teamName,
        projectPath,
        leadSessionId,
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'bob', agentType: 'general-purpose' },
          { name: 'alice', agentType: 'general-purpose' },
        ],
      }),
      'utf8'
    );

    const projectRoot = path.join(tmpDir, 'projects', projectId);
    await fs.mkdir(path.join(projectRoot, leadSessionId, 'subagents'), { recursive: true });

    // Alice file references taskId 10 via structured tool input (so results is non-empty).
    await fs.writeFile(
      path.join(projectRoot, leadSessionId, 'subagents', 'agent-alice10.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-01-01T00:00:01.000Z',
          type: 'user',
          message: { role: 'user', content: 'You are alice, a developer on team "t5" (t5).' },
        }),
        JSON.stringify({
          timestamp: '2026-01-01T00:00:02.000Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                name: 'TaskUpdate',
                input: { team_name: teamName, taskId: '10', status: 'pending' },
              },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    // Bob has an old session (should NOT be pulled in by owner include).
    await fs.writeFile(
      path.join(projectRoot, leadSessionId, 'subagents', 'agent-bob-old.jsonl'),
      [
        JSON.stringify({
          timestamp: '2025-12-31T00:00:00.000Z',
          type: 'user',
          message: { role: 'user', content: 'You are bob, a developer on team "t5" (t5).' },
        }),
        JSON.stringify({
          timestamp: '2025-12-31T00:00:01.000Z',
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Old work' }] },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    // Bob has a recent session within workIntervals (should be included).
    await fs.writeFile(
      path.join(projectRoot, leadSessionId, 'subagents', 'agent-bob-new.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-01-01T12:00:00.000Z',
          type: 'user',
          message: { role: 'user', content: 'You are bob, a developer on team "t5" (t5).' },
        }),
        JSON.stringify({
          timestamp: '2026-01-01T12:00:01.000Z',
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'New work' }] },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const finder = new TeamMemberLogsFinder();
    const logs = await finder.findLogsForTask(teamName, '10', {
      owner: 'bob',
      status: 'in_progress',
      intervals: [
        { startedAt: '2026-01-01T10:00:00.000Z', completedAt: '2026-01-01T13:00:00.000Z' },
      ],
    });

    const bobDescriptions = logs
      .filter((l) => l.kind === 'subagent' && l.memberName?.toLowerCase() === 'bob')
      .map((l) => l.description);

    expect(bobDescriptions.some((d) => d.includes('Old'))).toBe(false);
    // At least one bob log should be present (the recent one).
    expect(logs.some((l) => l.kind === 'subagent' && l.memberName?.toLowerCase() === 'bob')).toBe(
      true
    );
  });

  it('findLogsForTask does not auto-include owner sessions when owner is team-lead', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-task-lead-owner-'));
    setClaudeBasePathOverride(tmpDir);

    const teamName = 't6';
    const projectPath = '/Users/test/proj6';
    const projectId = '-Users-test-proj6';
    const leadSessionId = 's6';

    await fs.mkdir(path.join(tmpDir, 'teams', teamName), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamName, 'config.json'),
      JSON.stringify({
        name: teamName,
        projectPath,
        leadSessionId,
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );

    const projectRoot = path.join(tmpDir, 'projects', projectId);
    await fs.mkdir(path.join(projectRoot, leadSessionId, 'subagents'), { recursive: true });

    // Lead session exists but does NOT reference taskId 42.
    await fs.writeFile(
      path.join(projectRoot, `${leadSessionId}.jsonl`),
      JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
      }) + '\n',
      'utf8'
    );

    const finder = new TeamMemberLogsFinder();
    const logs = await finder.findLogsForTask(teamName, '42', {
      owner: 'team-lead',
      status: 'in_progress',
      intervals: [{ startedAt: '2026-01-01T10:00:00.000Z' }],
    });

    // We only want sessions that explicitly reference the task id.
    expect(logs).toHaveLength(0);
  });

  it('findLogsForTask does not mix tasks across teams sharing a projectPath', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-task-cross-team-'));
    setClaudeBasePathOverride(tmpDir);

    const projectPath = '/Users/test/shared-proj';
    const projectId = '-Users-test-shared-proj';
    const sessionId = 's-shared';

    // Two teams pointing at the same project path (realistic when multiple teams work in one repo)
    const teamA = 'team-a';
    const teamB = 'team-b';

    await fs.mkdir(path.join(tmpDir, 'teams', teamA), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'teams', teamB), { recursive: true });

    await fs.writeFile(
      path.join(tmpDir, 'teams', teamA, 'config.json'),
      JSON.stringify({
        name: teamA,
        projectPath,
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'alice', agentType: 'general-purpose' },
        ],
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamB, 'config.json'),
      JSON.stringify({
        name: teamB,
        projectPath,
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'bob', agentType: 'general-purpose' },
        ],
      }),
      'utf8'
    );

    const projectRoot = path.join(tmpDir, 'projects', projectId);
    await fs.mkdir(path.join(projectRoot, sessionId, 'subagents'), { recursive: true });

    // Team A subagent referencing taskId 9 (no team_name in tool input, as in Solo/older runs)
    await fs.writeFile(
      path.join(projectRoot, sessionId, 'subagents', 'agent-a1.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-01-01T00:00:01.000Z',
          type: 'user',
          message: {
            role: 'user',
            content: 'You are alice, a developer on team "team-a" (team-a).',
          },
        }),
        JSON.stringify({
          timestamp: '2026-01-01T00:00:02.000Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                name: 'TaskUpdate',
                input: { taskId: '9', status: 'in_progress' },
              },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    // Team B subagent referencing taskId 9 (must NOT be included when querying team-a)
    await fs.writeFile(
      path.join(projectRoot, sessionId, 'subagents', 'agent-b1.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-01-01T00:00:03.000Z',
          type: 'user',
          message: { role: 'user', content: 'You are bob, a developer on team "team-b" (team-b).' },
        }),
        JSON.stringify({
          timestamp: '2026-01-01T00:00:04.000Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                name: 'TaskUpdate',
                input: { taskId: '9', status: 'in_progress' },
              },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const finder = new TeamMemberLogsFinder();
    const logsForA = await finder.findLogsForTask(teamA, '9');

    expect(
      logsForA.some((l) => l.kind === 'subagent' && l.memberName?.toLowerCase() === 'alice')
    ).toBe(true);
    expect(
      logsForA.some((l) => l.kind === 'subagent' && l.memberName?.toLowerCase() === 'bob')
    ).toBe(false);
  });

  it('detects structured task markers and ignores legacy teamctl command lines', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-marker-logs-'));

    const structuredPath = path.join(tmpDir, 'structured.jsonl');
    await fs.writeFile(
      structuredPath,
      JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'task_start',
              input: { teamName: 'demo', taskId: 'task-42' },
            },
          ],
        },
      }) + '\n',
      'utf8'
    );

    const legacyPath = path.join(tmpDir, 'legacy.jsonl');
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'node \"teamctl.js\" --team demo task start task-42' },
            },
          ],
        },
      }) + '\n',
      'utf8'
    );

    const noisePath = path.join(tmpDir, 'noise.jsonl');
    await fs.writeFile(
      noisePath,
      JSON.stringify({
        timestamp: '2026-01-01T00:00:02.000Z',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'No task markers here' }] },
      }) + '\n',
      'utf8'
    );

    const finder = new TeamMemberLogsFinder();

    await expect(finder.hasTaskUpdateMarker(structuredPath, 'task-42')).resolves.toBe(true);
    await expect(finder.hasTaskUpdateMarker(legacyPath, 'task-42')).resolves.toBe(false);
    await expect(finder.hasTaskUpdateMarker(noisePath, 'task-42')).resolves.toBe(false);
  });

  it('detects fully-qualified agent-teams task markers in JSONL', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-markers-'));
    const qualifiedPath = path.join(tmpDir, 'qualified.jsonl');

    await fs.writeFile(
      qualifiedPath,
      JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'mcp__agent-teams__task_start',
              input: { teamName: 'demo', taskId: 'task-42' },
            },
          ],
        },
      }) + '\n',
      'utf8'
    );

    const finder = new TeamMemberLogsFinder();

    await expect(finder.hasTaskUpdateMarker(qualifiedPath, 'task-42')).resolves.toBe(true);
  });

  it('findLogFileRefsForTask returns correct refs for a task', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-refs-'));
    setClaudeBasePathOverride(tmpDir);

    const teamName = 'refs-team';
    const projectPath = '/Users/test/ref-proj';
    const projectId = '-Users-test-ref-proj';
    const sessionId = 'sr1';

    await fs.mkdir(path.join(tmpDir, 'teams', teamName), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamName, 'config.json'),
      JSON.stringify({
        name: teamName,
        projectPath,
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'dev', agentType: 'general-purpose' },
        ],
      }),
      'utf8'
    );

    const projectRoot = path.join(tmpDir, 'projects', projectId);
    await fs.mkdir(path.join(projectRoot, sessionId, 'subagents'), { recursive: true });

    await fs.writeFile(
      path.join(projectRoot, sessionId, 'subagents', 'agent-ref1.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-01-01T00:00:01.000Z',
          type: 'user',
          message: {
            role: 'user',
            content: 'You are dev, a developer on team "refs-team" (refs-team).',
          },
        }),
        JSON.stringify({
          timestamp: '2026-01-01T00:00:02.000Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', name: 'TaskUpdate', input: { taskId: '5', status: 'in_progress' } },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const finder = new TeamMemberLogsFinder();
    const refs = await finder.findLogFileRefsForTask(teamName, '5');

    expect(refs).toHaveLength(1);
    expect(refs[0].memberName.toLowerCase()).toBe('dev');
    expect(refs[0].filePath).toContain('agent-ref1.jsonl');
  });

  it('findLogFileRefsForTask does not mix tasks across teams sharing a projectPath', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-refs-cross-'));
    setClaudeBasePathOverride(tmpDir);

    const projectPath = '/Users/test/shared-ref-proj';
    const projectId = '-Users-test-shared-ref-proj';
    const sessionId = 'sref';
    const teamA = 'ref-a';
    const teamB = 'ref-b';

    await fs.mkdir(path.join(tmpDir, 'teams', teamA), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'teams', teamB), { recursive: true });

    await fs.writeFile(
      path.join(tmpDir, 'teams', teamA, 'config.json'),
      JSON.stringify({
        name: teamA,
        projectPath,
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'alice', agentType: 'general-purpose' },
        ],
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamB, 'config.json'),
      JSON.stringify({
        name: teamB,
        projectPath,
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'bob', agentType: 'general-purpose' },
        ],
      }),
      'utf8'
    );

    const projectRoot = path.join(tmpDir, 'projects', projectId);
    await fs.mkdir(path.join(projectRoot, sessionId, 'subagents'), { recursive: true });

    // Team A agent with task 7
    await fs.writeFile(
      path.join(projectRoot, sessionId, 'subagents', 'agent-ra.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-01-01T00:00:01.000Z',
          type: 'user',
          message: { role: 'user', content: 'You are alice, a developer on team "ref-a" (ref-a).' },
        }),
        JSON.stringify({
          timestamp: '2026-01-01T00:00:02.000Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', name: 'TaskUpdate', input: { taskId: '7', status: 'completed' } },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    // Team B agent with same task id 7
    await fs.writeFile(
      path.join(projectRoot, sessionId, 'subagents', 'agent-rb.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-01-01T00:00:03.000Z',
          type: 'user',
          message: { role: 'user', content: 'You are bob, a developer on team "ref-b" (ref-b).' },
        }),
        JSON.stringify({
          timestamp: '2026-01-01T00:00:04.000Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', name: 'TaskUpdate', input: { taskId: '7', status: 'completed' } },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const finder = new TeamMemberLogsFinder();
    const refsA = await finder.findLogFileRefsForTask(teamA, '7');

    expect(refsA.some((r) => r.memberName.toLowerCase() === 'alice')).toBe(true);
    expect(refsA.some((r) => r.memberName.toLowerCase() === 'bob')).toBe(false);
  });

  it('findLogFileRefsForTask does not duplicate refs for owner logs', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-refs-dedup-'));
    setClaudeBasePathOverride(tmpDir);

    const teamName = 'dedup-team';
    const projectPath = '/Users/test/dedup-proj';
    const projectId = '-Users-test-dedup-proj';
    const sessionId = 'sdd';

    await fs.mkdir(path.join(tmpDir, 'teams', teamName), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamName, 'config.json'),
      JSON.stringify({
        name: teamName,
        projectPath,
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'dev', agentType: 'general-purpose' },
        ],
      }),
      'utf8'
    );

    const projectRoot = path.join(tmpDir, 'projects', projectId);
    await fs.mkdir(path.join(projectRoot, sessionId, 'subagents'), { recursive: true });

    // Agent file that mentions task AND belongs to owner 'dev'
    await fs.writeFile(
      path.join(projectRoot, sessionId, 'subagents', 'agent-dd1.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-01-01T00:00:01.000Z',
          type: 'user',
          message: {
            role: 'user',
            content: 'You are dev, a developer on team "dedup-team" (dedup-team).',
          },
        }),
        JSON.stringify({
          timestamp: '2026-01-01T00:00:02.000Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', name: 'TaskUpdate', input: { taskId: '3', status: 'in_progress' } },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const finder = new TeamMemberLogsFinder();
    // File found as direct task hit AND as owner log — should appear once
    const refs = await finder.findLogFileRefsForTask(teamName, '3', {
      owner: 'dev',
      status: 'in_progress',
    });

    // Count refs with this file path — should be exactly 1
    const deduped = refs.filter((r) => r.filePath.includes('agent-dd1.jsonl'));
    expect(deduped).toHaveLength(1);
    expect(deduped[0].memberName.toLowerCase()).toBe('dev');
  });

  it('findMemberLogs returns results sorted by startTime descending', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-sort-'));
    setClaudeBasePathOverride(tmpDir);

    const teamName = 'sort-team';
    const projectPath = '/Users/test/sort-proj';
    const projectId = '-Users-test-sort-proj';
    const sessionId = 'ss1';

    await fs.mkdir(path.join(tmpDir, 'teams', teamName), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamName, 'config.json'),
      JSON.stringify({
        name: teamName,
        projectPath,
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'dev', agentType: 'general-purpose' },
        ],
      }),
      'utf8'
    );

    const projectRoot = path.join(tmpDir, 'projects', projectId);
    await fs.mkdir(path.join(projectRoot, sessionId, 'subagents'), { recursive: true });

    // 3 agent files with different startTimes: 00:03, 00:01, 00:02
    for (const [id, ts] of [
      ['agent-s1.jsonl', '2026-01-01T00:00:03.000Z'],
      ['agent-s2.jsonl', '2026-01-01T00:00:01.000Z'],
      ['agent-s3.jsonl', '2026-01-01T00:00:02.000Z'],
    ] as const) {
      await fs.writeFile(
        path.join(projectRoot, sessionId, 'subagents', id),
        [
          JSON.stringify({
            timestamp: ts,
            type: 'user',
            message: {
              role: 'user',
              content: `You are dev, a developer on team "${teamName}" (${teamName}).`,
            },
          }),
          JSON.stringify({
            timestamp: ts,
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
          }),
        ].join('\n') + '\n',
        'utf8'
      );
    }

    const finder = new TeamMemberLogsFinder();
    const logs = await finder.findMemberLogs(teamName, 'dev');

    expect(logs).toHaveLength(3);
    // Must be descending: 00:03, 00:02, 00:01
    const times = logs.map((l) => new Date(l.startTime).getTime());
    expect(times[0]).toBeGreaterThan(times[1]);
    expect(times[1]).toBeGreaterThan(times[2]);
  });
});
