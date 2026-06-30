import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BOOTSTRAP_FAILURE_TAIL_BYTES,
  BOOTSTRAP_TRANSCRIPT_OUTCOME_CACHE_MAX_ENTRIES,
  type BootstrapTranscriptOutcome,
  type BootstrapTranscriptOutcomeCacheEntry,
  getBootstrapRuntimeEventsPath,
  getParsedBootstrapTranscriptTail,
  isContainedTeamRuntimeEventsPath,
  type ParsedBootstrapTranscriptTailCacheEntry,
  type ParsedBootstrapTranscriptTailLine,
  readLeadInboxMessagesForLaunchReconcile,
  readRecentBootstrapTranscriptOutcome,
} from '../../../../src/main/services/team/provisioning/TeamProvisioningBootstrapTranscript';

interface TranscriptIndexHarness {
  bootstrapTranscriptOutcomeCache: Map<string, BootstrapTranscriptOutcomeCacheEntry>;
  parsedBootstrapTranscriptTailCache: Map<string, ParsedBootstrapTranscriptTailCacheEntry>;
  getParsedBootstrapTranscriptTail: (
    filePath: string,
    stat: { mtimeMs: number; size: number }
  ) => Promise<ParsedBootstrapTranscriptTailLine[]>;
  readRecentBootstrapTranscriptOutcome: (
    filePath: string,
    sinceMs: number | null,
    memberName: string,
    teamName: string,
    options?: { allowAnonymousFailure?: boolean; contextMemberNames?: readonly string[] }
  ) => Promise<BootstrapTranscriptOutcome | null>;
}

function createTranscriptIndexHarness(): TranscriptIndexHarness {
  const harness: TranscriptIndexHarness = {
    bootstrapTranscriptOutcomeCache: new Map(),
    parsedBootstrapTranscriptTailCache: new Map(),
    getParsedBootstrapTranscriptTail(filePath, stat) {
      return getParsedBootstrapTranscriptTail({
        filePath,
        stat,
        cache: harness.parsedBootstrapTranscriptTailCache,
        tailBytes: BOOTSTRAP_FAILURE_TAIL_BYTES,
        maxCacheEntries: BOOTSTRAP_TRANSCRIPT_OUTCOME_CACHE_MAX_ENTRIES,
      });
    },
    readRecentBootstrapTranscriptOutcome(filePath, sinceMs, memberName, teamName, options) {
      return readRecentBootstrapTranscriptOutcome({
        filePath,
        sinceMs,
        memberName,
        teamName,
        options,
        outcomeCache: harness.bootstrapTranscriptOutcomeCache,
        getParsedBootstrapTranscriptTail: (transcriptPath, stat) =>
          harness.getParsedBootstrapTranscriptTail(transcriptPath, stat),
        maxCacheEntries: BOOTSTRAP_TRANSCRIPT_OUTCOME_CACHE_MAX_ENTRIES,
      });
    },
  };
  return harness;
}

function transcriptLine(input: {
  timestamp: string;
  agentName?: string;
  text: string;
}): string {
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: input.timestamp,
    ...(input.agentName ? { agentName: input.agentName } : {}),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: input.text }],
    },
  })}\n`;
}

describe('TeamProvisioningService bootstrap transcript index', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('updates the transcript outcome from appended lines using the incremental file index', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-transcript-index-'));
    const transcriptPath = path.join(tmpDir, 'session.jsonl');
    await fs.writeFile(
      transcriptPath,
      transcriptLine({
        timestamp: '2026-04-18T10:00:00.000Z',
        agentName: 'alice',
        text: 'Member briefing for alice on team "demo-team" (demo-team).',
      }),
      'utf8'
    );

    const service = createTranscriptIndexHarness();
    const originalParseTail = service.getParsedBootstrapTranscriptTail.bind(service);
    let parseTailCalls = 0;
    service.getParsedBootstrapTranscriptTail = async (
      ...args: Parameters<TranscriptIndexHarness['getParsedBootstrapTranscriptTail']>
    ) => {
      parseTailCalls += 1;
      return originalParseTail(...args);
    };

    await expect(
      service.readRecentBootstrapTranscriptOutcome(
        transcriptPath,
        null,
        'alice',
        'demo-team',
        { contextMemberNames: ['alice'] }
      )
    ).resolves.toEqual({
      kind: 'success',
      observedAt: '2026-04-18T10:00:00.000Z',
      source: 'member_briefing',
    });
    expect(parseTailCalls).toBe(1);

    await fs.appendFile(
      transcriptPath,
      transcriptLine({
        timestamp: '2026-04-18T10:01:00.000Z',
        text: 'Bootstrap failed: member_briefing tool is not available',
      }),
      'utf8'
    );

    await expect(
      service.readRecentBootstrapTranscriptOutcome(
        transcriptPath,
        null,
        'alice',
        'demo-team',
        { contextMemberNames: ['alice'] }
      )
    ).resolves.toEqual({
      kind: 'failure',
      observedAt: '2026-04-18T10:01:00.000Z',
      reason: 'Bootstrap failed: member_briefing tool is not available',
    });
    expect(parseTailCalls).toBe(2);

    await expect(
      service.readRecentBootstrapTranscriptOutcome(
        transcriptPath,
        null,
        'alice',
        'demo-team',
        { contextMemberNames: ['alice'] }
      )
    ).resolves.toEqual({
      kind: 'failure',
      observedAt: '2026-04-18T10:01:00.000Z',
      reason: 'Bootstrap failed: member_briefing tool is not available',
    });
    expect(parseTailCalls).toBe(2);
  });

  it('rejects unsafe launch reconcile and runtime proof paths before filesystem reads', async () => {
    const readPaths: string[] = [];
    const readRegularFileUtf8 = async (filePath: string): Promise<string | null> => {
      readPaths.push(filePath);
      return '[]';
    };

    await expect(
      readLeadInboxMessagesForLaunchReconcile({
        teamName: '../outside',
        leadName: 'team-lead',
        teamsBasePath: '/tmp/teams',
        readRegularFileUtf8,
        timeoutMs: 100,
        maxBytes: 1024,
      })
    ).resolves.toEqual([]);
    await expect(
      readLeadInboxMessagesForLaunchReconcile({
        teamName: 'demo-team',
        leadName: '../../lead',
        teamsBasePath: '/tmp/teams',
        readRegularFileUtf8,
        timeoutMs: 100,
        maxBytes: 1024,
      })
    ).resolves.toEqual([]);

    expect(readPaths).toEqual([]);

    await expect(
      readLeadInboxMessagesForLaunchReconcile({
        teamName: 'demo-team',
        leadName: 'team-lead',
        teamsBasePath: path.join('/tmp', 'teams'),
        readRegularFileUtf8,
        timeoutMs: 100,
        maxBytes: 1024,
      })
    ).resolves.toEqual([]);
    expect(readPaths).toEqual([
      path.join('/tmp', 'teams', 'demo-team', 'inboxes', 'team-lead.json'),
    ]);
    readPaths.length = 0;

    const safeRuntimePath = path.join(
      '/tmp',
      'teams',
      'demo-team',
      'runtime',
      'alice.runtime.jsonl'
    );
    expect(
      getBootstrapRuntimeEventsPath({
        teamsBasePath: path.join('/tmp', 'teams'),
        teamName: 'demo-team',
        memberName: 'alice',
        runtimeMember: {
          name: 'alice',
          bootstrapRuntimeEventsPath: safeRuntimePath,
        },
      })
    ).toBe(safeRuntimePath);

    if (process.platform !== 'win32') {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-transcript-paths-'));
      const teamsBasePath = path.join(tmpDir, 'teams');
      const teamDir = path.join(teamsBasePath, 'demo-team');
      const outsideDir = path.join(tmpDir, 'outside');
      await fs.mkdir(teamDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.symlink(outsideDir, path.join(teamDir, 'inboxes'), 'dir');
      await fs.symlink(outsideDir, path.join(teamDir, 'runtime'), 'dir');

      await expect(
        readLeadInboxMessagesForLaunchReconcile({
          teamName: 'demo-team',
          leadName: 'team-lead',
          teamsBasePath,
          readRegularFileUtf8,
          timeoutMs: 100,
          maxBytes: 1024,
        })
      ).resolves.toEqual([]);
      expect(readPaths).toEqual([]);

      expect(
        isContainedTeamRuntimeEventsPath({
          teamsBasePath,
          teamName: 'demo-team',
          candidatePath: path.join(teamDir, 'runtime', 'alice.runtime.jsonl'),
        })
      ).toBe(false);
      expect(
        getBootstrapRuntimeEventsPath({
          teamsBasePath,
          teamName: 'demo-team',
          memberName: 'alice',
          runtimeMember: undefined,
        })
      ).toBeNull();
    }

    expect(
      isContainedTeamRuntimeEventsPath({
        teamsBasePath: path.join('/tmp', 'teams'),
        teamName: '../outside',
        candidatePath: path.join('/tmp', 'outside', 'runtime', 'alice.runtime.jsonl'),
      })
    ).toBe(false);
    expect(
      getBootstrapRuntimeEventsPath({
        teamsBasePath: path.join('/tmp', 'teams'),
        teamName: '../outside',
        memberName: 'alice',
        runtimeMember: undefined,
      })
    ).toBeNull();
    expect(
      getBootstrapRuntimeEventsPath({
        teamsBasePath: path.join('/tmp', 'teams'),
        teamName: '../outside',
        memberName: 'alice',
        runtimeMember: {
          name: 'alice',
          bootstrapRuntimeEventsPath: path.join('/tmp', 'outside', 'runtime', 'alice.runtime.jsonl'),
        },
      })
    ).toBeNull();
  });
});
