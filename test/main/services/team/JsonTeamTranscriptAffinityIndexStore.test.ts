import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { JsonTeamTranscriptAffinityIndexStore } from '../../../../src/main/services/team/cache/JsonTeamTranscriptAffinityIndexStore';
import {
  type PersistedTeamTranscriptAffinityEntry,
  TEAM_TRANSCRIPT_AFFINITY_INDEX_SCHEMA_VERSION,
} from '../../../../src/main/services/team/cache/teamTranscriptAffinityIndexTypes';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

describe('JsonTeamTranscriptAffinityIndexStore', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  async function setupClaudeRoot(): Promise<string> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-transcript-affinity-index-'));
    setClaudeBasePathOverride(tmpDir);
    await fs.mkdir(path.join(tmpDir, 'teams'), { recursive: true });
    return tmpDir;
  }

  function indexPath(teamName: string, projectId: string): string {
    return path.join(
      tmpDir!,
      'teams',
      teamName,
      'cache',
      'transcript-affinity',
      `${encodeURIComponent(projectId)}.json`
    );
  }

  function entry(
    fileName: string,
    overrides: Partial<PersistedTeamTranscriptAffinityEntry> = {}
  ): PersistedTeamTranscriptAffinityEntry {
    return {
      fileName,
      sessionId: fileName.slice(0, -'.jsonl'.length),
      signature: { size: 100, mtimeMs: 200, ctimeMs: 300 },
      verdict: 'belongs',
      headWindowFull: false,
      inspectedLineCount: 1,
      matchSource: 'text_team_mention',
      writtenAt: '2026-05-30T10:00:00.000Z',
      ...overrides,
    };
  }

  it('returns null for a missing index', async () => {
    await setupClaudeRoot();
    const store = new JsonTeamTranscriptAffinityIndexStore();

    await expect(store.loadProject('team-a', 'project-a')).resolves.toBeNull();
  });

  it('upserts entries, prunes deleted root files, and caps by newest writtenAt', async () => {
    await setupClaudeRoot();
    const store = new JsonTeamTranscriptAffinityIndexStore({ maxEntriesPerProject: 2 });

    await store.upsertProjectEntries({
      teamName: 'team-a',
      projectId: 'project-a',
      projectDir: '/repo/a',
      rootFileNames: new Set(['a.jsonl', 'b.jsonl']),
      entries: [
        entry('a.jsonl', { writtenAt: '2026-05-30T10:00:00.000Z' }),
        entry('b.jsonl', { writtenAt: '2026-05-30T10:01:00.000Z' }),
      ],
    });

    await store.upsertProjectEntries({
      teamName: 'team-a',
      projectId: 'project-a',
      projectDir: '/repo/a',
      rootFileNames: new Set(['b.jsonl', 'c.jsonl', 'd.jsonl']),
      entries: [
        entry('c.jsonl', { writtenAt: '2026-05-30T10:02:00.000Z' }),
        entry('d.jsonl', { writtenAt: '2026-05-30T10:03:00.000Z' }),
      ],
    });

    const loaded = await store.loadProject('team-a', 'project-a');

    expect(Object.keys(loaded?.entries ?? {}).sort()).toEqual(['c.jsonl', 'd.jsonl']);
    expect(loaded?.entries['a.jsonl']).toBeUndefined();
    expect(loaded?.projectDir).toBe('/repo/a');
  });

  it('deletes corrupt or wrong-schema index files without throwing', async () => {
    await setupClaudeRoot();
    const store = new JsonTeamTranscriptAffinityIndexStore();
    const filePath = indexPath('team-a', 'project-a');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{not-json', 'utf8');

    await expect(store.loadProject('team-a', 'project-a')).resolves.toBeNull();
    await expect(fs.access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: TEAM_TRANSCRIPT_AFFINITY_INDEX_SCHEMA_VERSION + 1,
        teamName: 'team-a',
        projectId: 'project-a',
        projectDir: '/repo/a',
        writtenAt: '2026-05-30T10:00:00.000Z',
        entries: {},
      }),
      'utf8'
    );

    await expect(store.loadProject('team-a', 'project-a')).resolves.toBeNull();
    await expect(fs.access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('skips invalid entries while preserving valid entries in the same index', async () => {
    await setupClaudeRoot();
    const store = new JsonTeamTranscriptAffinityIndexStore();
    const filePath = indexPath('team-a', 'project-a');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: TEAM_TRANSCRIPT_AFFINITY_INDEX_SCHEMA_VERSION,
        teamName: 'team-a',
        projectId: 'project-a',
        projectDir: '/repo/a',
        writtenAt: '2026-05-30T10:00:00.000Z',
        entries: {
          'good.jsonl': entry('good.jsonl'),
          '../bad.jsonl': entry('../bad.jsonl'),
          'wrong-session.jsonl': entry('wrong-session.jsonl', { sessionId: 'different' }),
        },
      }),
      'utf8'
    );

    const loaded = await store.loadProject('team-a', 'project-a');

    expect(Object.keys(loaded?.entries ?? {})).toEqual(['good.jsonl']);
  });
});
