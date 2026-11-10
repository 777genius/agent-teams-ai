import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTeamProvisioningBootstrapTranscriptOutcomePorts } from '../TeamProvisioningBootstrapTranscriptOutcomePortsFactory';

const NOW = '2026-01-01T00:00:00.000Z';

function transcriptLine(input: { timestamp: string; agentName?: string; text: string }): string {
  return `${JSON.stringify({
    timestamp: input.timestamp,
    ...(input.agentName ? { agentName: input.agentName } : {}),
    text: input.text,
  })}\n`;
}

describe('TeamProvisioningBootstrapTranscriptOutcomePortsFactory', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('wires transcript outcome lookup through service dependencies and caches persisted reads', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T12:00:00.000Z'));
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-transcript-outcome-ports-'));
    const transcriptPath = path.join(tmpDir, 'member.jsonl');
    await fs.writeFile(
      transcriptPath,
      transcriptLine({
        timestamp: '2026-05-24T09:25:42.904Z',
        agentName: 'alice',
        text: 'member briefing for alice on team "demo-team" (demo-team). Ready.',
      }),
      'utf8'
    );
    const findMemberLogs = vi.fn(async () => [{ filePath: transcriptPath }]);
    const readConfigSnapshot = vi.fn(async () => null);
    const readMetaMembers = vi.fn(async () => []);
    const isLookupCacheEnabled = vi.fn(() => true);
    const ports = createTeamProvisioningBootstrapTranscriptOutcomePorts({
      nowIso: () => NOW,
      isLookupCacheEnabled,
      findMemberLogs,
      readConfigSnapshot,
      readMetaMembers,
    });

    const firstOutcome = await ports.findBootstrapTranscriptOutcome('demo-team', 'alice', 123);
    vi.setSystemTime(new Date('2026-05-03T12:00:06.000Z'));
    const secondOutcome = await ports.findBootstrapTranscriptOutcome('demo-team', 'alice', 123);

    expect(secondOutcome).toEqual(firstOutcome);
    expect(firstOutcome).toEqual({
      kind: 'success',
      observedAt: '2026-05-24T09:25:42.904Z',
      source: 'member_briefing',
    });
    expect(isLookupCacheEnabled).toHaveBeenCalledWith('demo-team');
    expect(findMemberLogs).toHaveBeenCalledTimes(1);
    expect(readConfigSnapshot).toHaveBeenCalledTimes(1);
    expect(readMetaMembers).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-05-03T12:00:11.000Z'));
    await ports.findBootstrapTranscriptOutcome('demo-team', 'alice', 123);

    expect(findMemberLogs).toHaveBeenCalledTimes(2);
    expect(readConfigSnapshot).toHaveBeenCalledTimes(2);
    expect(readMetaMembers).toHaveBeenCalledTimes(2);
  });

  it('does not use the persisted lookup cache when the service disables it', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-transcript-outcome-active-'));
    const transcriptPath = path.join(tmpDir, 'member.jsonl');
    await fs.writeFile(
      transcriptPath,
      transcriptLine({
        timestamp: '2026-05-24T09:25:42.904Z',
        agentName: 'alice',
        text: 'member briefing for alice on team "demo-team" (demo-team). Ready.',
      }),
      'utf8'
    );
    const findMemberLogs = vi.fn(async () => [{ filePath: transcriptPath }]);
    const ports = createTeamProvisioningBootstrapTranscriptOutcomePorts({
      nowIso: () => NOW,
      isLookupCacheEnabled: () => false,
      findMemberLogs,
      readConfigSnapshot: vi.fn(async () => null),
      readMetaMembers: vi.fn(async () => []),
    });

    await ports.findBootstrapTranscriptOutcome('demo-team', 'alice', 123);
    await ports.findBootstrapTranscriptOutcome('demo-team', 'alice', 123);

    expect(findMemberLogs).toHaveBeenCalledTimes(2);
  });

  it('exposes the failure-reason port while preserving outcome parsing behavior', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-transcript-outcome-failure-'));
    const transcriptPath = path.join(tmpDir, 'member.jsonl');
    await fs.writeFile(
      transcriptPath,
      transcriptLine({
        timestamp: '2026-05-24T09:25:42.904Z',
        agentName: 'alice',
        text: 'bootstrap failed: model not found during teammate startup',
      }),
      'utf8'
    );
    const ports = createTeamProvisioningBootstrapTranscriptOutcomePorts({
      nowIso: () => NOW,
      isLookupCacheEnabled: () => false,
      findMemberLogs: vi.fn(async () => [{ filePath: transcriptPath }]),
      readConfigSnapshot: vi.fn(async () => null),
      readMetaMembers: vi.fn(async () => []),
    });

    await expect(
      ports.findBootstrapTranscriptFailureReason('demo-team', 'alice', 123)
    ).resolves.toBe('bootstrap failed: model not found during teammate startup');
  });
});
