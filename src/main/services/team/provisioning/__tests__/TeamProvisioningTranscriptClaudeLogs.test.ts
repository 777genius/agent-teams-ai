import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROGRESS_RETAINED_LOG_LINES } from '../../progressPayload';
import {
  readTranscriptClaudeLogLines,
  TeamProvisioningTranscriptClaudeLogsCache,
  type TranscriptClaudeLogsContextResolver,
} from '../TeamProvisioningTranscriptClaudeLogs';

import type { TeamConfig } from '@shared/types';

describe('TeamProvisioningTranscriptClaudeLogs', () => {
  let tempDir: string | null = null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-claude-logs-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  function makeResolver(
    getProjectDir: () => string,
    getLeadSessionId: () => string | undefined | null = () => 'session-1'
  ): TranscriptClaudeLogsContextResolver {
    return {
      getContext: vi.fn(async () => ({
        projectDir: getProjectDir(),
        config: { leadSessionId: getLeadSessionId() } as TeamConfig,
      })),
    };
  }

  it('reads transcript lines with CR trimming, blank-line skipping, and retained bounds', async () => {
    const transcriptPath = path.join(tempDir!, 'session-1.jsonl');
    const inputLines = [
      'old-line',
      ...Array.from({ length: PROGRESS_RETAINED_LOG_LINES + 2 }, (_, index) => `line-${index}`),
      '',
      '   ',
      'preserve surrounding spaces  ',
    ];
    await fs.writeFile(transcriptPath, `${inputLines.join('\r\r\n')}\r\r\n`, 'utf8');

    const lines = await readTranscriptClaudeLogLines(transcriptPath);

    expect(lines).toHaveLength(PROGRESS_RETAINED_LOG_LINES);
    expect(lines[0]).toBe('line-3');
    expect(lines.at(-1)).toBe('preserve surrounding spaces  ');
    expect(lines).not.toContain('');
    expect(lines).not.toContain('   ');
    expect(lines.some((line) => line.endsWith('\r'))).toBe(false);
  });

  it('returns cached transcript logs while the transcript signature is unchanged', async () => {
    const transcriptPath = path.join(tempDir!, 'session-1.jsonl');
    await fs.writeFile(transcriptPath, 'first\n', 'utf8');
    const readLogLines = vi.fn(async () => ['cached-read']);
    const cache = new TeamProvisioningTranscriptClaudeLogsCache(
      makeResolver(() => tempDir!),
      readLogLines
    );

    const first = await cache.get('team-a');
    const second = await cache.get('team-a');

    expect(first).toEqual(second);
    expect(first?.lines).toEqual(['cached-read']);
    expect(readLogLines).toHaveBeenCalledTimes(1);
  });

  it('misses the cache when transcript size changes', async () => {
    const transcriptPath = path.join(tempDir!, 'session-1.jsonl');
    await fs.writeFile(transcriptPath, 'first\n', 'utf8');
    const readLogLines = vi.fn(async () => [`read-${readLogLines.mock.calls.length}`]);
    const cache = new TeamProvisioningTranscriptClaudeLogsCache(
      makeResolver(() => tempDir!),
      readLogLines
    );

    const first = await cache.get('team-a');
    await fs.appendFile(transcriptPath, 'second\n', 'utf8');
    const second = await cache.get('team-a');

    expect(first?.lines).toEqual(['read-1']);
    expect(second?.lines).toEqual(['read-2']);
    expect(readLogLines).toHaveBeenCalledTimes(2);
  });

  it('invalidates cached logs when context or transcript contents no longer resolve', async () => {
    const transcriptPath = path.join(tempDir!, 'session-1.jsonl');
    await fs.writeFile(transcriptPath, 'first\n', 'utf8');
    let leadSessionId: string | undefined | null = 'session-1';
    const readLogLines = vi.fn(async () => [`read-${readLogLines.mock.calls.length}`]);
    const cache = new TeamProvisioningTranscriptClaudeLogsCache(
      makeResolver(
        () => tempDir!,
        () => leadSessionId
      ),
      readLogLines
    );

    expect((await cache.get('team-a'))?.lines).toEqual(['read-1']);
    leadSessionId = '';
    await expect(cache.get('team-a')).resolves.toBeNull();

    leadSessionId = 'session-1';
    expect((await cache.get('team-a'))?.lines).toEqual(['read-2']);

    readLogLines.mockResolvedValueOnce([]);
    await fs.appendFile(transcriptPath, 'second\n', 'utf8');
    await expect(cache.get('team-a')).resolves.toBeNull();

    readLogLines.mockResolvedValueOnce(['read-after-empty']);
    await fs.appendFile(transcriptPath, 'third\n', 'utf8');
    expect((await cache.get('team-a'))?.lines).toEqual(['read-after-empty']);
  });
});
