import {
  fingerprintDurableTeamMembersMetaRaw,
  TeamMembersMetaStore,
} from '@main/services/team/TeamMembersMetaStore';
import { TeamRosterAuthorizationLedger } from '@main/services/team/TeamRosterAuthorizationLedger';
import { TeamRosterAuthorizationTransactionService } from '@main/services/team/TeamRosterAuthorizationTransactionService';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('roster admission publication recovery', () => {
  let sandbox = '';
  const teamName = 'publication-recovery-team';
  const transactionId = '11111111-1111-4111-8111-111111111111';

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'roster-admission-publication-'));
    setClaudeBasePathOverride(sandbox);
    await fs.mkdir(path.join(sandbox, 'teams', teamName), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setClaudeBasePathOverride(null);
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it('recovers an exact crash after the pending record write without publishing admission', async () => {
    const store = new TeamMembersMetaStore();
    const ledger = new TeamRosterAuthorizationLedger(() => 60_000);
    const originalWriteRecord = TeamRosterAuthorizationLedger.prototype.writeRecord;
    const writeRecord = vi
      .spyOn(TeamRosterAuthorizationLedger.prototype, 'writeRecord')
      .mockImplementationOnce(async function (this: TeamRosterAuthorizationLedger, record) {
        await originalWriteRecord.call(this, record);
        throw Object.assign(new Error('crash-after-record-write'), { code: 'EIO' });
      });
    const transactions = new TeamRosterAuthorizationTransactionService(store);

    await expect(
      transactions.begin(
        teamName,
        transactionId,
        'request-a',
        async () => store.serializeMembers([{ name: 'alice' }]),
        'exact-admission'
      )
    ).rejects.toThrow('crash-after-record-write');
    await expect(ledger.readRecord(teamName, transactionId)).resolves.toMatchObject({
      status: 'pending',
    });
    await expect(ledger.readAdmissionIndex(teamName)).resolves.toEqual({
      version: 1,
      active: null,
    });
    await expect(store.getMembers(teamName)).resolves.toEqual([]);
    await expect(
      transactions.validateLaunchAdmission(teamName, transactionId, 'exact-admission')
    ).resolves.toBe(false);

    writeRecord.mockRestore();
    await transactions.recoverTeam(teamName);
    await transactions.recoverTeam(teamName);
    await expect(ledger.readRecord(teamName, transactionId)).resolves.toMatchObject({
      status: 'rolled-back',
    });
  });

  it('recovers an exact crash after index publication and cleans up a duplicate retry', async () => {
    const store = new TeamMembersMetaStore();
    const ledger = new TeamRosterAuthorizationLedger(() => 60_000);
    await ledger.writeAdmissionIndex({ version: 1, active: null }, teamName);
    const originalWriteIndex = TeamRosterAuthorizationLedger.prototype.writeAdmissionIndex;
    const writeIndex = vi
      .spyOn(TeamRosterAuthorizationLedger.prototype, 'writeAdmissionIndex')
      .mockImplementationOnce(async function (
        this: TeamRosterAuthorizationLedger,
        index,
        nextTeamName
      ) {
        await originalWriteIndex.call(this, index, nextTeamName);
        throw Object.assign(new Error('crash-after-index-publish'), { code: 'EIO' });
      });
    const transactions = new TeamRosterAuthorizationTransactionService(store);
    const begin = () =>
      transactions.begin(
        teamName,
        transactionId,
        'request-a',
        async () => store.serializeMembers([{ name: 'alice' }]),
        'exact-admission'
      );

    await expect(begin()).rejects.toThrow('crash-after-index-publish');
    await expect(ledger.readRecord(teamName, transactionId)).resolves.toMatchObject({
      status: 'pending',
    });
    await expect(ledger.readAdmissionIndex(teamName)).resolves.toMatchObject({
      active: { transactionId, admissionRequestFingerprint: 'exact-admission' },
    });
    await expect(store.getMembers(teamName)).resolves.toEqual([]);

    writeIndex.mockRestore();
    await expect(begin()).resolves.toMatchObject({ transactionId, status: 'rolled-back' });
    await expect(ledger.readAdmissionIndex(teamName)).resolves.toEqual({
      version: 1,
      active: null,
    });
    await expect(
      transactions.validateLaunchAdmission(teamName, transactionId, 'exact-admission')
    ).resolves.toBe(false);
  });

  it('repairs a dangling admission index so normal roster mutation remains available', async () => {
    const store = new TeamMembersMetaStore();
    const ledger = new TeamRosterAuthorizationLedger(() => 60_000);
    await ledger.writeAdmissionIndex(
      {
        version: 1,
        active: { transactionId, requestFingerprint: 'missing-request' },
      },
      teamName
    );

    await store.writeMembers(teamName, [{ name: 'alice' }]);
    await expect(store.getMembers(teamName)).resolves.toEqual([
      expect.objectContaining({ name: 'alice' }),
    ]);
    await expect(ledger.readAdmissionIndex(teamName)).resolves.toEqual({
      version: 1,
      active: null,
    });
    const transactions = new TeamRosterAuthorizationTransactionService(store);
    await transactions.recoverTeam(teamName);
    await transactions.recoverTeam(teamName);
  });

  it('repairs an admission index targeting a terminal record before normal mutation', async () => {
    const store = new TeamMembersMetaStore();
    const ledger = new TeamRosterAuthorizationLedger(() => 60_000);
    const now = new Date().toISOString();
    await ledger.writeRecord({
      version: 2,
      transactionId,
      teamName,
      requestFingerprint: 'terminal-request',
      status: 'rolled-back',
      priorSnapshotFingerprint: fingerprintDurableTeamMembersMetaRaw(null),
      targetFingerprint: 'unused-target',
      createdAt: now,
      deadlineAt: now,
      updatedAt: now,
    });
    await ledger.writeAdmissionIndex(
      {
        version: 1,
        active: { transactionId, requestFingerprint: 'terminal-request' },
      },
      teamName
    );

    await store.writeMembers(teamName, [{ name: 'alice' }]);
    await expect(ledger.readAdmissionIndex(teamName)).resolves.toEqual({
      version: 1,
      active: null,
    });
    await expect(ledger.readRecord(teamName, transactionId)).resolves.toMatchObject({
      status: 'rolled-back',
    });
  });
});
