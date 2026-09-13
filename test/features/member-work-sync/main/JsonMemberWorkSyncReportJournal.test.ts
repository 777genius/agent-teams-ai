import { JsonMemberWorkSyncStore, buildPendingReportIntentId } from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import { JsonMemberWorkSyncReportJournal } from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncReportJournal';
import * as atomicWrite from '@main/utils/atomicWrite';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberWorkSyncReportJournalInput } from '@features/member-work-sync/core/application/MemberWorkSyncReportJournalPort';

const input: MemberWorkSyncReportJournalInput = {
  teamName: 'sandbox-journal',
  memberName: 'tester',
  incarnation: 'inc-1',
  intentId: 'intent-1',
  requestDigest: 'digest-1',
  receivedAt: '2026-09-10T10:00:00.000Z',
  origin: 'online',
  request: {
    teamName: 'sandbox-journal',
    memberName: 'tester',
    state: 'still_working',
    agendaFingerprint: 'agenda-1',
  },
};
const receipt = {
  intentId: input.intentId,
  incarnation: input.incarnation,
  requestDigest: input.requestDigest,
  acceptedAt: input.receivedAt,
  appliedStatusRevision: {
    incarnation: input.incarnation,
    lineageId: 'lineage-1',
    sequence: 1,
    nonce: 'nonce-1',
  },
};

describe('strict JSON report journal', () => {
  let root: string;
  let paths: MemberWorkSyncStorePaths;
  let journal: JsonMemberWorkSyncReportJournal;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sandbox-report-journal-'));
    paths = new MemberWorkSyncStorePaths(root);
    journal = new JsonMemberWorkSyncStore(paths).createReportJournal();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
  it('binds once, preserves first timestamp, and rejects digest and request collisions', async () => {
    expect((await journal.read(input)).state).toBe('absent');
    expect((await journal.ensure(input)).state).toBe('present');
    const retry = await journal.ensure({
      ...input,
      receivedAt: '2026-09-11T10:00:00.000Z',
      origin: 'fallback',
    });
    expect(retry.state === 'present' && retry.intent.journal?.firstRecordedAt).toBe(
      input.receivedAt
    );
    expect((await journal.ensure({ ...input, requestDigest: 'other' })).state).toBe('conflict');
    expect(
      (await journal.ensure({ ...input, request: { ...input.request, note: 'changed' } })).state
    ).toBe('conflict');
  });
  it('requires a bound row and transfers exactly one immutable receipt', async () => {
    expect((await journal.transfer({ ...input, receipt })).state).toBe('absent');
    await journal.ensure(input);
    expect(await journal.transfer({ ...input, receipt })).toMatchObject({
      state: 'present',
      intent: { status: 'accepted', resultCode: 'accepted', processedAt: receipt.acceptedAt },
    });
    expect((await journal.transfer({ ...input, receipt })).state).toBe('present');
    expect(
      (
        await journal.transfer({
          ...input,
          receipt: { ...receipt, acceptedAt: '2026-09-10T11:00:00.000Z' },
        })
      ).state
    ).toBe('conflict');
  });
  it('never adopts legacy rows and preserves unrelated rows', async () => {
    await journal.ensure(input);
    const path = paths.getMemberReportsPath(input.teamName, input.memberName);
    const file = JSON.parse(await readFile(path, 'utf8'));
    const legacy = { ...file.intents[input.intentId] };
    delete legacy.journal;
    file.intents[input.intentId] = legacy;
    await writeFile(path, JSON.stringify(file));
    expect((await journal.ensure(input)).state).toBe('conflict');
    expect((await journal.ensure({ ...input, intentId: 'intent-2' })).state).toBe('present');
    expect(JSON.parse(await readFile(path, 'utf8')).intents[input.intentId]).toEqual(legacy);
  });
  it('reads canonical corruption without quarantine or index fallback', async () => {
    await journal.ensure(input);
    const path = paths.getMemberReportsPath(input.teamName, input.memberName);
    await writeFile(path, '{broken');
    expect((await journal.read(input)).state).toBe('corrupt');
    expect((await journal.ensure(input)).state).toBe('corrupt');
    expect(await readFile(path, 'utf8')).toBe('{broken');
  });
  it.each(['accepted_without_receipt', 'foreign_request_team', 'foreign_request_member'])('rejects malformed canonical row %s without rewriting bytes', async (kind) => {
    await journal.ensure(input);
    const path = paths.getMemberReportsPath(input.teamName, input.memberName);
    const file = JSON.parse(await readFile(path, 'utf8'));
    const row = file.intents[input.intentId];
    if (kind === 'accepted_without_receipt') row.status = 'accepted';
    else if (kind === 'foreign_request_team') row.request.teamName = 'foreign';
    else row.request.memberName = 'foreign';
    const bytes = JSON.stringify(file);
    await writeFile(path, bytes);
    expect((await journal.read(input)).state).toBe('corrupt');
    expect((await journal.ensure(input)).state).toBe('corrupt');
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });
  it('rejects a foreign self-consistent row elsewhere in the same file', async () => {
    await journal.ensure(input);
    const path = paths.getMemberReportsPath(input.teamName, input.memberName);
    const file = JSON.parse(await readFile(path, 'utf8'));
    const row = file.intents[input.intentId];
    row.teamName = 'foreign';
    row.request.teamName = 'foreign';
    const bytes = JSON.stringify(file);
    await writeFile(path, bytes);
    expect((await journal.ensure({ ...input, intentId: 'new-id' })).state).toBe('corrupt');
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });
  it('keeps confirmed writes despite failed projection', async () => {
    journal = new JsonMemberWorkSyncReportJournal(
      paths,
      async (_team, operation) => operation(),
      async () => {
        throw new Error('index failed');
      }
    );
    expect(await journal.ensure(input)).toMatchObject({
      state: 'present',
      projectionDegraded: true,
    });
    expect((await journal.read(input)).state).toBe('present');
  });
  it('repairs a failed projection on exact retry without rewriting the journal', async () => {
    const project = vi
      .fn()
      .mockRejectedValueOnce(new Error('index failed'))
      .mockResolvedValue(undefined);
    journal = new JsonMemberWorkSyncReportJournal(
      paths,
      async (_team, operation) => operation(),
      project
    );
    expect(await journal.ensure(input)).toMatchObject({
      state: 'present',
      projectionDegraded: true,
    });
    const write = vi.spyOn(atomicWrite, 'atomicWriteAsync');
    expect(await journal.ensure(input)).toMatchObject({
      state: 'present',
      projectionDegraded: false,
    });
    expect(write).not.toHaveBeenCalled();
    expect(project).toHaveBeenCalledTimes(2);
  });
  it('rejects a receipt left pending as corrupt', async () => {
    await journal.ensure(input);
    await journal.transfer({ ...input, receipt });
    const path = paths.getMemberReportsPath(input.teamName, input.memberName);
    const file = JSON.parse(await readFile(path, 'utf8'));
    file.intents[input.intentId].status = 'pending';
    await writeFile(path, JSON.stringify(file));
    expect((await journal.read(input)).state).toBe('corrupt');
  });
  it('distinguishes prepublication failure from unknown publication', async () => {
    const originalWrite = atomicWrite.atomicWriteAsync;
    const reportsPath = paths.getMemberReportsPath(input.teamName, input.memberName);
    let publicationStarted = false;
    vi.spyOn(atomicWrite, 'atomicWriteAsync').mockImplementation(async (path, data, options) => {
      if (path !== reportsPath) return originalWrite(path, data, options);
      if (publicationStarted) await options?.beforeCommit?.();
      throw new Error(publicationStarted ? 'sync failed' : 'write failed');
    });
    expect((await journal.ensure(input)).state).toBe('write_failed');
    publicationStarted = true;
    expect((await journal.ensure(input)).state).toBe('commit_unknown');
  });
  it('rejects a second member claiming the same intent ID without rewriting the owner', async () => {
    expect((await journal.ensure(input)).state).toBe('present');
    const ownerPath = paths.getMemberReportsPath(input.teamName, input.memberName);
    const ownerBytes = await readFile(ownerPath, 'utf8');
    const indexPath = paths.getPendingReportsIndexPath(input.teamName);
    const indexBytes = await readFile(indexPath, 'utf8');
    const other = {
      ...input,
      memberName: 'other',
      request: { ...input.request, memberName: 'other' },
    };
    expect((await journal.ensure(other)).state).toBe('conflict');
    expect((await journal.read(other)).state).toBe('conflict');
    expect(await readFile(ownerPath, 'utf8')).toBe(ownerBytes);
    expect(await readFile(indexPath, 'utf8')).toBe(indexBytes);
    expect(
      (
        await journal.ensure({
          ...other,
          teamName: 'other-team',
          request: { ...other.request, teamName: 'other-team' },
        })
      ).state
    ).toBe('present');
  });
  it('does not trust a missing or stale index when another member already owns the ID', async () => {
    expect((await journal.ensure(input)).state).toBe('present');
    const ownerPath = paths.getMemberReportsPath(input.teamName, input.memberName);
    const ownerBytes = await readFile(ownerPath, 'utf8');
    const indexPath = paths.getPendingReportsIndexPath(input.teamName);
    await rm(indexPath);
    const other = {
      ...input,
      memberName: 'other',
      request: { ...input.request, memberName: 'other' },
    };
    expect((await journal.ensure(other)).state).toBe('conflict');
    await writeFile(
      indexPath,
      `${JSON.stringify(
        {
          schemaVersion: 2,
          items: {
            [input.intentId]: {
              memberKey: paths.getMemberKey('other'),
              memberName: 'other',
              status: 'pending',
              recordedAt: input.receivedAt,
            },
          },
        },
        null,
        2
      )}\n`
    );
    expect((await journal.ensure(other)).state).toBe('conflict');
    expect(await readFile(ownerPath, 'utf8')).toBe(ownerBytes);
  });
  it('fails closed when a neighboring canonical reports file is corrupt or unreadable', async () => {
    expect((await journal.ensure(input)).state).toBe('present');
    const ownerPath = paths.getMemberReportsPath(input.teamName, input.memberName);
    const ownerBytes = await readFile(ownerPath, 'utf8');
    await paths.ensureMemberWorkSyncDir(input.teamName, 'other');
    const neighbor = paths.getMemberReportsPath(input.teamName, 'other');
    await mkdir(join(neighbor, '..'), { recursive: true });
    await writeFile(neighbor, '{broken');
    expect((await journal.ensure({ ...input, intentId: 'intent-2' })).state).toBe('corrupt');
    expect(await readFile(ownerPath, 'utf8')).toBe(ownerBytes);
    expect(await readFile(neighbor, 'utf8')).toBe('{broken');
  });
  it('serializes two store instances so only one member can create the same ID', async () => {
    const left = new JsonMemberWorkSyncStore(paths).createReportJournal();
    const right = new JsonMemberWorkSyncStore(paths).createReportJournal();
    const other = {
      ...input,
      memberName: 'other',
      request: { ...input.request, memberName: 'other' },
    };
    const [first, second] = await Promise.all([left.ensure(input), right.ensure(other)]);
    expect([first.state, second.state].sort()).toEqual(['conflict', 'present']);
    const winner = first.state === 'present' ? input.memberName : other.memberName;
    const loser = winner === input.memberName ? other.memberName : input.memberName;
    expect(
      JSON.parse(await readFile(paths.getMemberReportsPath(input.teamName, winner), 'utf8'))
        .intents[input.intentId].memberName
    ).toBe(winner);
    await expect(
      readFile(paths.getMemberReportsPath(input.teamName, loser), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('proves the same ID after a real post-rename ack failure without rewriting domain fields', async () => {
    const originalWrite = atomicWrite.atomicWriteAsync;
    const reportsPath = paths.getMemberReportsPath(input.teamName, input.memberName);
    vi.spyOn(atomicWrite, 'atomicWriteAsync').mockImplementation(async (path, data, options) => {
      await originalWrite(path, data, options);
      if (path === reportsPath) throw new Error('directory sync failed');
    });
    expect((await journal.ensure(input)).state).toBe('commit_unknown');
    const published = JSON.parse(await readFile(reportsPath, 'utf8'));
    expect(published.intents[input.intentId]).toMatchObject({
      id: input.intentId,
      recordedAt: input.receivedAt,
      memberName: input.memberName,
    });
    vi.restoreAllMocks();
    const write = vi.spyOn(atomicWrite, 'atomicWriteAsync');
    const journalBytes = await readFile(reportsPath, 'utf8');
    const proved = await journal.ensure({
      ...input,
      receivedAt: '2026-09-11T10:00:00.000Z',
      origin: 'fallback',
    });
    expect(proved).toMatchObject({
      state: 'present',
      projectionDegraded: false,
      intent: { recordedAt: input.receivedAt, journal: { firstRecordedAt: input.receivedAt } },
    });
    expect(write.mock.calls.every(([path]) => path !== reportsPath)).toBe(true);
    expect(await readFile(reportsPath, 'utf8')).toBe(journalBytes);
  });
  it('keeps commit_unknown when a later durability proof itself fails', async () => {
    const originalWrite = atomicWrite.atomicWriteAsync;
    const reportsPath = paths.getMemberReportsPath(input.teamName, input.memberName);
    vi.spyOn(atomicWrite, 'atomicWriteAsync').mockImplementation(async (path, data, options) => {
      await originalWrite(path, data, options);
      if (path === reportsPath) throw new Error('directory sync failed');
    });
    expect((await journal.ensure(input)).state).toBe('commit_unknown');
    vi.restoreAllMocks();
    vi.spyOn(atomicWrite, 'syncDirectoryDurably').mockRejectedValue(new Error('proof sync failed'));
    expect((await journal.ensure(input)).state).toBe('commit_unknown');
    expect(JSON.parse(await readFile(reportsPath, 'utf8')).intents[input.intentId].id).toBe(
      input.intentId
    );
  });
  it('legacy append cannot create an ID already owned by another member', async () => {
    const store = new JsonMemberWorkSyncStore(paths);
    journal = store.createReportJournal();
    const otherRequest = { ...input.request, memberName: 'other' };
    const stolenId = buildPendingReportIntentId(otherRequest);
    expect((await journal.ensure({ ...input, intentId: stolenId })).state).toBe('present');
    const ownerBytes = await readFile(
      paths.getMemberReportsPath(input.teamName, input.memberName),
      'utf8'
    );
    await expect(store.appendPendingReport(otherRequest, 'online')).rejects.toThrow(
      'Bound report intent requires strict journal API'
    );
    expect(
      await readFile(paths.getMemberReportsPath(input.teamName, input.memberName), 'utf8')
    ).toBe(ownerBytes);
  });
});
