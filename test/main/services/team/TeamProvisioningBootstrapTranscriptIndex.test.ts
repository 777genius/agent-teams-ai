import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BOOTSTRAP_FAILURE_TAIL_BYTES,
  BOOTSTRAP_TRANSCRIPT_OUTCOME_CACHE_MAX_ENTRIES,
  type BootstrapTranscriptOutcome,
  type BootstrapTranscriptOutcomeCacheEntry,
  getParsedBootstrapTranscriptTail,
  type ParsedBootstrapTranscriptTailCacheEntry,
  type ParsedBootstrapTranscriptTailLine,
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
});
