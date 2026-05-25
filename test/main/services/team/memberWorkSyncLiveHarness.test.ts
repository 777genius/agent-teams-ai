import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { encodePath } from '../../../../src/main/utils/pathDecoder';

import { throwIfClaudeTranscriptApiError } from './memberWorkSyncLiveHarness';

const tempDirs: string[] = [];

describe('memberWorkSyncLiveHarness', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('scopes Claude API error checks to the current project transcripts', async () => {
    const claudeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'member-work-sync-harness-'));
    tempDirs.push(claudeRoot);
    const projectPath = path.join(claudeRoot, 'project');
    await fs.mkdir(projectPath, { recursive: true });

    const projectTranscriptDir = path.join(
      claudeRoot,
      'projects',
      encodePath(await fs.realpath(projectPath))
    );
    const unrelatedTranscriptDir = path.join(
      claudeRoot,
      'projects',
      encodePath('/Users/example/other-project')
    );
    await fs.mkdir(projectTranscriptDir, { recursive: true });
    await fs.mkdir(unrelatedTranscriptDir, { recursive: true });
    await fs.writeFile(
      path.join(unrelatedTranscriptDir, 'unrelated.jsonl'),
      `${JSON.stringify(buildApiErrorRecord('wrong project'))}\n`,
      'utf8'
    );

    await expect(
      throwIfClaudeTranscriptApiError({
        claudeRoot,
        context: 'live check',
        projectPath,
      })
    ).resolves.toBeUndefined();

    await fs.writeFile(
      path.join(projectTranscriptDir, 'current.jsonl'),
      `${JSON.stringify(buildApiErrorRecord('right project'))}\n`,
      'utf8'
    );

    await expect(
      throwIfClaudeTranscriptApiError({
        claudeRoot,
        context: 'live check',
        projectPath,
      })
    ).rejects.toThrow(/right project/);
  });

  it('ignores stale Claude API errors before the live check start time', async () => {
    const claudeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'member-work-sync-harness-'));
    tempDirs.push(claudeRoot);
    const projectPath = path.join(claudeRoot, 'project');
    await fs.mkdir(projectPath, { recursive: true });

    const projectTranscriptDir = path.join(
      claudeRoot,
      'projects',
      encodePath(await fs.realpath(projectPath))
    );
    await fs.mkdir(projectTranscriptDir, { recursive: true });
    const sinceMs = Date.now();
    await fs.writeFile(
      path.join(projectTranscriptDir, 'current.jsonl'),
      `${JSON.stringify(buildApiErrorRecord('old error', sinceMs - 1_000))}\n`,
      'utf8'
    );

    await expect(
      throwIfClaudeTranscriptApiError({
        claudeRoot,
        context: 'live check',
        projectPath,
        sinceMs,
      })
    ).resolves.toBeUndefined();

    await fs.appendFile(
      path.join(projectTranscriptDir, 'current.jsonl'),
      `${JSON.stringify(buildApiErrorRecord('new error', sinceMs + 1_000))}\n`,
      'utf8'
    );

    await expect(
      throwIfClaudeTranscriptApiError({
        claudeRoot,
        context: 'live check',
        projectPath,
        sinceMs,
      })
    ).rejects.toThrow(/new error/);
  });
});

function buildApiErrorRecord(text: string, timestampMs = Date.now()): Record<string, unknown> {
  return {
    isApiErrorMessage: true,
    error: 'unknown',
    timestamp: new Date(timestampMs).toISOString(),
    message: {
      content: [{ type: 'text', text }],
    },
  };
}
