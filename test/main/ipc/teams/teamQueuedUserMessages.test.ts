import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  discardQueuedUserMessages,
  discardQueuedUserMessagesFromRows,
  isQueuedUserInboxRow,
  listQueuedUserMessages,
  listQueuedUserMessagesFromRows,
} from '../../../../src/main/ipc/teams/teamQueuedUserMessages';

const TEAM_NAME = 'fixteam';
const MEMBER = 'team-lead';

function queuedRow(messageId: string, text = 'queued text'): Record<string, unknown> {
  return {
    from: 'user',
    to: MEMBER,
    text,
    timestamp: '2026-08-20T10:00:00.000Z',
    read: false,
    messageId,
  };
}

function deliveredRow(messageId: string): Record<string, unknown> {
  return { ...queuedRow(messageId), read: true };
}

function agentRow(messageId: string): Record<string, unknown> {
  return { ...queuedRow(messageId), from: 'researcher' };
}

describe('isQueuedUserInboxRow', () => {
  it('matches only undelivered user rows', () => {
    expect(isQueuedUserInboxRow(queuedRow('m1'))).toBe(true);
    expect(isQueuedUserInboxRow(deliveredRow('m1'))).toBe(false);
    expect(isQueuedUserInboxRow(agentRow('m1'))).toBe(false);
    expect(isQueuedUserInboxRow(null)).toBe(false);
    expect(isQueuedUserInboxRow('user')).toBe(false);
    expect(isQueuedUserInboxRow({ from: 'user', read: 'false' })).toBe(false);
  });

  it('normalizes the from field before comparing', () => {
    expect(isQueuedUserInboxRow({ from: ' User ', read: false })).toBe(true);
  });
});

describe('listQueuedUserMessagesFromRows', () => {
  it('returns summaries for queued user rows only', () => {
    const rows = [queuedRow('m1'), deliveredRow('m2'), agentRow('m3'), queuedRow('m4')];
    const queued = listQueuedUserMessagesFromRows(rows);
    expect(queued.map((entry) => entry.messageId)).toEqual(['m1', 'm4']);
    expect(queued[0]).toMatchObject({ text: 'queued text', timestamp: '2026-08-20T10:00:00.000Z' });
  });

  it('derives a legacy id for rows without messageId', () => {
    const row = queuedRow('m1');
    delete row.messageId;
    const queued = listQueuedUserMessagesFromRows([row]);
    expect(queued).toHaveLength(1);
    expect(queued[0].messageId).toMatch(/^inbox-/);
  });
});

describe('discardQueuedUserMessagesFromRows', () => {
  it('discards the listed queued user rows and keeps everything else', () => {
    const rows = [queuedRow('m1'), deliveredRow('m2'), agentRow('m3'), queuedRow('m4')];
    const { kept, discarded } = discardQueuedUserMessagesFromRows(rows, ['m1', 'm4']);
    expect(discarded).toBe(2);
    expect(kept.map((row) => (row as { messageId: string }).messageId)).toEqual(['m2', 'm3']);
  });

  it('discards only the targeted queued message by messageId', () => {
    const rows = [queuedRow('m1'), queuedRow('m2')];
    const { kept, discarded } = discardQueuedUserMessagesFromRows(rows, ['m2']);
    expect(discarded).toBe(1);
    expect(kept.map((row) => (row as { messageId: string }).messageId)).toEqual(['m1']);
  });

  // The whole point of the id list: a row the confirmation never named is a row
  // the user never authorised, so it has to survive the rewrite.
  it('keeps a queued row that is not in the confirmed id list', () => {
    const rows = [queuedRow('m1'), queuedRow('late')];
    const { kept, discarded } = discardQueuedUserMessagesFromRows(rows, ['m1']);
    expect(discarded).toBe(1);
    expect(kept.map((row) => (row as { messageId: string }).messageId)).toEqual(['late']);
  });

  it('ignores ids that no longer match a queued row', () => {
    const rows = [queuedRow('m1')];
    const { kept, discarded } = discardQueuedUserMessagesFromRows(rows, ['gone', 'm1']);
    expect(discarded).toBe(1);
    expect(kept).toEqual([]);
    expect(discardQueuedUserMessagesFromRows(rows, ['gone'])).toEqual({ kept: rows, discarded: 0 });
  });

  it('discards nothing for an empty id list', () => {
    const rows = [queuedRow('m1'), queuedRow('m2')];
    expect(discardQueuedUserMessagesFromRows(rows, []).discarded).toBe(0);
  });

  it('never discards delivered or agent rows even for a matching messageId', () => {
    const rows = [deliveredRow('m1'), agentRow('m2')];
    expect(discardQueuedUserMessagesFromRows(rows, ['m1', 'm2']).discarded).toBe(0);
  });

  it('matches the derived id of a row that carries no messageId', () => {
    const row = queuedRow('m1');
    delete row.messageId;
    const derivedId = listQueuedUserMessagesFromRows([row])[0].messageId;
    expect(discardQueuedUserMessagesFromRows([row], [derivedId]).discarded).toBe(1);
  });
});

describe('inbox file operations', () => {
  let teamsBasePath: string;
  let inboxPath: string;

  beforeEach(() => {
    teamsBasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'queued-inbox-'));
    const inboxDir = path.join(teamsBasePath, TEAM_NAME, 'inboxes');
    fs.mkdirSync(inboxDir, { recursive: true });
    inboxPath = path.join(inboxDir, `${MEMBER}.json`);
  });

  afterEach(() => {
    fs.rmSync(teamsBasePath, { recursive: true, force: true });
  });

  it('lists queued user messages from the inbox file', async () => {
    fs.writeFileSync(
      inboxPath,
      JSON.stringify([queuedRow('m1'), deliveredRow('m2'), agentRow('m3')])
    );
    const queued = await listQueuedUserMessages(teamsBasePath, TEAM_NAME, MEMBER);
    expect(queued.map((entry) => entry.messageId)).toEqual(['m1']);
  });

  it('returns an empty list for a missing inbox file', async () => {
    await expect(listQueuedUserMessages(teamsBasePath, TEAM_NAME, MEMBER)).resolves.toEqual([]);
  });

  it('discards the confirmed queued messages and preserves the rest on disk', async () => {
    fs.writeFileSync(
      inboxPath,
      JSON.stringify([queuedRow('m1'), deliveredRow('m2'), agentRow('m3'), queuedRow('m4')])
    );
    const result = await discardQueuedUserMessages(teamsBasePath, TEAM_NAME, MEMBER, ['m1', 'm4']);
    expect(result).toEqual({ discarded: 2, remainingQueued: 0 });
    const written = JSON.parse(fs.readFileSync(inboxPath, 'utf8')) as { messageId: string }[];
    expect(written.map((row) => row.messageId)).toEqual(['m2', 'm3']);
  });

  it('discards a single queued message by messageId and reports remaining queued', async () => {
    fs.writeFileSync(inboxPath, JSON.stringify([queuedRow('m1'), queuedRow('m2')]));
    const result = await discardQueuedUserMessages(teamsBasePath, TEAM_NAME, MEMBER, ['m1']);
    expect(result).toEqual({ discarded: 1, remainingQueued: 1 });
    const written = JSON.parse(fs.readFileSync(inboxPath, 'utf8')) as { messageId: string }[];
    expect(written.map((row) => row.messageId)).toEqual(['m2']);
  });

  // The race the id list exists for: the user confirms two rows, a third lands
  // before the locked rewrite. It was never confirmed, so it stays on disk and
  // is reported back as still queued.
  it('leaves a row that arrived after the confirmed listing and reports it', async () => {
    fs.writeFileSync(
      inboxPath,
      JSON.stringify([queuedRow('m1'), queuedRow('m2'), queuedRow('late', 'sent while deciding')])
    );
    const result = await discardQueuedUserMessages(teamsBasePath, TEAM_NAME, MEMBER, ['m1', 'm2']);
    expect(result).toEqual({ discarded: 2, remainingQueued: 1 });
    const written = JSON.parse(fs.readFileSync(inboxPath, 'utf8')) as { messageId: string }[];
    expect(written.map((row) => row.messageId)).toEqual(['late']);
  });

  it('ignores an id the runtime already consumed without touching the other rows', async () => {
    fs.writeFileSync(inboxPath, JSON.stringify([queuedRow('m1')]));
    const before = fs.statSync(inboxPath).mtimeMs;
    const result = await discardQueuedUserMessages(teamsBasePath, TEAM_NAME, MEMBER, ['gone']);
    expect(result).toEqual({ discarded: 0, remainingQueued: 1 });
    expect(fs.statSync(inboxPath).mtimeMs).toBe(before);
  });

  it('does not rewrite the inbox file when nothing was discarded', async () => {
    fs.writeFileSync(inboxPath, JSON.stringify([deliveredRow('m1')]));
    const before = fs.statSync(inboxPath).mtimeMs;
    const result = await discardQueuedUserMessages(teamsBasePath, TEAM_NAME, MEMBER, ['m1']);
    expect(result).toEqual({ discarded: 0, remainingQueued: 0 });
    expect(fs.statSync(inboxPath).mtimeMs).toBe(before);
  });

  // The listing is what the discard confirmation counts, so an inbox that
  // cannot be read has to fail the same way the discard does. An empty list
  // would tell the user the queue is drained while the rows are still on disk.
  it('refuses to list or discard when the inbox file is not a JSON list', async () => {
    fs.writeFileSync(inboxPath, 'not json');
    await expect(listQueuedUserMessages(teamsBasePath, TEAM_NAME, MEMBER)).rejects.toThrow(
      'not a valid JSON message list'
    );
    await expect(
      discardQueuedUserMessages(teamsBasePath, TEAM_NAME, MEMBER, ['m1'])
    ).rejects.toThrow('not a valid JSON message list');
  });

  it('rejects traversal-style member names', async () => {
    await expect(
      discardQueuedUserMessages(teamsBasePath, TEAM_NAME, '../outside', ['m1'])
    ).rejects.toThrow('Invalid inbox path');
  });

  // Negative control for the "missing inbox is empty" case above: an inbox that
  // cannot exist is a different answer from an inbox that does not exist yet.
  // A rejected name must never resolve to an empty list, or a typo in the team
  // name would report "nothing queued" for a member whose queue is full.
  it('rejects an invalid team name instead of reporting an empty queue', async () => {
    await expect(listQueuedUserMessages(teamsBasePath, '../escape', MEMBER)).rejects.toThrow(
      'Invalid inbox path'
    );
    await expect(
      discardQueuedUserMessages(teamsBasePath, '../escape', MEMBER, ['m1'])
    ).rejects.toThrow('Invalid inbox path');
  });

  it('rejects traversal-style member names before listing', async () => {
    await expect(listQueuedUserMessages(teamsBasePath, TEAM_NAME, '../outside')).rejects.toThrow(
      'Invalid inbox path'
    );
  });
});
