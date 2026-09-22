import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamTranscriptProjectResolver } from '../../../../src/main/services/team/TeamTranscriptProjectResolver';
import { encodePath, setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

import type { TeamTranscriptAffinityIndexStore } from '../../../../src/main/services/team/cache/teamTranscriptAffinityIndexTypes';
import type { TeamConfig } from '../../../../src/shared/types/team';

describe('TeamTranscriptProjectResolver', () => {
  let tmpDir: string | null = null;
  const originalAffinityIndexEnv = process.env.CLAUDE_TEAM_TRANSCRIPT_AFFINITY_INDEX;

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    if (originalAffinityIndexEnv == null) {
      delete process.env.CLAUDE_TEAM_TRANSCRIPT_AFFINITY_INDEX;
    } else {
      process.env.CLAUDE_TEAM_TRANSCRIPT_AFFINITY_INDEX = originalAffinityIndexEnv;
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  async function setupClaudeRoot(): Promise<string> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-transcript-project-resolver-'));
    setClaudeBasePathOverride(tmpDir);
    await fs.mkdir(path.join(tmpDir, 'teams'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true });
    return tmpDir;
  }

  async function writeTeamConfig(teamName: string, config: TeamConfig): Promise<void> {
    const teamDir = path.join(tmpDir!, 'teams', teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(path.join(teamDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  }

  async function readTeamConfig(teamName: string): Promise<TeamConfig> {
    const raw = await fs.readFile(path.join(tmpDir!, 'teams', teamName, 'config.json'), 'utf8');
    return JSON.parse(raw) as TeamConfig;
  }

  function affinityIndexPath(teamName: string, projectId: string): string {
    return path.join(
      tmpDir!,
      'teams',
      teamName,
      'cache',
      'transcript-affinity',
      `${encodeURIComponent(projectId)}.json`
    );
  }

  async function readAffinityIndex(teamName: string, projectId: string): Promise<{
    entries: Record<
      string,
      { signature: { size: number; mtimeMs: number; ctimeMs?: number }; verdict: string }
    >;
  }> {
    const raw = await fs.readFile(affinityIndexPath(teamName, projectId), 'utf8');
    return JSON.parse(raw) as {
      entries: Record<
        string,
        { signature: { size: number; mtimeMs: number; ctimeMs?: number }; verdict: string }
      >;
    };
  }

  async function writeAffinityIndex(
    teamName: string,
    projectId: string,
    value: unknown
  ): Promise<void> {
    const filePath = affinityIndexPath(teamName, projectId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
  }

  function sameByteLengthNoTeamTranscript(targetBytes: number): string {
    for (let length = 0; length < targetBytes; length += 1) {
      const candidate = `${JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: 'x'.repeat(length),
        },
      })}\n`;
      const candidateBytes = Buffer.byteLength(candidate, 'utf8');
      if (candidateBytes === targetBytes) {
        return candidate;
      }
      if (candidateBytes > targetBytes) {
        break;
      }
    }
    throw new Error(`Could not create same-byte transcript for ${targetBytes} bytes`);
  }

  async function createSessionFile(
    projectPath: string,
    sessionId: string,
    cwd: string = projectPath
  ): Promise<{ projectDir: string; jsonlPath: string }> {
    const projectDir = path.join(tmpDir!, 'projects', encodePath(projectPath));
    await fs.mkdir(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
    await fs.writeFile(
      jsonlPath,
      `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-04-18T10:00:00.000Z',
        cwd,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Resolver probe output' }],
        },
      })}\n`,
      'utf8'
    );
    return { projectDir, jsonlPath };
  }

  async function createSessionFileInProjectDir(
    projectDirName: string,
    sessionId: string,
    cwd: string
  ): Promise<{ projectDir: string; jsonlPath: string }> {
    const projectDir = path.join(tmpDir!, 'projects', projectDirName);
    await fs.mkdir(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
    await fs.writeFile(
      jsonlPath,
      `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-04-18T10:00:00.000Z',
        cwd,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Resolver probe output' }],
        },
      })}\n`,
      'utf8'
    );
    return { projectDir, jsonlPath };
  }

  async function createTeamAwareSessionFile(
    projectPath: string,
    sessionId: string,
    teamName: string,
    mode: 'text' | 'nested'
  ): Promise<{ projectDir: string; jsonlPath: string }> {
    const projectDir = path.join(tmpDir!, 'projects', encodePath(projectPath));
    await fs.mkdir(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
    const lines =
      mode === 'text'
        ? [
            {
              type: 'user',
              timestamp: '2026-04-18T10:00:00.000Z',
              cwd: projectPath,
              message: {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: `Current durable team context:\n- Team name: ${teamName}\n- You are the live team lead "team-lead"`,
                  },
                ],
              },
            },
          ]
        : [
            {
              type: 'assistant',
              timestamp: '2026-04-18T10:00:00.000Z',
              cwd: projectPath,
              message: {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: 'call_probe',
                    name: 'mcp__agent-teams__task_create_from_message',
                    input: {
                      teamName,
                      subject: 'Probe task',
                    },
                  },
                ],
              },
            },
          ];

    await fs.writeFile(
      jsonlPath,
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      'utf8'
    );
    return { projectDir, jsonlPath };
  }

  it('uses snapshot-capable config readers for resolver observations', async () => {
    await setupClaudeRoot();
    const { projectDir } = await createSessionFile('/repo/current', 'lead-session-1');
    const getConfig = vi.fn(async () => {
      throw new Error('verified config read should not be used for transcript observations');
    });
    const getConfigSnapshot = vi.fn(async () => ({
      name: 'My Team',
      projectPath: '/repo/current',
      leadSessionId: 'lead-session-1',
      members: [{ name: 'team-lead', agentType: 'team-lead' }],
    }));
    const resolver = new TeamTranscriptProjectResolver({
      getConfig,
      getConfigSnapshot,
    });

    const context = await resolver.getContext('my-team');

    expect(context?.projectDir).toBe(projectDir);
    expect(getConfigSnapshot).toHaveBeenCalledWith('my-team');
    expect(getConfig).not.toHaveBeenCalled();
  });

  it('resolves live base context from cheap projectPath evidence without session discovery', async () => {
    await setupClaudeRoot();

    const teamName = 'live-base-team';
    const projectPath = '/Users/test/live-base';
    const projectDir = path.join(tmpDir!, 'projects', encodePath(projectPath));
    await fs.mkdir(projectDir, { recursive: true });
    const getConfig = vi.fn(async () => {
      throw new Error('verified config read should not be used for live base context');
    });
    const getConfigSnapshot = vi.fn(async () => ({
      name: teamName,
      projectPath,
      leadSessionId: 'lead-session',
      members: [{ name: 'team-lead', agentType: 'team-lead' }],
    }));
    const resolver = new TeamTranscriptProjectResolver({
      getConfig,
      getConfigSnapshot,
    });

    const context = await resolver.getLiveBaseContext(teamName, { forceRefresh: true });

    expect(context?.projectDir).toBe(projectDir);
    expect(context?.config.projectPath).toBe(projectPath);
    expect(getConfigSnapshot).toHaveBeenCalledWith(teamName);
    expect(getConfig).not.toHaveBeenCalled();
  });

  it('repairs stale projectPath when exact leadSessionId exists only in the renamed project', async () => {
    await setupClaudeRoot();

    const teamName = 'my-team';
    const staleProjectPath = '/Users/test/hookplex';
    const repairedProjectPath = '/Users/test/plugin-kit-ai';
    const leadSessionId = 'lead-1';
    const staleProjectDir = path.join(tmpDir!, 'projects', encodePath(staleProjectPath));
    await fs.mkdir(staleProjectDir, { recursive: true });
    const repaired = await createSessionFile(repairedProjectPath, leadSessionId);

    await writeTeamConfig(teamName, {
      name: 'My Team',
      projectPath: staleProjectPath,
      leadSessionId,
      members: [{ name: 'team-lead', agentType: 'team-lead', cwd: repairedProjectPath }],
    });

    const resolver = new TeamTranscriptProjectResolver();
    const context = await resolver.getContext(teamName);
    const persisted = await readTeamConfig(teamName);

    expect(context).not.toBeNull();
    expect(context?.projectDir).toBe(repaired.projectDir);
    expect(context?.config.projectPath).toBe(repairedProjectPath);
    expect(persisted.projectPath).toBe(repairedProjectPath);
    expect(persisted.projectPathHistory).toEqual(expect.arrayContaining([staleProjectPath]));
  });

  it('keeps the current projectPath when it already contains the exact session', async () => {
    await setupClaudeRoot();

    const teamName = 'my-team';
    const currentProjectPath = '/Users/test/hookplex';
    const alternateProjectPath = '/Users/test/plugin-kit-ai';
    const leadSessionId = 'lead-1';
    const current = await createSessionFile(currentProjectPath, leadSessionId);
    await createSessionFile(alternateProjectPath, leadSessionId);

    await writeTeamConfig(teamName, {
      name: 'My Team',
      projectPath: currentProjectPath,
      projectPathHistory: [alternateProjectPath],
      leadSessionId,
      members: [{ name: 'team-lead', agentType: 'team-lead', cwd: alternateProjectPath }],
    });

    const resolver = new TeamTranscriptProjectResolver();
    const context = await resolver.getContext(teamName);
    const persisted = await readTeamConfig(teamName);

    expect(context?.projectDir).toBe(current.projectDir);
    expect(context?.config.projectPath).toBe(currentProjectPath);
    expect(persisted.projectPath).toBe(currentProjectPath);
    expect(persisted.projectPathHistory).toEqual([alternateProjectPath]);
  });

  it('falls back to exact sessionHistory ids when leadSessionId file is missing', async () => {
    await setupClaudeRoot();

    const teamName = 'my-team';
    const staleProjectPath = '/Users/test/hookplex';
    const repairedProjectPath = '/Users/test/plugin-kit-ai';
    const historicalSessionId = 'lead-old';
    await fs.mkdir(path.join(tmpDir!, 'projects', encodePath(staleProjectPath)), {
      recursive: true,
    });
    const repaired = await createSessionFile(repairedProjectPath, historicalSessionId);

    await writeTeamConfig(teamName, {
      name: 'My Team',
      projectPath: staleProjectPath,
      leadSessionId: 'lead-missing',
      sessionHistory: [historicalSessionId],
      members: [{ name: 'team-lead', agentType: 'team-lead', cwd: repairedProjectPath }],
    });

    const resolver = new TeamTranscriptProjectResolver();
    const context = await resolver.getContext(teamName);
    const persisted = await readTeamConfig(teamName);

    expect(context?.projectDir).toBe(repaired.projectDir);
    expect(context?.config.projectPath).toBe(repairedProjectPath);
    expect(persisted.projectPath).toBe(repairedProjectPath);
  });

  it('prefers the newest sessionHistory match when leadSessionId is missing', async () => {
    await setupClaudeRoot();

    const teamName = 'my-team';
    const staleProjectPath = '/Users/test/hookplex';
    const repairedProjectPath = '/Users/test/plugin-kit-ai';
    const olderSessionId = 'lead-old';
    const newerSessionId = 'lead-new';
    await createSessionFile(staleProjectPath, olderSessionId);
    const repaired = await createSessionFile(repairedProjectPath, newerSessionId);

    await writeTeamConfig(teamName, {
      name: 'My Team',
      projectPath: staleProjectPath,
      leadSessionId: 'lead-missing',
      sessionHistory: [olderSessionId, newerSessionId],
      members: [{ name: 'team-lead', agentType: 'team-lead', cwd: repairedProjectPath }],
    });

    const resolver = new TeamTranscriptProjectResolver();
    const context = await resolver.getContext(teamName);

    expect(context?.projectDir).toBe(repaired.projectDir);
    expect(context?.config.projectPath).toBe(repairedProjectPath);
  });

  it('does not let an old sessionHistory match block repair when the current leadSessionId exists elsewhere', async () => {
    await setupClaudeRoot();

    const teamName = 'my-team';
    const staleProjectPath = '/Users/test/hookplex';
    const repairedProjectPath = '/Users/test/plugin-kit-ai';
    const leadSessionId = 'lead-current';
    const historicalSessionId = 'lead-old';
    await createSessionFile(staleProjectPath, historicalSessionId);
    const repaired = await createSessionFile(repairedProjectPath, leadSessionId);

    await writeTeamConfig(teamName, {
      name: 'My Team',
      projectPath: staleProjectPath,
      leadSessionId,
      sessionHistory: [historicalSessionId],
      members: [{ name: 'team-lead', agentType: 'team-lead', cwd: repairedProjectPath }],
    });

    const resolver = new TeamTranscriptProjectResolver();
    const context = await resolver.getContext(teamName);
    const persisted = await readTeamConfig(teamName);

    expect(context?.projectDir).toBe(repaired.projectDir);
    expect(context?.config.projectPath).toBe(repairedProjectPath);
    expect(persisted.projectPath).toBe(repairedProjectPath);
  });

  it('picks the best exact session match across dir variants for the same projectPath', async () => {
    await setupClaudeRoot();

    const teamName = 'my-team';
    const projectPath = '/Users/test/plugin_kit_ai';
    const staleSessionId = 'lead-old';
    const currentSessionId = 'lead-current';
    await createSessionFile(projectPath, staleSessionId);
    const repaired = await createSessionFileInProjectDir(
      encodePath(projectPath).replace(/_/g, '-'),
      currentSessionId,
      projectPath
    );

    await writeTeamConfig(teamName, {
      name: 'My Team',
      projectPath,
      leadSessionId: currentSessionId,
      sessionHistory: [staleSessionId],
      members: [{ name: 'team-lead', agentType: 'team-lead', cwd: projectPath }],
    });

    const resolver = new TeamTranscriptProjectResolver();
    const context = await resolver.getContext(teamName);

    expect(context?.projectDir).toBe(repaired.projectDir);
  });

  it('does not self-heal when an alternate configured match is not unique across projects scan', async () => {
    await setupClaudeRoot();

    const teamName = 'my-team';
    const staleProjectPath = '/Users/test/hookplex';
    const configuredProjectPath = '/Users/test/plugin-kit-ai';
    const duplicateProjectPath = '/Users/test/plugin-kit-ai-copy';
    const leadSessionId = 'lead-1';
    const staleProjectDir = path.join(tmpDir!, 'projects', encodePath(staleProjectPath));
    await fs.mkdir(staleProjectDir, { recursive: true });
    await createSessionFile(configuredProjectPath, leadSessionId);
    await createSessionFile(duplicateProjectPath, leadSessionId);

    await writeTeamConfig(teamName, {
      name: 'My Team',
      projectPath: staleProjectPath,
      projectPathHistory: [configuredProjectPath],
      leadSessionId,
      members: [{ name: 'team-lead', agentType: 'team-lead', cwd: configuredProjectPath }],
    });

    const resolver = new TeamTranscriptProjectResolver();
    const warnSpy = vi.mocked(console.warn);
    const context = await resolver.getContext(teamName);
    const persisted = await readTeamConfig(teamName);

    expect(context?.projectDir).toBe(staleProjectDir);
    expect(context?.config.projectPath).toBe(staleProjectPath);
    expect(persisted.projectPath).toBe(staleProjectPath);
    expect(warnSpy.mock.calls).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.stringContaining(
            'Transcript project resolution ambiguous across exact-session candidates'
          ),
        ]),
      ])
    );
    warnSpy.mockClear();
  });

  it('does not self-heal when full scan finds multiple equally valid session matches', async () => {
    await setupClaudeRoot();

    const teamName = 'my-team';
    const staleProjectPath = '/Users/test/hookplex';
    const leadSessionId = 'lead-1';
    const staleProjectDir = path.join(tmpDir!, 'projects', encodePath(staleProjectPath));
    await fs.mkdir(staleProjectDir, { recursive: true });
    await createSessionFile('/Users/test/plugin-kit-ai', leadSessionId);
    await createSessionFile('/Users/test/plugin-kit-ai-copy', leadSessionId);

    await writeTeamConfig(teamName, {
      name: 'My Team',
      projectPath: staleProjectPath,
      leadSessionId,
      members: [{ name: 'team-lead', agentType: 'team-lead' }],
    });

    const resolver = new TeamTranscriptProjectResolver();
    const warnSpy = vi.mocked(console.warn);
    const context = await resolver.getContext(teamName);
    const persisted = await readTeamConfig(teamName);

    expect(context?.projectDir).toBe(staleProjectDir);
    expect(context?.config.projectPath).toBe(staleProjectPath);
    expect(persisted.projectPath).toBe(staleProjectPath);
    expect(warnSpy.mock.calls).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.stringContaining(
            'Transcript project resolution ambiguous across exact-session candidates'
          ),
        ]),
      ])
    );
    warnSpy.mockClear();
  });

  it('falls back to an existing alternate dir candidate when no session ids are known yet', async () => {
    await setupClaudeRoot();

    const teamName = 'my-team';
    const projectPath = '/Users/test/plugin_kit_ai';
    const alternateDir = encodePath(projectPath).replace(/_/g, '-');
    const fallback = await createSessionFileInProjectDir(alternateDir, 'lead-1', projectPath);

    await writeTeamConfig(teamName, {
      name: 'My Team',
      projectPath,
      members: [{ name: 'team-lead', agentType: 'team-lead', cwd: projectPath }],
    });

    const resolver = new TeamTranscriptProjectResolver();
    const context = await resolver.getContext(teamName);

    expect(context?.projectDir).toBe(fallback.projectDir);
    expect(context?.config.projectPath).toBe(projectPath);
  });

  it('prefers a later candidate when the transcript text explicitly names the team and the stale project dir still exists', async () => {
    await setupClaudeRoot();

    const teamName = 'vector-room-55555551';
    const staleProjectPath = '/Users/test/hookplex';
    const repairedProjectPath = '/Users/test/plugin-kit-ai';
    const staleProjectDir = path.join(tmpDir!, 'projects', encodePath(staleProjectPath));
    await fs.mkdir(staleProjectDir, { recursive: true });
    const repaired = await createTeamAwareSessionFile(
      repairedProjectPath,
      'lead-1',
      teamName,
      'text'
    );

    await writeTeamConfig(teamName, {
      name: 'My Team',
      projectPath: staleProjectPath,
      members: [{ name: 'team-lead', agentType: 'team-lead', cwd: repairedProjectPath }],
    });

    const resolver = new TeamTranscriptProjectResolver();
    const context = await resolver.getContext(teamName);

    expect(context?.projectDir).toBe(repaired.projectDir);
    expect(context?.config.projectPath).toBe(repairedProjectPath);
  });

  it('recognizes nested tool input teamName during no-session fallback', async () => {
    await setupClaudeRoot();

    const teamName = 'vector-room-55555551';
    const staleProjectPath = '/Users/test/hookplex';
    const repairedProjectPath = '/Users/test/plugin-kit-ai';
    const staleProjectDir = path.join(tmpDir!, 'projects', encodePath(staleProjectPath));
    await fs.mkdir(staleProjectDir, { recursive: true });
    const repaired = await createTeamAwareSessionFile(
      repairedProjectPath,
      'lead-1',
      teamName,
      'nested'
    );

    await writeTeamConfig(teamName, {
      name: 'My Team',
      projectPath: staleProjectPath,
      members: [{ name: 'team-lead', agentType: 'team-lead', cwd: repairedProjectPath }],
    });

    const resolver = new TeamTranscriptProjectResolver();
    const context = await resolver.getContext(teamName);

    expect(context?.projectDir).toBe(repaired.projectDir);
    expect(context?.config.projectPath).toBe(repairedProjectPath);
  });

  it('refreshes team affinity cache when a transcript file changes', async () => {
    await setupClaudeRoot();

    const teamName = 'vector-room-55555552';
    const staleProjectPath = '/Users/test/hookplex';
    const repairedProjectPath = '/Users/test/plugin-kit-ai';
    const staleProjectDir = path.join(tmpDir!, 'projects', encodePath(staleProjectPath));
    await fs.mkdir(staleProjectDir, { recursive: true });
    const repaired = await createTeamAwareSessionFile(
      repairedProjectPath,
      'lead-1',
      teamName,
      'text'
    );

    await writeTeamConfig(teamName, {
      name: 'My Team',
      projectPath: staleProjectPath,
      members: [{ name: 'team-lead', agentType: 'team-lead', cwd: repairedProjectPath }],
    });

    const resolver = new TeamTranscriptProjectResolver();
    const firstContext = await resolver.getContext(teamName, { forceRefresh: true });

    expect(firstContext?.projectDir).toBe(repaired.projectDir);

    await fs.writeFile(
      repaired.jsonlPath,
      `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-04-18T10:01:00.000Z',
        cwd: repairedProjectPath,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Resolver probe output without team context' }],
        },
      })}\n`,
      'utf8'
    );
    const updatedAt = new Date(Date.now() + 5_000);
    await fs.utimes(repaired.jsonlPath, updatedAt, updatedAt);

    const secondContext = await resolver.getContext(teamName, { forceRefresh: true });

    expect(secondContext?.projectDir).toBe(staleProjectDir);
  });

  it('bounds root session discovery by team lifecycle in fast preview context', async () => {
    await setupClaudeRoot();

    const teamName = 'fast-preview-team';
    const projectPath = '/Users/test/fast-preview';
    const createdAt = Date.parse('2026-04-18T12:00:00.000Z');
    const leadSessionId = 'lead-fast';
    const lead = await createTeamAwareSessionFile(projectPath, leadSessionId, teamName, 'text');
    const recent = await createTeamAwareSessionFile(
      projectPath,
      'recent-member-session',
      teamName,
      'text'
    );
    const old = await createTeamAwareSessionFile(
      projectPath,
      'old-member-session',
      teamName,
      'text'
    );
    await fs.utimes(lead.jsonlPath, new Date(createdAt + 60_000), new Date(createdAt + 60_000));
    await fs.utimes(
      recent.jsonlPath,
      new Date(createdAt + 5 * 60_000),
      new Date(createdAt + 5 * 60_000)
    );
    await fs.utimes(
      old.jsonlPath,
      new Date(createdAt - 25 * 60 * 60_000),
      new Date(createdAt - 25 * 60 * 60_000)
    );

    await writeTeamConfig(teamName, {
      name: 'Fast Preview Team',
      createdAt,
      projectPath,
      leadSessionId,
      members: [
        { name: 'team-lead', agentType: 'team-lead', joinedAt: createdAt, cwd: projectPath },
        { name: 'alice', agentType: 'general-purpose', joinedAt: createdAt + 5 * 60_000 },
      ],
    } as TeamConfig);

    const resolver = new TeamTranscriptProjectResolver();
    const fastContext = await resolver.getContext(teamName, {
      forceRefresh: true,
      includeTeamSubagentSessionDiscovery: false,
    });
    const fullContext = await resolver.getContext(teamName, { forceRefresh: true });

    expect(fastContext?.projectDir).toBe(lead.projectDir);
    expect(fastContext?.sessionIds).toEqual(expect.arrayContaining([leadSessionId]));
    expect(fastContext?.sessionIds).toContain('recent-member-session');
    expect(fastContext?.sessionIds).not.toContain('old-member-session');
    expect(fullContext?.sessionIds).toContain('old-member-session');
  });

  it('uses a persistent exact affinity index without re-reading matching root transcript heads', async () => {
    await setupClaudeRoot();

    const teamName = 'persistent-index-team';
    const projectPath = '/Users/test/persistent-index';
    const sessionId = 'lead-indexed';
    await createTeamAwareSessionFile(projectPath, sessionId, teamName, 'text');
    await writeTeamConfig(teamName, {
      name: 'Persistent Index Team',
      projectPath,
      members: [{ name: 'team-lead', agentType: 'team-lead', cwd: projectPath }],
    });

    const firstResolver = new TeamTranscriptProjectResolver();
    const firstContext = await firstResolver.getContext(teamName, { forceRefresh: true });
    expect(firstContext?.sessionIds).toContain(sessionId);

    type ResolverScanProbe = {
      getTeamAffinityHeadMetadata: (...args: unknown[]) => Promise<unknown>;
    };
    const secondResolver = new TeamTranscriptProjectResolver();
    const scanSpy = vi.spyOn(
      secondResolver as unknown as ResolverScanProbe,
      'getTeamAffinityHeadMetadata'
    );
    scanSpy.mockRejectedValue(new Error('persistent index should bypass head scan'));

    const secondContext = await secondResolver.getContext(teamName, { forceRefresh: true });

    expect(secondContext?.sessionIds).toContain(sessionId);
    expect(scanSpy).not.toHaveBeenCalled();
    scanSpy.mockRestore();
  });

  it('falls back to a fresh head scan when a persistent index signature is stale', async () => {
    await setupClaudeRoot();

    const teamName = 'stale-persistent-index-team';
    const projectPath = '/Users/test/stale-persistent-index';
    const sessionId = 'stale-indexed';
    const created = await createTeamAwareSessionFile(projectPath, sessionId, teamName, 'text');
    await writeTeamConfig(teamName, {
      name: 'Stale Persistent Index Team',
      projectPath,
      members: [{ name: 'team-lead', agentType: 'team-lead', cwd: projectPath }],
    });

    const firstResolver = new TeamTranscriptProjectResolver();
    const firstContext = await firstResolver.getContext(teamName, { forceRefresh: true });
    expect(firstContext?.sessionIds).toContain(sessionId);

    await fs.writeFile(
      created.jsonlPath,
      `${JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'no team mention here' },
      })}\n`,
      'utf8'
    );
    const updatedAt = new Date(Date.now() + 5_000);
    await fs.utimes(created.jsonlPath, updatedAt, updatedAt);

    const secondResolver = new TeamTranscriptProjectResolver();
    const secondContext = await secondResolver.getContext(teamName, { forceRefresh: true });

    expect(secondContext?.sessionIds).not.toContain(sessionId);
  });

  it('treats ctime mismatch as stale even when persistent index size and mtime still match', async () => {
    await setupClaudeRoot();

    const teamName = 'ctime-persistent-index-team';
    const projectPath = '/Users/test/ctime-persistent-index';
    const projectId = encodePath(projectPath);
    const sessionId = 'ctime-indexed';
    const created = await createTeamAwareSessionFile(projectPath, sessionId, teamName, 'text');
    const stableTime = new Date('2026-05-30T10:00:00.000Z');
    await fs.utimes(created.jsonlPath, stableTime, stableTime);
    await writeTeamConfig(teamName, {
      name: 'Ctime Persistent Index Team',
      projectPath,
      members: [{ name: 'team-lead', agentType: 'team-lead', cwd: projectPath }],
    });

    const firstResolver = new TeamTranscriptProjectResolver();
    const firstContext = await firstResolver.getContext(teamName, { forceRefresh: true });
    expect(firstContext?.sessionIds).toContain(sessionId);

    const indexedBefore = await readAffinityIndex(teamName, projectId);
    const originalSize = indexedBefore.entries[`${sessionId}.jsonl`].signature.size;
    await fs.writeFile(created.jsonlPath, sameByteLengthNoTeamTranscript(originalSize), 'utf8');
    await fs.utimes(created.jsonlPath, stableTime, stableTime);
    const currentStat = await fs.stat(created.jsonlPath);

    expect(currentStat.size).toBe(originalSize);
    expect(currentStat.mtimeMs).toBe(indexedBefore.entries[`${sessionId}.jsonl`].signature.mtimeMs);
    expect(currentStat.ctimeMs).not.toBe(
      indexedBefore.entries[`${sessionId}.jsonl`].signature.ctimeMs
    );

    const secondResolver = new TeamTranscriptProjectResolver();
    const secondContext = await secondResolver.getContext(teamName, { forceRefresh: true });

    expect(secondContext?.sessionIds).not.toContain(sessionId);
  });

  it('treats a persistent index entry without ctime as stale when the file stat has ctime', async () => {
    await setupClaudeRoot();

    const teamName = 'missing-ctime-persistent-index-team';
    const projectPath = '/Users/test/missing-ctime-persistent-index';
    const projectId = encodePath(projectPath);
    const sessionId = 'missing-ctime-indexed';
    await createTeamAwareSessionFile(projectPath, sessionId, teamName, 'text');
    await writeTeamConfig(teamName, {
      name: 'Missing Ctime Persistent Index Team',
      projectPath,
      members: [{ name: 'team-lead', agentType: 'team-lead', cwd: projectPath }],
    });

    const firstResolver = new TeamTranscriptProjectResolver();
    const firstContext = await firstResolver.getContext(teamName, { forceRefresh: true });
    expect(firstContext?.sessionIds).toContain(sessionId);

    const index = await readAffinityIndex(teamName, projectId);
    delete index.entries[`${sessionId}.jsonl`].signature.ctimeMs;
    await writeAffinityIndex(teamName, projectId, index);

    type ResolverScanProbe = {
      getTeamAffinityHeadMetadata: (...args: unknown[]) => Promise<unknown>;
    };
    const secondResolver = new TeamTranscriptProjectResolver();
    const scanSpy = vi.spyOn(
      secondResolver as unknown as ResolverScanProbe,
      'getTeamAffinityHeadMetadata'
    );

    const secondContext = await secondResolver.getContext(teamName, { forceRefresh: true });

    expect(secondContext?.sessionIds).toContain(sessionId);
    expect(scanSpy).toHaveBeenCalled();
    scanSpy.mockRestore();
  });

  it('reuses exact persistent negatives but rescans after a short transcript grows', async () => {
    await setupClaudeRoot();

    const teamName = 'negative-persistent-index-team';
    const projectPath = '/Users/test/negative-persistent-index';
    const sessionId = 'short-negative';
    const projectDir = path.join(tmpDir!, 'projects', encodePath(projectPath));
    const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      jsonlPath,
      `${[0, 1, 2]
        .map((i) =>
          JSON.stringify({ type: 'user', message: { role: 'user', content: `noise ${i}` } })
        )
        .join('\n')}\n`,
      'utf8'
    );
    await writeTeamConfig(teamName, {
      name: 'Negative Persistent Index Team',
      projectPath,
      members: [{ name: 'team-lead', agentType: 'team-lead', cwd: projectPath }],
    });

    const firstResolver = new TeamTranscriptProjectResolver();
    const firstContext = await firstResolver.getContext(teamName, { forceRefresh: true });
    expect(firstContext?.sessionIds).not.toContain(sessionId);

    type ResolverScanProbe = {
      getTeamAffinityHeadMetadata: (...args: unknown[]) => Promise<unknown>;
    };
    const secondResolver = new TeamTranscriptProjectResolver();
    const scanSpy = vi.spyOn(
      secondResolver as unknown as ResolverScanProbe,
      'getTeamAffinityHeadMetadata'
    );
    scanSpy.mockRejectedValue(new Error('persistent negative should bypass head scan'));

    const secondContext = await secondResolver.getContext(teamName, { forceRefresh: true });
    expect(secondContext?.sessionIds).not.toContain(sessionId);
    expect(scanSpy).not.toHaveBeenCalled();
    scanSpy.mockRestore();

    await fs.appendFile(
      jsonlPath,
      `${JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: `Current team context:\n- Team name: ${teamName}` }],
        },
      })}\n`,
      'utf8'
    );
    const updatedAt = new Date(Date.now() + 5_000);
    await fs.utimes(jsonlPath, updatedAt, updatedAt);

    const thirdResolver = new TeamTranscriptProjectResolver();
    const thirdContext = await thirdResolver.getContext(teamName, { forceRefresh: true });

    expect(thirdContext?.sessionIds).toContain(sessionId);
  });

  it('prunes persistent affinity entries for deleted root transcripts without requiring a new scan', async () => {
    await setupClaudeRoot();

    const teamName = 'prune-persistent-index-team';
    const projectPath = '/Users/test/prune-persistent-index';
    const projectId = encodePath(projectPath);
    const keptSessionId = 'kept-session';
    const deletedSessionId = 'deleted-session';
    const kept = await createTeamAwareSessionFile(projectPath, keptSessionId, teamName, 'text');
    const deleted = await createTeamAwareSessionFile(
      projectPath,
      deletedSessionId,
      teamName,
      'text'
    );
    await writeTeamConfig(teamName, {
      name: 'Prune Persistent Index Team',
      projectPath,
      members: [{ name: 'team-lead', agentType: 'team-lead', cwd: projectPath }],
    });

    const firstResolver = new TeamTranscriptProjectResolver();
    await firstResolver.getContext(teamName, { forceRefresh: true });
    const indexedBefore = await readAffinityIndex(teamName, projectId);
    expect(Object.keys(indexedBefore.entries).sort()).toEqual([
      `${deletedSessionId}.jsonl`,
      `${keptSessionId}.jsonl`,
    ]);

    await fs.rm(deleted.jsonlPath);

    type ResolverScanProbe = {
      getTeamAffinityHeadMetadata: (...args: unknown[]) => Promise<unknown>;
    };
    const secondResolver = new TeamTranscriptProjectResolver();
    const scanSpy = vi.spyOn(
      secondResolver as unknown as ResolverScanProbe,
      'getTeamAffinityHeadMetadata'
    );
    scanSpy.mockRejectedValue(new Error('remaining exact index hit should bypass head scan'));

    const secondContext = await secondResolver.getContext(teamName, { forceRefresh: true });
    const indexedAfter = await readAffinityIndex(teamName, projectId);

    expect(secondContext?.sessionIds).toContain(keptSessionId);
    expect(secondContext?.sessionIds).not.toContain(deletedSessionId);
    expect(scanSpy).not.toHaveBeenCalled();
    expect(Object.keys(indexedAfter.entries)).toEqual([`${keptSessionId}.jsonl`]);
    await fs.access(kept.jsonlPath);
    scanSpy.mockRestore();
  });

  it('keeps discovering sessions when the persistent affinity store load or write fails', async () => {
    await setupClaudeRoot();

    const teamName = 'failing-store-index-team';
    const projectPath = '/Users/test/failing-store-index';
    const sessionId = 'failing-store-session';
    await createTeamAwareSessionFile(projectPath, sessionId, teamName, 'text');
    await writeTeamConfig(teamName, {
      name: 'Failing Store Index Team',
      projectPath,
      members: [{ name: 'team-lead', agentType: 'team-lead', cwd: projectPath }],
    });

    const store: TeamTranscriptAffinityIndexStore = {
      loadProject: vi.fn(async () => {
        throw new Error('load failed');
      }),
      upsertProjectEntries: vi.fn(async () => {
        throw new Error('write failed');
      }),
    };
    const resolver = new TeamTranscriptProjectResolver(undefined, store);

    const context = await resolver.getContext(teamName, { forceRefresh: true });

    expect(context?.sessionIds).toContain(sessionId);
    expect(store.loadProject).toHaveBeenCalled();
    expect(store.upsertProjectEntries).toHaveBeenCalled();
  });

  it('does not read or write the persistent affinity index when the kill switch is disabled', async () => {
    await setupClaudeRoot();
    process.env.CLAUDE_TEAM_TRANSCRIPT_AFFINITY_INDEX = '0';

    const teamName = 'kill-switch-index-team';
    const projectPath = '/Users/test/kill-switch-index';
    const sessionId = 'kill-switch-session';
    await createTeamAwareSessionFile(projectPath, sessionId, teamName, 'text');
    await writeTeamConfig(teamName, {
      name: 'Kill Switch Index Team',
      projectPath,
      leadSessionId: sessionId,
      members: [{ name: 'team-lead', agentType: 'team-lead', cwd: projectPath }],
    });

    const store: TeamTranscriptAffinityIndexStore = {
      loadProject: vi.fn(async () => {
        throw new Error('disabled index should not load');
      }),
      upsertProjectEntries: vi.fn(async () => undefined),
    };
    const resolver = new TeamTranscriptProjectResolver(undefined, store);

    const context = await resolver.getContext(teamName, { forceRefresh: true });

    expect(context?.sessionIds).toContain(sessionId);
    expect(store.loadProject).not.toHaveBeenCalled();
    expect(store.upsertProjectEntries).not.toHaveBeenCalled();
  });

  // Regression for the launch hot path: non-matching transcripts must not be
  // re-streamed + re-parsed on every bootstrap poll. A negative verdict decided from
  // a FULL head window (>= 40 inspected lines) is durable while the file only grows,
  // because an append-only transcript's head is immutable. Observed via the private
  // affinity cache: the durable branch returns WITHOUT re-caching, so the cached size
  // stays at the first scan's size (a re-scan would update it to the grown size).
  type AffinityCacheEntry = {
    mtimeMs: number;
    size: number;
    ctimeMs?: number;
    belongsToTeam: boolean;
    inspectedLineCount: number;
    headFingerprint: string;
    headWindowFull: boolean;
  };
  type HeadMetadataCacheEntry = {
    mtimeMs: number;
    size: number;
    ctimeMs?: number;
    inspectedLineCount: number;
    headFingerprint: string;
    lines: unknown[];
  };
  type ResolverProbe = {
    fileBelongsToTeam: (
      filePath: string,
      teamName: string,
      precomputedStat?: { mtimeMs: number; size: number; ctimeMs?: number; isFile: () => boolean }
    ) => Promise<boolean>;
    buildTeamAffinityFileCacheKey: (filePath: string, normalizedTeam: string) => string;
    teamAffinityFileCache: Map<string, AffinityCacheEntry>;
    teamAffinityHeadMetadataCache: Map<string, HeadMetadataCacheEntry>;
  };

  it('caches a full-head-window negative and stops re-scanning a growing non-matching transcript', async () => {
    await setupClaudeRoot();
    const resolver = new TeamTranscriptProjectResolver() as unknown as ResolverProbe;
    const team = 'absent-team';
    const projectDir = path.join(tmpDir!, 'projects', encodePath('/repo/neg-durable'));
    await fs.mkdir(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, 'unrelated.jsonl');
    const mkLine = (i: number) =>
      JSON.stringify({ type: 'user', message: { role: 'user', content: `unrelated line ${i}` } });
    // 45 non-empty lines, none mentioning the team -> full head window (40) inspected.
    await fs.writeFile(
      jsonlPath,
      `${Array.from({ length: 45 }, (_, i) => mkLine(i)).join('\n')}\n`,
      'utf8'
    );

    expect(await resolver.fileBelongsToTeam(jsonlPath, team)).toBe(false);
    const key = resolver.buildTeamAffinityFileCacheKey(jsonlPath, team.toLowerCase());
    const first = resolver.teamAffinityFileCache.get(key);
    expect(first?.belongsToTeam).toBe(false);
    expect(first?.headWindowFull).toBe(true);
    const sizeAfterFirst = first!.size;

    // Append-only growth: size grows, mtime changes, but the inspected head is fixed.
    await fs.appendFile(jsonlPath, `${mkLine(100)}\n`);
    expect(await resolver.fileBelongsToTeam(jsonlPath, team)).toBe(false);
    // Durable negative: the cache entry was NOT re-written (no re-scan), so its size
    // is still the original, smaller size.
    expect(resolver.teamAffinityFileCache.get(key)?.size).toBe(sizeAfterFirst);
  });

  // Correctness guard: a SHORT-file negative (head window not yet full) is NOT durable
  // and must be re-scanned on growth, so a team mention that lands inside the first 40
  // lines is still detected (the verdict flips to true).
  it('re-scans a short-file negative on growth and flips to true when the head gains a team mention', async () => {
    await setupClaudeRoot();
    const resolver = new TeamTranscriptProjectResolver() as unknown as ResolverProbe;
    const team = 'team-x';
    const projectDir = path.join(tmpDir!, 'projects', encodePath('/repo/short-neg'));
    await fs.mkdir(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, 'short.jsonl');
    // Only 3 lines, none mentioning the team -> partial head window (not durable).
    await fs.writeFile(
      jsonlPath,
      `${[0, 1, 2]
        .map((i) => JSON.stringify({ type: 'user', message: { role: 'user', content: `hi ${i}` } }))
        .join('\n')}\n`,
      'utf8'
    );

    expect(await resolver.fileBelongsToTeam(jsonlPath, team)).toBe(false);
    const key = resolver.buildTeamAffinityFileCacheKey(jsonlPath, team.toLowerCase());
    const first = resolver.teamAffinityFileCache.get(key);
    expect(first?.headWindowFull).toBe(false);
    const sizeAfterFirst = first!.size;

    // Append a line whose text content mentions the team (still within the first 40 lines).
    await fs.appendFile(
      jsonlPath,
      `${JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: `Current durable team context:\n- Team name: ${team}` },
          ],
        },
      })}\n`
    );
    expect(await resolver.fileBelongsToTeam(jsonlPath, team)).toBe(true); // re-scanned -> flips
    const second = resolver.teamAffinityFileCache.get(key);
    expect(second?.belongsToTeam).toBe(true);
    expect(second!.size).toBeGreaterThan(sizeAfterFirst); // re-scanned + re-cached
  });

  it('does not reuse an in-memory positive growth shortcut after the cached head is rewritten', async () => {
    await setupClaudeRoot();
    const resolver = new TeamTranscriptProjectResolver() as unknown as ResolverProbe;
    const team = 'rewrite-positive-team';
    const projectDir = path.join(tmpDir!, 'projects', encodePath('/repo/rewrite-positive'));
    await fs.mkdir(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, 'rewrite-positive.jsonl');
    await fs.writeFile(jsonlPath, `${teamTextLine(team)}\n`, 'utf8');

    expect(await resolver.fileBelongsToTeam(jsonlPath, team)).toBe(true);
    const key = resolver.buildTeamAffinityFileCacheKey(jsonlPath, team.toLowerCase());
    const first = resolver.teamAffinityFileCache.get(key);
    expect(first?.belongsToTeam).toBe(true);

    const replacement = `${JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: 'x'.repeat(first!.size + 100) },
    })}\n`;
    expect(Buffer.byteLength(replacement, 'utf8')).toBeGreaterThanOrEqual(first!.size);
    await fs.writeFile(jsonlPath, replacement, 'utf8');

    expect(await resolver.fileBelongsToTeam(jsonlPath, team)).toBe(false);
    expect(resolver.teamAffinityFileCache.get(key)?.belongsToTeam).toBe(false);
  });

  it('does not reuse an in-memory full-head negative shortcut after the cached head is rewritten', async () => {
    await setupClaudeRoot();
    const resolver = new TeamTranscriptProjectResolver() as unknown as ResolverProbe;
    const team = 'rewrite-negative-team';
    const projectDir = path.join(tmpDir!, 'projects', encodePath('/repo/rewrite-negative'));
    await fs.mkdir(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, 'rewrite-negative.jsonl');
    const originalLines = Array.from({ length: 45 }, (_, i) => noiseLine(i));
    await fs.writeFile(jsonlPath, `${originalLines.join('\n')}\n`, 'utf8');

    expect(await resolver.fileBelongsToTeam(jsonlPath, team)).toBe(false);
    const key = resolver.buildTeamAffinityFileCacheKey(jsonlPath, team.toLowerCase());
    const first = resolver.teamAffinityFileCache.get(key);
    expect(first?.headWindowFull).toBe(true);

    const rewrittenLines = [teamTextLine(team), ...originalLines.slice(1)];
    let replacement = `${rewrittenLines.join('\n')}\n`;
    if (Buffer.byteLength(replacement, 'utf8') < first!.size) {
      replacement += `${noiseLine(999)}\n`;
    }
    expect(Buffer.byteLength(replacement, 'utf8')).toBeGreaterThanOrEqual(first!.size);
    await fs.writeFile(jsonlPath, replacement, 'utf8');

    expect(await resolver.fileBelongsToTeam(jsonlPath, team)).toBe(true);
    expect(resolver.teamAffinityFileCache.get(key)?.belongsToTeam).toBe(true);
  });

  it('does not reuse in-memory exact caches after a same-size rewrite with restored mtime', async () => {
    await setupClaudeRoot();
    const resolver = new TeamTranscriptProjectResolver() as unknown as ResolverProbe;
    const team = 'same-size-rewrite-team';
    const projectDir = path.join(tmpDir!, 'projects', encodePath('/repo/same-size-rewrite'));
    await fs.mkdir(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, 'same-size-rewrite.jsonl');
    const stableTime = new Date('2026-05-30T10:00:00.000Z');
    await fs.writeFile(jsonlPath, `${teamTextLine(team)}\n`, 'utf8');
    await fs.utimes(jsonlPath, stableTime, stableTime);

    expect(await resolver.fileBelongsToTeam(jsonlPath, team)).toBe(true);
    const key = resolver.buildTeamAffinityFileCacheKey(jsonlPath, team.toLowerCase());
    const first = resolver.teamAffinityFileCache.get(key);
    const firstHead = resolver.teamAffinityHeadMetadataCache.get(jsonlPath);
    expect(first?.belongsToTeam).toBe(true);
    expect(firstHead?.lines.length).toBeGreaterThan(0);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(jsonlPath, sameByteLengthNoTeamTranscript(first!.size), 'utf8');
    await fs.utimes(jsonlPath, stableTime, stableTime);
    const rewrittenStat = await fs.stat(jsonlPath);

    expect(rewrittenStat.size).toBe(first!.size);
    expect(rewrittenStat.mtimeMs).toBe(first!.mtimeMs);
    expect(rewrittenStat.ctimeMs).not.toBe(first!.ctimeMs);

    expect(await resolver.fileBelongsToTeam(jsonlPath, team)).toBe(false);
    expect(resolver.teamAffinityFileCache.get(key)?.belongsToTeam).toBe(false);
  });

  // Regression: when the caller already statted the file (the mtime-window filter in
  // collectRootJsonlSessionIds), fileBelongsToTeam must reuse that stat rather than
  // issuing a second fs.stat of the same file. Proven without mocking fs: a precomputed
  // stat with a deliberately distinct size/mtime must be the one recorded in the cache.
  it('reuses a caller-supplied stat instead of re-statting the file', async () => {
    await setupClaudeRoot();
    const resolver = new TeamTranscriptProjectResolver() as unknown as ResolverProbe;
    const team = 'absent-team';
    const projectDir = path.join(tmpDir!, 'projects', encodePath('/repo/precomp'));
    await fs.mkdir(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, 'f.jsonl');
    await fs.writeFile(
      jsonlPath,
      `${Array.from({ length: 45 }, (_, i) =>
        JSON.stringify({ type: 'user', message: { role: 'user', content: `x ${i}` } })
      ).join('\n')}\n`,
      'utf8'
    );

    // Distinct sentinel values the real file does not have.
    const precomputedStat = { mtimeMs: 123_456, size: 999_999, isFile: () => true };
    expect(await resolver.fileBelongsToTeam(jsonlPath, team, precomputedStat)).toBe(false);

    const key = resolver.buildTeamAffinityFileCacheKey(jsonlPath, team);
    const entry = resolver.teamAffinityFileCache.get(key);
    expect(entry?.size).toBe(999_999); // cache recorded the precomputed stat -> no re-stat
    expect(entry?.mtimeMs).toBe(123_456);
  });

  it('reuses parsed head metadata across different team lookups for the same file signature', async () => {
    await setupClaudeRoot();
    const resolver = new TeamTranscriptProjectResolver() as unknown as ResolverProbe;
    const projectDir = path.join(tmpDir!, 'projects', encodePath('/repo/head-cache'));
    await fs.mkdir(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, 'shared.jsonl');
    await fs.writeFile(
      jsonlPath,
      [
        teamTextLine('alpha-team'),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', input: { teamName: 'beta-team' } }],
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const fileStat = await fs.stat(jsonlPath);
    expect(await resolver.fileBelongsToTeam(jsonlPath, 'alpha-team', fileStat)).toBe(true);
    await fs.unlink(jsonlPath);
    expect(await resolver.fileBelongsToTeam(jsonlPath, 'beta-team', fileStat)).toBe(true);
    expect(await resolver.fileBelongsToTeam(jsonlPath, 'missing-team', fileStat)).toBe(false);

    expect(resolver.teamAffinityHeadMetadataCache.size).toBe(1);
    expect(resolver.teamAffinityHeadMetadataCache.get(jsonlPath)?.inspectedLineCount).toBe(2);
    expect(resolver.teamAffinityFileCache.get(`alpha-team\0${jsonlPath}`)).toMatchObject({
      belongsToTeam: true,
      headWindowFull: false,
    });
    expect(resolver.teamAffinityFileCache.get(`beta-team\0${jsonlPath}`)).toMatchObject({
      belongsToTeam: true,
      headWindowFull: false,
    });
    expect(resolver.teamAffinityFileCache.get(`missing-team\0${jsonlPath}`)).toMatchObject({
      belongsToTeam: false,
      headWindowFull: false,
    });
  });

  it('refreshes parsed head metadata when the file signature changes before a new team lookup', async () => {
    await setupClaudeRoot();
    const resolver = new TeamTranscriptProjectResolver() as unknown as ResolverProbe;
    const projectDir = path.join(tmpDir!, 'projects', encodePath('/repo/head-cache-refresh'));
    await fs.mkdir(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, 'changing.jsonl');
    await fs.writeFile(jsonlPath, `${teamTextLine('alpha-team')}\n`, 'utf8');

    const firstStat = await fs.stat(jsonlPath);
    expect(await resolver.fileBelongsToTeam(jsonlPath, 'missing-team', firstStat)).toBe(false);
    expect(resolver.teamAffinityHeadMetadataCache.get(jsonlPath)).toMatchObject({
      mtimeMs: firstStat.mtimeMs,
      size: firstStat.size,
      inspectedLineCount: 1,
    });

    await fs.writeFile(jsonlPath, `${noiseLine(0)}\n${teamTextLine('beta-team')}\n`, 'utf8');
    const updatedAt = new Date(Date.now() + 5_000);
    await fs.utimes(jsonlPath, updatedAt, updatedAt);
    const secondStat = await fs.stat(jsonlPath);

    expect(await resolver.fileBelongsToTeam(jsonlPath, 'beta-team', secondStat)).toBe(true);
    expect(resolver.teamAffinityHeadMetadataCache.size).toBe(1);
    expect(resolver.teamAffinityHeadMetadataCache.get(jsonlPath)).toMatchObject({
      mtimeMs: secondStat.mtimeMs,
      size: secondStat.size,
      inspectedLineCount: 2,
    });
  });

  it('caches malformed head lines as inspected non-matches while ignoring blank lines', async () => {
    await setupClaudeRoot();
    const resolver = new TeamTranscriptProjectResolver() as unknown as ResolverProbe;
    const projectDir = path.join(tmpDir!, 'projects', encodePath('/repo/head-cache-malformed'));
    await fs.mkdir(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, 'malformed.jsonl');
    await fs.writeFile(jsonlPath, `\n{not-json\n\n${teamTextLine('malformed-team')}\n`, 'utf8');

    const fileStat = await fs.stat(jsonlPath);
    expect(await resolver.fileBelongsToTeam(jsonlPath, 'malformed-team', fileStat)).toBe(true);

    const cachedHead = resolver.teamAffinityHeadMetadataCache.get(jsonlPath);
    expect(cachedHead?.inspectedLineCount).toBe(2);
    expect(cachedHead?.lines).toHaveLength(2);

    await fs.unlink(jsonlPath);
    expect(await resolver.fileBelongsToTeam(jsonlPath, 'missing-team', fileStat)).toBe(false);
  });

  it('does not retain full normalized text content in cached head metadata', async () => {
    await setupClaudeRoot();
    const resolver = new TeamTranscriptProjectResolver() as unknown as ResolverProbe;
    const team = 'memory-safe-team';
    const projectDir = path.join(tmpDir!, 'projects', encodePath('/repo/head-cache-text-retention'));
    await fs.mkdir(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, 'large-line.jsonl');
    await fs.writeFile(
      jsonlPath,
      `${JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `${'x'.repeat(100_000)}\nCurrent durable team context:\n- Team name: ${team}\n${'y'.repeat(100_000)}`,
            },
          ],
        },
      })}\n`,
      'utf8'
    );

    const fileStat = await fs.stat(jsonlPath);
    expect(await resolver.fileBelongsToTeam(jsonlPath, team, fileStat)).toBe(true);
    const cachedHead = resolver.teamAffinityHeadMetadataCache.get(jsonlPath);
    const cachedLine = cachedHead?.lines[0] as
      | { normalizedTextContent?: unknown; textMentionTeamNames?: Set<string> }
      | undefined;

    expect(cachedLine?.normalizedTextContent).toBeUndefined();
    expect(cachedLine?.textMentionTeamNames?.has(team)).toBe(true);
  });

  it('keeps cached head metadata bounded to 40 lines when the first lookup matches early', async () => {
    await setupClaudeRoot();
    const resolver = new TeamTranscriptProjectResolver() as unknown as ResolverProbe;
    const projectDir = path.join(tmpDir!, 'projects', encodePath('/repo/head-cache-bound'));
    await fs.mkdir(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, 'bound.jsonl');
    const lines = [
      teamTextLine('early-team'),
      ...Array.from({ length: 39 }, (_, i) => noiseLine(i)),
      teamTextLine('late-team'),
    ];
    await fs.writeFile(jsonlPath, `${lines.join('\n')}\n`, 'utf8');

    const fileStat = await fs.stat(jsonlPath);
    expect(await resolver.fileBelongsToTeam(jsonlPath, 'early-team', fileStat)).toBe(true);
    expect(resolver.teamAffinityHeadMetadataCache.get(jsonlPath)?.inspectedLineCount).toBe(40);
    expect(resolver.teamAffinityHeadMetadataCache.get(jsonlPath)?.lines).toHaveLength(40);

    await fs.unlink(jsonlPath);
    expect(await resolver.fileBelongsToTeam(jsonlPath, 'late-team', fileStat)).toBe(false);
    expect(resolver.teamAffinityFileCache.get(`late-team\0${jsonlPath}`)).toMatchObject({
      belongsToTeam: false,
      headWindowFull: true,
    });
  });

  // The head-window scan reads chunks + splits on '\n' (not readline). These lock the
  // byte-exact equivalence: CRLF endings, a final line with no trailing newline, a
  // multi-byte char straddling the 64KB read boundary, and the 40-line window bound.
  const teamTextLine = (team: string) =>
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: `Team name: ${team}` }] },
    });
  const noiseLine = (i: number) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: `noise ${i}` } });

  it('matches with CRLF line endings and a final line that has no trailing newline', async () => {
    await setupClaudeRoot();
    const resolver = new TeamTranscriptProjectResolver() as unknown as ResolverProbe;
    const team = 'crlf-team';
    const projectDir = path.join(tmpDir!, 'projects', encodePath('/repo/crlf'));
    await fs.mkdir(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, 'c.jsonl');
    // CRLF separators; the matching line is last and has NO trailing newline.
    await fs.writeFile(
      jsonlPath,
      `${noiseLine(0)}\r\n${noiseLine(1)}\r\n${teamTextLine(team)}`,
      'utf8'
    );
    expect(await resolver.fileBelongsToTeam(jsonlPath, team)).toBe(true);
  });

  it('matches a team mention located past the 64KB read boundary with multi-byte content', async () => {
    await setupClaudeRoot();
    const resolver = new TeamTranscriptProjectResolver() as unknown as ResolverProbe;
    const team = 'boundary-team';
    const projectDir = path.join(tmpDir!, 'projects', encodePath('/repo/mb'));
    await fs.mkdir(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, 'mb.jsonl');
    // ~40KB of 2-byte Cyrillic per line: the first two lines (~80KB) push the matching
    // third line past the 64KB read chunk and force a multi-byte char to straddle the
    // chunk boundary, which the StringDecoder must stitch back together.
    const big = 'я'.repeat(20_000);
    const heavy = (i: number) =>
      JSON.stringify({ type: 'user', message: { role: 'user', content: `${big} ${i}` } });
    await fs.writeFile(jsonlPath, `${heavy(0)}\n${heavy(1)}\n${teamTextLine(team)}\n`, 'utf8');
    expect(await resolver.fileBelongsToTeam(jsonlPath, team)).toBe(true);
  });

  it('ignores a team mention that appears only after the 40-line head window', async () => {
    await setupClaudeRoot();
    const resolver = new TeamTranscriptProjectResolver() as unknown as ResolverProbe;
    const team = 'late-team';
    const projectDir = path.join(tmpDir!, 'projects', encodePath('/repo/late'));
    await fs.mkdir(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, 'late.jsonl');
    // 40 non-matching lines fill the head window; the mention is on line 41.
    const lines = Array.from({ length: 40 }, (_, i) => noiseLine(i));
    lines.push(teamTextLine(team));
    await fs.writeFile(jsonlPath, `${lines.join('\n')}\n`, 'utf8');
    expect(await resolver.fileBelongsToTeam(jsonlPath, team)).toBe(false);
  });
});
