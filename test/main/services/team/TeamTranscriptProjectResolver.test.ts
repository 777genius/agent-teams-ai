import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamTranscriptProjectResolver } from '../../../../src/main/services/team/TeamTranscriptProjectResolver';
import { encodePath, setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

import type { TeamConfig } from '../../../../src/shared/types/team';

describe('TeamTranscriptProjectResolver', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    setClaudeBasePathOverride(null);
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

  // Regression for the launch hot path: non-matching transcripts must not be
  // re-streamed + re-parsed on every bootstrap poll. A negative verdict decided from
  // a FULL head window (>= 40 inspected lines) is durable while the file only grows,
  // because an append-only transcript's head is immutable. Observed via the private
  // affinity cache: the durable branch returns WITHOUT re-caching, so the cached size
  // stays at the first scan's size (a re-scan would update it to the grown size).
  type AffinityCacheEntry = {
    mtimeMs: number;
    size: number;
    belongsToTeam: boolean;
    headWindowFull: boolean;
  };
  type ResolverProbe = {
    fileBelongsToTeam: (
      filePath: string,
      teamName: string,
      precomputedStat?: { mtimeMs: number; size: number; isFile: () => boolean }
    ) => Promise<boolean>;
    buildTeamAffinityFileCacheKey: (filePath: string, normalizedTeam: string) => string;
    teamAffinityFileCache: Map<string, AffinityCacheEntry>;
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
