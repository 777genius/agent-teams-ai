import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import * as fs from 'fs/promises';

import { TeamTranscriptSourceLocator } from '../../../../src/main/services/team/taskLogs/discovery/TeamTranscriptSourceLocator';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

describe('TeamTranscriptSourceLocator', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('recovers projectPath from member cwd and includes only team-related root sessions', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-transcripts-'));
    setClaudeBasePathOverride(tmpDir);

    const teamName = 'signal-ops-test';
    const projectPath = '/Users/test/signal-ops';
    const projectId = '-Users-test-signal-ops';
    const leadSessionId = 'lead-session';
    const memberSessionId = 'member-bob';

    await fs.mkdir(path.join(tmpDir, 'teams', teamName), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamName, 'config.json'),
      JSON.stringify(
        {
          name: teamName,
          leadSessionId,
          members: [
            { name: 'team-lead', agentType: 'team-lead', cwd: projectPath },
            { name: 'bob', agentType: 'general-purpose', cwd: projectPath },
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
      JSON.stringify({
        timestamp: '2026-04-15T14:02:00.000Z',
        type: 'user',
        teamName,
        agentName: 'team-lead',
        message: { role: 'user', content: `Lead for team "${teamName}" (${teamName})` },
      }) + '\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(projectRoot, `${memberSessionId}.jsonl`),
      JSON.stringify({
        timestamp: '2026-04-15T14:02:01.000Z',
        type: 'user',
        teamName,
        agentName: 'bob',
        message: {
          role: 'user',
          content: `You are bootstrapping into team "${teamName}" as member "bob".`,
        },
      }) + '\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(projectRoot, 'unrelated-session.jsonl'),
      JSON.stringify({
        timestamp: '2026-04-15T14:02:02.000Z',
        type: 'user',
        message: { role: 'user', content: 'Unrelated solo session' },
      }) + '\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(projectRoot, leadSessionId, 'subagents', 'agent-worker.jsonl'),
      JSON.stringify({
        timestamp: '2026-04-15T14:02:03.000Z',
        type: 'user',
        message: { role: 'user', content: `You are bob, a developer on team "${teamName}".` },
      }) + '\n',
      'utf8'
    );

    const locator = new TeamTranscriptSourceLocator();
    const context = await locator.getContext(teamName);
    const transcriptFiles = await locator.listTranscriptFiles(teamName);

    expect(context).not.toBeNull();
    expect(context?.projectId).toBe(projectId);
    expect(context?.config.projectPath).toBe(projectPath);
    expect(context?.sessionIds).toEqual(expect.arrayContaining([leadSessionId, memberSessionId]));
    expect(context?.sessionIds).not.toContain('unrelated-session');
    expect(transcriptFiles).toEqual(
      expect.arrayContaining([
        path.join(projectRoot, `${leadSessionId}.jsonl`),
        path.join(projectRoot, `${memberSessionId}.jsonl`),
        path.join(projectRoot, leadSessionId, 'subagents', 'agent-worker.jsonl'),
      ])
    );
    expect(transcriptFiles).not.toContain(path.join(projectRoot, 'unrelated-session.jsonl'));
  });
});
