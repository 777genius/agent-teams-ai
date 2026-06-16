import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/tmux-installer/main', () => ({
  killTmuxPaneForCurrentPlatformSync: vi.fn(),
  listRuntimeProcessTableForCurrentPlatform: vi.fn(async () => []),
  listTmuxPanePidsForCurrentPlatform: vi.fn(async () => new Map()),
  listTmuxPaneRuntimeInfoForCurrentPlatform: vi.fn(async () => new Map()),
  sendKeysToTmuxPaneForCurrentPlatform: vi.fn(async () => undefined),
}));

vi.mock('pidusage', () => ({
  default: vi.fn(),
}));

import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';

interface TranscriptIndexHarness {
  bootstrapTranscriptOutcomeCache: Map<string, unknown>;
  bootstrapTranscriptOutcomeInFlight: Map<string, Promise<unknown>>;
  parsedBootstrapTranscriptTailCache: Map<string, unknown>;
  getParsedBootstrapTranscriptTail: (...args: unknown[]) => Promise<unknown>;
  readRecentBootstrapTranscriptOutcome: (
    filePath: string,
    sinceMs: number | null,
    memberName: string,
    teamName: string,
    options?: { allowAnonymousFailure?: boolean; contextMemberNames?: readonly string[] }
  ) => Promise<unknown>;
}

function createTranscriptIndexHarness(): TranscriptIndexHarness {
  const service = Object.create(
    TeamProvisioningService.prototype
  ) as unknown as TranscriptIndexHarness;
  service.bootstrapTranscriptOutcomeCache = new Map();
  service.bootstrapTranscriptOutcomeInFlight = new Map();
  service.parsedBootstrapTranscriptTailCache = new Map();
  return service;
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
    service.getParsedBootstrapTranscriptTail = async (...args: unknown[]) => {
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
