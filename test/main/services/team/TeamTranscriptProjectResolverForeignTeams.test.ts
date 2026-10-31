import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamTranscriptProjectResolver } from '../../../../src/main/services/team/TeamTranscriptProjectResolver';
import { encodePath, setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';
import { snapshotDirectoryTree } from '../../../helpers/directorySnapshot';

import type { TeamFileWritePolicy } from '../../../../src/main/services/team/teamFileWritePolicy';
import type { TeamConfig } from '../../../../src/shared/types/team';

// The teams directory is shared with other app profiles and native sessions. A resolver
// that may not write a team's files still resolves it fully, but leaves every byte of the
// shared tree as it was.
describe('TeamTranscriptProjectResolver for teams it may not write', () => {
  let tmpDir: string | null = null;
  const originalAffinityIndexEnv = process.env.CLAUDE_TEAM_TRANSCRIPT_AFFINITY_INDEX;
  const readOnly: TeamFileWritePolicy = () => Promise.resolve(false);
  const writeOwnTeamFiles: TeamFileWritePolicy = () => Promise.resolve(true);

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
    delete process.env.CLAUDE_TEAM_TRANSCRIPT_AFFINITY_INDEX;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-transcript-foreign-teams-'));
    setClaudeBasePathOverride(tmpDir);
    await fs.mkdir(path.join(tmpDir, 'teams'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true });
    return tmpDir;
  }

  function configPath(teamName: string): string {
    return path.join(tmpDir!, 'teams', teamName, 'config.json');
  }

  async function writeTeamConfig(teamName: string, config: TeamConfig): Promise<void> {
    await fs.mkdir(path.dirname(configPath(teamName)), { recursive: true });
    await fs.writeFile(configPath(teamName), JSON.stringify(config, null, 2), 'utf8');
  }

  function affinityIndexPath(teamName: string, projectPath: string): string {
    return path.join(
      tmpDir!,
      'teams',
      teamName,
      'cache',
      'transcript-affinity',
      `${encodeURIComponent(encodePath(projectPath))}.json`
    );
  }

  async function readIndexedFileNames(teamName: string, projectPath: string): Promise<string[]> {
    const raw = await fs.readFile(affinityIndexPath(teamName, projectPath), 'utf8');
    return Object.keys((JSON.parse(raw) as { entries: Record<string, unknown> }).entries).sort();
  }

  async function writeTeamTranscript(
    projectPath: string,
    sessionId: string,
    teamName: string
  ): Promise<void> {
    const projectDir = path.join(tmpDir!, 'projects', encodePath(projectPath));
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: 'user',
        timestamp: '2026-04-18T10:00:00.000Z',
        cwd: projectPath,
        message: {
          role: 'user',
          content: [
            { type: 'text', text: `Current durable team context:\n- Team name: ${teamName}` },
          ],
        },
      })}\n`,
      'utf8'
    );
  }

  async function setupTeamWithTranscript(teamName: string, projectPath: string): Promise<void> {
    await writeTeamTranscript(projectPath, 'indexed-session', teamName);
    await writeTeamConfig(teamName, {
      name: teamName,
      projectPath,
      members: [{ name: 'team-lead', agentType: 'team-lead', cwd: projectPath }],
    });
  }

  /** The owning profile indexed the team earlier; a transcript written since makes it stale. */
  async function setupTeamWithStaleIndex(teamName: string, projectPath: string): Promise<void> {
    await setupTeamWithTranscript(teamName, projectPath);
    await new TeamTranscriptProjectResolver(writeOwnTeamFiles).getContext(teamName, {
      forceRefresh: true,
    });
    await expect(readIndexedFileNames(teamName, projectPath)).resolves.toEqual([
      'indexed-session.jsonl',
    ]);
    await writeTeamTranscript(projectPath, 'new-session', teamName);
  }

  it('finds a new transcript of another team through its stale index without rewriting it', async () => {
    const root = await setupClaudeRoot();
    const teamName = 'other-profile-team';
    const projectPath = '/Users/test/other-profile';
    await setupTeamWithStaleIndex(teamName, projectPath);
    const before = await snapshotDirectoryTree(root);
    const canWriteTeamFiles = vi.fn(readOnly);

    const context = await new TeamTranscriptProjectResolver(canWriteTeamFiles).getContext(
      teamName,
      { forceRefresh: true }
    );

    expect(context?.sessionIds).toEqual(expect.arrayContaining(['indexed-session', 'new-session']));
    expect(canWriteTeamFiles).toHaveBeenCalledWith(teamName);
    expect(await snapshotDirectoryTree(root)).toEqual(before);
  });

  it('still updates the stale index of a team this profile manages', async () => {
    await setupClaudeRoot();
    const teamName = 'own-profile-team';
    const projectPath = '/Users/test/own-profile';
    await setupTeamWithStaleIndex(teamName, projectPath);

    const context = await new TeamTranscriptProjectResolver(writeOwnTeamFiles).getContext(
      teamName,
      { forceRefresh: true }
    );

    expect(context?.sessionIds).toEqual(expect.arrayContaining(['indexed-session', 'new-session']));
    await expect(readIndexedFileNames(teamName, projectPath)).resolves.toEqual([
      'indexed-session.jsonl',
      'new-session.jsonl',
    ]);
  });

  it('does not create a cache directory for another team that has no index', async () => {
    const root = await setupClaudeRoot();
    const teamName = 'unindexed-other-team';
    await setupTeamWithTranscript(teamName, '/Users/test/unindexed-other');
    const before = await snapshotDirectoryTree(root);

    const context = await new TeamTranscriptProjectResolver(readOnly).getContext(teamName, {
      forceRefresh: true,
    });

    expect(context?.sessionIds).toContain('indexed-session');
    await expect(fs.access(path.join(root, 'teams', teamName, 'cache'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await snapshotDirectoryTree(root)).toEqual(before);
  });

  it('leaves a corrupt index of another team in place', async () => {
    const root = await setupClaudeRoot();
    const teamName = 'corrupt-index-other-team';
    const projectPath = '/Users/test/corrupt-index-other';
    await setupTeamWithTranscript(teamName, projectPath);
    const indexPath = affinityIndexPath(teamName, projectPath);
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(indexPath, '{not-json', 'utf8');
    const before = await snapshotDirectoryTree(root);

    const context = await new TeamTranscriptProjectResolver(readOnly).getContext(teamName, {
      forceRefresh: true,
    });

    expect(context?.sessionIds).toContain('indexed-session');
    await expect(fs.readFile(indexPath, 'utf8')).resolves.toBe('{not-json');
    expect(await snapshotDirectoryTree(root)).toEqual(before);
  });

  it('replaces a corrupt index of a team this profile manages', async () => {
    await setupClaudeRoot();
    const teamName = 'corrupt-index-own-team';
    const projectPath = '/Users/test/corrupt-index-own';
    await setupTeamWithTranscript(teamName, projectPath);
    const indexPath = affinityIndexPath(teamName, projectPath);
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(indexPath, '{not-json', 'utf8');

    await new TeamTranscriptProjectResolver(writeOwnTeamFiles).getContext(teamName, {
      forceRefresh: true,
    });

    await expect(readIndexedFileNames(teamName, projectPath)).resolves.toEqual([
      'indexed-session.jsonl',
    ]);
  });

  it.each<[string, TeamFileWritePolicy]>([
    ['rejects', () => Promise.reject(new Error('ownership is unavailable'))],
    [
      'throws',
      () => {
        throw new Error('ownership is unavailable');
      },
    ],
    ['answers anything but true', () => Promise.resolve('yes' as unknown as boolean)],
  ])('treats a write policy that %s as read only', async (_label, canWriteTeamFiles) => {
    const root = await setupClaudeRoot();
    const teamName = 'unknown-owner-team';
    await setupTeamWithTranscript(teamName, '/Users/test/unknown-owner');
    const before = await snapshotDirectoryTree(root);

    const context = await new TeamTranscriptProjectResolver(canWriteTeamFiles).getContext(
      teamName,
      { forceRefresh: true }
    );

    expect(context?.sessionIds).toContain('indexed-session');
    expect(await snapshotDirectoryTree(root)).toEqual(before);
  });

  describe('when the exact lead session exists only in a renamed project', () => {
    const teamName = 'renamed-project-team';
    const staleProjectPath = '/Users/test/hookplex';
    const repairedProjectPath = '/Users/test/plugin-kit-ai';
    const leadSessionId = 'lead-1';

    async function setupRenamedProject(): Promise<{ root: string; repairedProjectDir: string }> {
      const root = await setupClaudeRoot();
      await fs.mkdir(path.join(root, 'projects', encodePath(staleProjectPath)), {
        recursive: true,
      });
      const repairedProjectDir = path.join(root, 'projects', encodePath(repairedProjectPath));
      await fs.mkdir(repairedProjectDir, { recursive: true });
      await fs.writeFile(
        path.join(repairedProjectDir, `${leadSessionId}.jsonl`),
        `${JSON.stringify({
          type: 'assistant',
          timestamp: '2026-04-18T10:00:00.000Z',
          cwd: repairedProjectPath,
          message: { role: 'assistant', content: [{ type: 'text', text: 'probe' }] },
        })}\n`,
        'utf8'
      );
      await writeTeamConfig(teamName, {
        name: 'My Team',
        projectPath: staleProjectPath,
        leadSessionId,
        members: [{ name: 'team-lead', agentType: 'team-lead', cwd: repairedProjectPath }],
      });
      return { root, repairedProjectDir };
    }

    it('resolves another team to the renamed project without repairing its config.json', async () => {
      const { root, repairedProjectDir } = await setupRenamedProject();
      const configBefore = await fs.readFile(configPath(teamName));
      const before = await snapshotDirectoryTree(root);

      const context = await new TeamTranscriptProjectResolver(readOnly).getContext(teamName);

      expect(context?.projectDir).toBe(repairedProjectDir);
      expect(context?.config.projectPath).toBe(repairedProjectPath);
      expect(context?.sessionIds).toContain(leadSessionId);
      expect((await fs.readFile(configPath(teamName))).equals(configBefore)).toBe(true);
      expect(await snapshotDirectoryTree(root)).toEqual(before);
    });

    it('repairs config.json of a team this profile manages', async () => {
      const { repairedProjectDir } = await setupRenamedProject();

      const context = await new TeamTranscriptProjectResolver(writeOwnTeamFiles).getContext(
        teamName
      );
      const persisted = JSON.parse(await fs.readFile(configPath(teamName), 'utf8')) as TeamConfig;

      expect(context?.projectDir).toBe(repairedProjectDir);
      expect(persisted.projectPath).toBe(repairedProjectPath);
      expect(persisted.projectPathHistory).toEqual([staleProjectPath]);
    });
  });
});
