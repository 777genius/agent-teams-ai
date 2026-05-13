import { mkdtemp, readFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileMemberWorkSyncAuditJournal } from '@features/member-work-sync/main/infrastructure/FileMemberWorkSyncAuditJournal';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';

function journalPath(root: string): string {
  return join(root, 'team-a', 'members', 'bob', '.member-work-sync', 'journal.jsonl');
}

describe('FileMemberWorkSyncAuditJournal', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'member-work-sync-audit-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('appends per-member JSONL audit events in order', async () => {
    const journal = new FileMemberWorkSyncAuditJournal(new MemberWorkSyncStorePaths(root));

    await journal.append({
      timestamp: '2026-04-30T00:00:00.000Z',
      teamName: 'team-a',
      memberName: 'bob',
      event: 'reconcile_started',
      source: 'test',
    });
    await journal.append({
      timestamp: '2026-04-30T00:00:01.000Z',
      teamName: 'team-a',
      memberName: 'bob',
      event: 'status_written',
      source: 'test',
      agendaFingerprint: 'agenda:v1:abc',
      actionableCount: 1,
    });

    const lines = (await readFile(journalPath(root), 'utf8')).trim().split('\n');
    expect(lines.map((line) => JSON.parse(line).event)).toEqual([
      'reconcile_started',
      'status_written',
    ]);
    expect(JSON.parse(lines[1])).toMatchObject({
      schemaVersion: 1,
      teamName: 'team-a',
      memberName: 'bob',
      agendaFingerprint: 'agenda:v1:abc',
    });
  });

  it('accepts typed proof-missing recovery audit events', async () => {
    const journal = new FileMemberWorkSyncAuditJournal(new MemberWorkSyncStorePaths(root));

    await journal.append({
      timestamp: '2026-04-30T00:00:00.000Z',
      teamName: 'team-a',
      memberName: 'bob',
      event: 'proof_missing_recovery_scheduled',
      source: 'test',
      reason: 'protocol_proof_missing',
      metadata: {
        originalMessageId: 'message-1',
        intentKey: 'proof-missing:message-1',
      },
    });

    const [line] = (await readFile(journalPath(root), 'utf8')).trim().split('\n');
    expect(JSON.parse(line)).toMatchObject({
      event: 'proof_missing_recovery_scheduled',
      reason: 'protocol_proof_missing',
      metadata: {
        originalMessageId: 'message-1',
        intentKey: 'proof-missing:message-1',
      },
    });
  });

  it('truncates previews and rotates bounded journals', async () => {
    const journal = new FileMemberWorkSyncAuditJournal(
      new MemberWorkSyncStorePaths(root),
      undefined,
      { maxBytes: 200, rotatedFileCount: 2 }
    );

    for (let index = 0; index < 8; index += 1) {
      await journal.append({
        timestamp: `2026-04-30T00:00:0${index}.000Z`,
        teamName: 'team-a',
        memberName: 'bob',
        event: 'nudge_skipped',
        source: 'test',
        reason: 'r'.repeat(500),
        diagnostics: ['d'.repeat(500)],
        metadata: { long: 'm'.repeat(500), ['__proto__']: 'safe' },
        taskRefs: [{ taskId: 't'.repeat(500), displayId: 'x'.repeat(500) }],
        messagePreview: 'x'.repeat(500),
      });
    }

    const dirEntries = await readdir(join(root, 'team-a', 'members', 'bob', '.member-work-sync'));
    expect(dirEntries).toEqual(expect.arrayContaining(['journal.jsonl', 'journal.jsonl.1']));
    expect(dirEntries).not.toContain('journal.jsonl.3');

    const latestLine = (await readFile(journalPath(root), 'utf8')).trim().split('\n').at(-1);
    const latest = JSON.parse(latestLine ?? '{}');
    expect(latest.messagePreview).toHaveLength(243);
    expect(latest.reason).toHaveLength(243);
    expect(latest.diagnostics[0]).toHaveLength(243);
    expect(latest.metadata.long).toHaveLength(243);
    expect(latest.metadata.__proto__).toBe('safe');
    expect(latest.taskRefs[0].taskId).toHaveLength(243);
  });

  it('serializes concurrent appends for the same member journal', async () => {
    const journal = new FileMemberWorkSyncAuditJournal(new MemberWorkSyncStorePaths(root));
    const events = Array.from({ length: 80 }, (_, index) => ({
      timestamp: `2026-04-30T00:01:${String(index).padStart(2, '0')}.000Z`,
      teamName: 'team-a',
      memberName: 'bob',
      event: 'queue_coalesced' as const,
      source: 'test',
      reason: `event-${index}`,
    }));

    await Promise.all(events.map((event) => journal.append(event)));

    const lines = (await readFile(journalPath(root), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(events.length);
    expect(lines.map((line) => JSON.parse(line).reason)).toEqual(
      events.map((event) => event.reason)
    );
  });

  it('logs and swallows append failures', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const paths = new MemberWorkSyncStorePaths(root);
    vi.spyOn(paths, 'ensureMemberWorkSyncDir').mockRejectedValue(new Error('boom'));
    const journal = new FileMemberWorkSyncAuditJournal(paths, logger);

    await expect(
      journal.append({
        timestamp: '2026-04-30T00:00:00.000Z',
        teamName: 'team-a',
        memberName: 'bob',
        event: 'reconcile_started',
        source: 'test',
      })
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'member work sync audit journal append failed',
      expect.objectContaining({ error: 'Error: boom' })
    );
  });
});
