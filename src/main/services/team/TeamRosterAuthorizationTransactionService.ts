import { stableJsonStringify } from '@features/application-command-ledger';
import { syncDirectoryDurably } from '@main/utils/atomicWrite';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createHash } from 'crypto';
import * as path from 'path';

import { BoundedRosterTeamRecovery } from './BoundedRosterTeamRecovery';
import { pruneRosterLedgerWithinBudget } from './pruneRosterLedgerWithinBudget';
import {
  reconcileExactRosterAdmissionUnderLock,
  reconcileRosterAdmissionIndexUnderLock,
  rejectCompetingRosterReservationsUnderLock,
  reserveRosterAdmissionIndexUnderLock,
} from './reconcileRosterAuthorizationAdmissions';
import { recoverAllRosterAuthorizationTeams } from './recoverRosterAuthorizationTeams';
import { buildTerminalRosterAuthorizationRecord } from './rosterAuthorizationOutcome';
import { toRosterAuthorizationOutcome as toOutcome } from './rosterAuthorizationOutcome';
import {
  hasExactPreparedLaunchBinding,
  toPreparedLaunchBindingConflict,
  toRosterAuthorizationPrepareOutcome,
} from './rosterAuthorizationPreparedBinding';
import {
  decodeAuthorizedRoster,
  decodePriorRosterSnapshot,
  validateRosterAuthorizedLaunchResult,
} from './rosterAuthorizationRecordValidation';
import { RosterAuthorizationRecoveryScheduler } from './RosterAuthorizationRecoveryScheduler';
import {
  fingerprintDurableTeamMembersMetaRaw,
  RosterCompareAndSwapConflictError,
  TeamMembersMetaStore,
} from './TeamMembersMetaStore';
import {
  type DurableLaunchCommandRecord,
  type DurableRosterAuthorizationStatus,
  type RosterAuthorizationTransactionRecord,
  TeamRosterAuthorizationLedger,
} from './TeamRosterAuthorizationLedger';
import { validateRosterLaunchAdmission } from './validateRosterLaunchAdmission';

import type { RosterAuthorizationPrepareOutcome } from './rosterAuthorizationPreparedBinding';
import type { RosterAuthorizationTransactionServiceOptions } from './rosterAuthorizationTransactionOptions';
import type {
  RosterAuthorizationTransactionOutcome,
  RosterAuthorizedLaunchResult,
} from '@shared/types/rosterAuthorizationTransaction';

type DurableStatus = DurableRosterAuthorizationStatus;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL = new Set<DurableStatus>(['committed', 'rolled-back', 'conflict']);
const PRE_DISPATCH = new Set<DurableStatus>(['pending', 'applied', 'prepared']);
const DEFAULT_RESERVATION_LEASE_MS = 30_000;
const UNKNOWN_RECONCILE_INTERVAL_MS = 5_000;

export class TeamRosterAuthorizationTransactionService {
  private readonly ledger: TeamRosterAuthorizationLedger;
  private readonly recoveryScheduler: RosterAuthorizationRecoveryScheduler;
  private readonly boundedRecovery = new BoundedRosterTeamRecovery();

  constructor(
    private readonly membersMetaStore: TeamMembersMetaStore = new TeamMembersMetaStore(),
    private readonly options: RosterAuthorizationTransactionServiceOptions = {}
  ) {
    this.ledger = new TeamRosterAuthorizationLedger(() => this.reservationLeaseMs);
    this.recoveryScheduler = new RosterAuthorizationRecoveryScheduler(
      (teamName) => this.recoverTeam(teamName),
      () => this.nowMs(),
      this.options.unknownReconcileIntervalMs ?? UNKNOWN_RECONCILE_INTERVAL_MS
    );
  }
  async begin(
    teamName: string,
    transactionId: string,
    requestFingerprint: string,
    computeTargetRawUnderLock: (priorRaw: string | null) => Promise<string>,
    admissionRequestFingerprint?: string
  ): Promise<RosterAuthorizationTransactionOutcome> {
    this.assertTransactionId(transactionId);
    return this.membersMetaStore.withRosterLock(teamName, async () => {
      const admitted = admissionRequestFingerprint
        ? await reconcileExactRosterAdmissionUnderLock(
            this.ledger,
            teamName,
            admissionRequestFingerprint,
            (record) => this.resolveRecordUnderLock(teamName, record)
          )
        : null;
      if (admitted) return admitted;
      const existing = await this.ledger.readRecord(teamName, transactionId);
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          return toOutcome(transactionId, 'conflict', existing, 'Transaction ID was reused');
        }
        return this.resolveRecordOutcomeUnderLock(teamName, existing);
      }

      await rejectCompetingRosterReservationsUnderLock(this.ledger, teamName, transactionId);
      if (!(await pruneRosterLedgerWithinBudget(this.ledger, teamName, this.nowMs))) {
        this.recoveryScheduler.scheduleTeam(teamName);
      }
      const prior = await this.membersMetaStore.readDurableSnapshotUnderLock(teamName);
      const targetRaw = await computeTargetRawUnderLock(prior.raw);
      const targetFingerprint = fingerprintDurableTeamMembersMetaRaw(targetRaw);
      const pending: RosterAuthorizationTransactionRecord = {
        version: 2,
        transactionId,
        teamName,
        requestFingerprint,
        ...(admissionRequestFingerprint ? { admissionRequestFingerprint } : {}),
        status: 'pending',
        priorSnapshotFingerprint: prior.fingerprint,
        targetFingerprint,
        priorRawBase64:
          prior.raw === null ? null : Buffer.from(prior.raw, 'utf8').toString('base64'),
        targetRawBase64: Buffer.from(targetRaw, 'utf8').toString('base64'),
        createdAt: this.nowIso(),
        deadlineAt: new Date(this.nowMs() + this.reservationLeaseMs).toISOString(),
        updatedAt: this.nowIso(),
      };
      await this.ledger.writeRecord(pending);
      await reserveRosterAdmissionIndexUnderLock(this.ledger, teamName, pending);
      try {
        await this.membersMetaStore.writeDurableRawCasUnderLock(
          teamName,
          targetRaw,
          prior.fingerprint,
          transactionId
        );
      } catch (error) {
        if (!(error instanceof RosterCompareAndSwapConflictError)) throw error;
        const conflict = await this.persistConflict(
          { ...pending, currentFingerprint: error.currentFingerprint },
          'Roster changed during transaction compare-and-swap'
        );
        return toOutcome(transactionId, 'conflict', conflict);
      }
      const current = await this.membersMetaStore.readDurableSnapshotUnderLock(teamName);
      if (current.fingerprint !== targetFingerprint) {
        throw new Error('Applied roster fingerprint does not match the durable target');
      }
      const applied = this.transition(pending, 'applied');
      await this.ledger.writeRecord(applied);
      this.scheduleRecovery(applied);
      return toOutcome(
        transactionId,
        'applied',
        applied,
        undefined,
        decodeAuthorizedRoster(applied)
      );
    });
  }
  async getOutcome(
    teamName: string,
    transactionId: string
  ): Promise<RosterAuthorizationTransactionOutcome> {
    if (!UUID_PATTERN.test(transactionId)) return toOutcome(transactionId, 'unknown');
    try {
      return await this.membersMetaStore.withRosterLock(teamName, async () => {
        const record = await this.ledger.readRecord(teamName, transactionId);
        return record
          ? this.resolveRecordOutcomeUnderLock(teamName, record)
          : toOutcome(transactionId, 'not-started');
      });
    } catch {
      return toOutcome(transactionId, 'unknown', undefined, 'Transaction outcome is unreadable');
    }
  }
  async validateLaunchAdmission(team: string, id: string, fingerprint: string): Promise<boolean> {
    if (!UUID_PATTERN.test(id)) return false;
    return validateRosterLaunchAdmission({
      teamName: team,
      transactionId: id,
      launchRequestFingerprint: fingerprint,
      withLock: (operation) => this.membersMetaStore.withRosterLock(team, operation),
      readAdmittedRecord: (name) => reconcileRosterAdmissionIndexUnderLock(this.ledger, name),
    });
  }
  async recoverTeam(teamName: string): Promise<void> {
    try {
      await this.recoverTeamOnce(teamName);
    } catch (error) {
      this.recoveryScheduler.scheduleTeam(teamName);
      throw error;
    }
  }
  private async recoverTeamOnce(teamName: string): Promise<void> {
    await this.membersMetaStore.withRosterLock(teamName, () =>
      reconcileRosterAdmissionIndexUnderLock(this.ledger, teamName)
    );
    await this.boundedRecovery.run({
      teamName,
      now: () => this.nowMs(),
      withLock: (operation) => this.membersMetaStore.withRosterLock(teamName, operation),
      listPage: (cursor, limit) => this.ledger.listRecordIdsPage(teamName, cursor, limit),
      process: async (id) => {
        const record = await this.ledger.readRecord(teamName, id);
        if (!record || TERMINAL.has(record.status)) return;
        const resolved = await this.resolveRecordUnderLock(teamName, record);
        if (!TERMINAL.has(resolved.status)) this.scheduleRecovery(resolved);
      },
      prune: (limit, shouldYield) => this.ledger.prune(teamName, limit, shouldYield),
      schedule: () => this.recoveryScheduler.scheduleTeam(teamName),
    });
  }
  async recoverAllTeams(): Promise<void> {
    return recoverAllRosterAuthorizationTeams({
      teamsBasePath: getTeamsBasePath(),
      recoverTeam: (teamName) => this.recoverTeam(teamName),
      scheduleTeamRetry: (teamName) => this.recoveryScheduler.scheduleTeam(teamName),
      scheduleStartupScanRetry: () =>
        this.recoveryScheduler.scheduleStartupScan(() => this.recoverAllTeams()),
    });
  }
  async prepare(
    teamName: string,
    transactionId: string,
    launchCommandId: string = transactionId,
    executionProof?: import('@shared/types').AuthoritativeModelExecutionProof,
    launchRequestFingerprint?: string
  ): Promise<RosterAuthorizationPrepareOutcome> {
    this.assertTransactionId(transactionId);
    this.assertTransactionId(launchCommandId);
    return this.membersMetaStore.withRosterLock(teamName, async () => {
      const record = await this.ledger.readRecord(teamName, transactionId);
      if (!record) return toOutcome(transactionId, 'not-started');
      const requestedBinding = { launchCommandId, executionProof, launchRequestFingerprint };
      if (record.launchCommandId && !hasExactPreparedLaunchBinding(record, requestedBinding)) {
        return toPreparedLaunchBindingConflict(record);
      }
      const resolved = await this.resolveRecordUnderLock(teamName, record);
      if (resolved.status === 'prepared') {
        if (!hasExactPreparedLaunchBinding(resolved, requestedBinding)) {
          return toPreparedLaunchBindingConflict(resolved);
        }
        return toRosterAuthorizationPrepareOutcome(resolved, decodeAuthorizedRoster(resolved));
      }
      if (resolved.status !== 'applied') return toOutcome(transactionId, resolved.status, resolved);
      const prepared = {
        ...this.transition(resolved, 'prepared'),
        launchCommandId,
        ...(executionProof !== undefined ? { executionProof } : {}),
        ...(launchRequestFingerprint !== undefined ? { launchRequestFingerprint } : {}),
      };
      await this.ledger.writeRecord(prepared);
      return toRosterAuthorizationPrepareOutcome(prepared, decodeAuthorizedRoster(prepared));
    });
  }
  async recordLaunchResult(
    teamName: string,
    transactionId: string,
    result: RosterAuthorizedLaunchResult
  ): Promise<RosterAuthorizationTransactionOutcome> {
    this.assertTransactionId(transactionId);
    return this.membersMetaStore.withRosterLock(teamName, async () => {
      const record = await this.ledger.readRecord(teamName, transactionId);
      if (!record) return toOutcome(transactionId, 'not-started');
      const bindingError = validateRosterAuthorizedLaunchResult(record, result);
      if (bindingError) {
        if (TERMINAL.has(record.status)) {
          return toOutcome(transactionId, 'conflict', record, bindingError);
        }
        return this.persistLaunchUnknown(record, bindingError);
      }
      if (TERMINAL.has(record.status)) return toOutcome(transactionId, record.status, record);
      if (record.status !== 'prepared' && record.status !== 'launch-unknown') {
        return toOutcome(transactionId, record.status, record);
      }
      const command = await this.ledger.readLaunchCommand(teamName, result.launchCommandId);
      if (
        !command ||
        (command.state !== 'dispatched' && command.state !== 'unknown') ||
        command.transactionId !== transactionId ||
        command.rosterFingerprint !== record.targetFingerprint ||
        command.rosterRevision !== record.requestFingerprint ||
        (record.launchRequestFingerprint !== undefined &&
          command.launchRequestFingerprint !== record.launchRequestFingerprint)
      ) {
        return this.persistLaunchUnknown(record, 'Durable launch command dispatch is missing');
      }
      if (record.executionProof) {
        const evidence = await this.options.reconcileUnknownLaunch?.(record, command);
        const evidenceMatches =
          (result.launchStatus === 'started' &&
            evidence?.state === 'started' &&
            evidence.result.runId === result.runId &&
            evidence.result.attemptId === result.attemptId) ||
          result.launchStatus === 'not_started';
        if (!evidenceMatches) {
          await this.ledger.writeLaunchCommand({
            ...command,
            state: 'unknown',
            result,
            message: 'Callback response awaits production-owned process/bootstrap evidence',
            updatedAt: this.nowIso(),
          });
          return this.persistLaunchUnknown(
            record,
            'Callback response cannot commit without production-owned process/bootstrap evidence'
          );
        }
      }
      await this.ledger.writeLaunchCommand({
        ...command,
        state:
          result.launchStatus === 'started'
            ? 'succeeded'
            : result.launchStatus === 'not_started'
              ? 'not-started'
              : 'unknown',
        result,
        updatedAt: new Date().toISOString(),
      });
      if (result.launchStatus === 'not_started') {
        return this.rollbackUnderLock(teamName, record, 'Launch proved that no member started');
      }
      if (result.launchStatus !== 'started') {
        return this.persistLaunchUnknown(
          { ...record, launchRunId: result.runId },
          `Existing launch was not proven idempotent for roster ${record.targetFingerprint}`
        );
      }
      return this.commitUnderLock(teamName, { ...record, launchRunId: result.runId });
    });
  }
  async prepareLaunchInvocationIntent(
    teamName: string,
    transactionId: string
  ): Promise<RosterAuthorizationTransactionOutcome> {
    this.assertTransactionId(transactionId);
    return this.membersMetaStore.withRosterLock(teamName, async () => {
      const record = await this.ledger.readRecord(teamName, transactionId);
      if (!record) return toOutcome(transactionId, 'not-started');
      if (record.status === 'launch-unknown') {
        const resolved = await this.resolveRecordUnderLock(teamName, record);
        return toOutcome(transactionId, resolved.status, resolved);
      }
      const resolved = await this.resolveRecordUnderLock(teamName, record);
      if (resolved.status !== 'prepared') {
        return toOutcome(transactionId, resolved.status, resolved);
      }
      const command: DurableLaunchCommandRecord = {
        version: 1,
        transactionId,
        teamName,
        rosterFingerprint: resolved.targetFingerprint,
        rosterRevision: resolved.requestFingerprint,
        launchRequestFingerprint: resolved.launchRequestFingerprint,
        launchCommandId: resolved.launchCommandId ?? transactionId,
        state: 'prepared',
        updatedAt: new Date().toISOString(),
      };
      await this.ledger.writeLaunchCommand(command);
      this.scheduleRecovery(resolved);
      return toOutcome(
        transactionId,
        'prepared',
        resolved,
        'Launch invocation intent is durable; production execution has not yet been observed',
        decodeAuthorizedRoster(resolved)
      );
    });
  }
  async recordKnownLaunchFailure(
    teamName: string,
    transactionId: string,
    message: string
  ): Promise<RosterAuthorizationTransactionOutcome> {
    this.assertTransactionId(transactionId);
    return this.membersMetaStore.withRosterLock(teamName, async () => {
      const record = await this.ledger.readRecord(teamName, transactionId);
      if (!record) return toOutcome(transactionId, 'not-started');
      if (record.status !== 'prepared' && record.status !== 'launch-unknown') {
        return toOutcome(transactionId, record.status, record);
      }
      if (record.launchCommandId) {
        const command = await this.ledger.readLaunchCommand(teamName, record.launchCommandId);
        if (command) {
          if (record.executionProof && this.options.reconcileUnknownLaunch) {
            const evidence = await this.options.reconcileUnknownLaunch(record, command);
            if (
              evidence.state === 'started' &&
              !validateRosterAuthorizedLaunchResult(record, evidence.result)
            ) {
              await this.ledger.writeLaunchCommand({
                ...command,
                state: 'succeeded',
                result: evidence.result,
                updatedAt: this.nowIso(),
              });
              return this.commitUnderLock(teamName, {
                ...record,
                launchRunId: evidence.result.runId,
              });
            }
          }
          await this.ledger.writeLaunchCommand({
            ...command,
            state: 'not-started',
            message,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      return this.rollbackUnderLock(teamName, record, message);
    });
  }

  async recordLaunchDispatched(
    teamName: string,
    transactionId: string
  ): Promise<RosterAuthorizationTransactionOutcome> {
    this.assertTransactionId(transactionId);
    return this.membersMetaStore.withRosterLock(teamName, async () => {
      const record = await this.ledger.readRecord(teamName, transactionId);
      if (!record) return toOutcome(transactionId, 'not-started');
      const resolved = await this.resolveRecordUnderLock(teamName, record);
      if (resolved.status !== 'prepared')
        return toOutcome(transactionId, resolved.status, resolved);
      const commandId = resolved.launchCommandId ?? transactionId;
      const command = await this.ledger.readLaunchCommand(teamName, commandId);
      if (!command || command.state !== 'prepared')
        return this.persistLaunchUnknown(resolved, 'Durable launch invocation intent is missing');
      await this.ledger.writeLaunchCommand({
        ...command,
        state: 'dispatched',
        updatedAt: this.nowIso(),
      });
      const unknown = {
        ...this.transition(resolved, 'launch-unknown'),
        message: 'Production launch invocation was durably dispatched',
      };
      await this.ledger.writeRecord(unknown);
      this.scheduleRecovery(unknown);
      return toOutcome(transactionId, 'launch-unknown', unknown);
    });
  }

  async recordUnknownLaunchTransport(
    teamName: string,
    transactionId: string,
    message: string
  ): Promise<RosterAuthorizationTransactionOutcome> {
    this.assertTransactionId(transactionId);
    return this.membersMetaStore.withRosterLock(teamName, async () => {
      const record = await this.ledger.readRecord(teamName, transactionId);
      if (!record) return toOutcome(transactionId, 'not-started');
      if (record.status !== 'prepared' && record.status !== 'launch-unknown') {
        return toOutcome(transactionId, record.status, record);
      }
      if (record.launchCommandId) {
        const command = await this.ledger.readLaunchCommand(teamName, record.launchCommandId);
        if (command) {
          await this.ledger.writeLaunchCommand({
            ...command,
            state: 'unknown',
            message,
            updatedAt: this.nowIso(),
          });
        }
      }
      return this.persistLaunchUnknown(record, message);
    });
  }

  async commit(
    teamName: string,
    transactionId: string
  ): Promise<RosterAuthorizationTransactionOutcome> {
    this.assertTransactionId(transactionId);
    return this.membersMetaStore.withRosterLock(teamName, async () => {
      const record = await this.ledger.readRecord(teamName, transactionId);
      if (!record) return toOutcome(transactionId, 'not-started');
      if (record.status === 'committed') return toOutcome(transactionId, 'committed', record);
      if (record.status === 'applied' || record.status === 'prepared') {
        return toOutcome(
          transactionId,
          'conflict',
          record,
          'A typed transaction-bound launch result is required to commit the roster'
        );
      }
      return toOutcome(transactionId, record.status, record);
    });
  }

  async rollback(
    teamName: string,
    transactionId: string
  ): Promise<RosterAuthorizationTransactionOutcome> {
    this.assertTransactionId(transactionId);
    return this.membersMetaStore.withRosterLock(teamName, async () => {
      const record = await this.ledger.readRecord(teamName, transactionId);
      if (!record) return toOutcome(transactionId, 'not-started');
      if (record.status === 'rolled-back') return toOutcome(transactionId, 'rolled-back', record);
      if (record.status !== 'applied' && record.status !== 'prepared') {
        return toOutcome(transactionId, record.status, record);
      }
      return this.rollbackUnderLock(teamName, record);
    });
  }
  static requestFingerprint(value: unknown): string {
    return createHash('sha256').update(stableJsonStringify(value)).digest('hex');
  }
  private async resolveRecordOutcomeUnderLock(
    teamName: string,
    record: RosterAuthorizationTransactionRecord
  ): Promise<RosterAuthorizationTransactionOutcome> {
    const resolved = await this.resolveRecordUnderLock(teamName, record);
    return toOutcome(
      resolved.transactionId,
      resolved.status,
      resolved,
      undefined,
      TERMINAL.has(resolved.status) ? undefined : decodeAuthorizedRoster(resolved)
    );
  }

  private async resolveRecordUnderLock(
    teamName: string,
    record: RosterAuthorizationTransactionRecord
  ): Promise<RosterAuthorizationTransactionRecord> {
    if (TERMINAL.has(record.status)) return record;
    const current = await this.membersMetaStore.readDurableSnapshotUnderLock(teamName);
    if (
      record.targetRawBase64 === undefined &&
      current.raw !== null &&
      current.fingerprint === record.targetFingerprint
    ) {
      record = {
        ...record,
        targetRawBase64: Buffer.from(current.raw, 'utf8').toString('base64'),
        updatedAt: new Date().toISOString(),
      };
      await this.ledger.writeRecord(record);
    }
    const preparedCommand = record.launchCommandId
      ? await this.ledger.readLaunchCommand(teamName, record.launchCommandId)
      : null;
    if (preparedCommand?.state === 'prepared' && this.options.reconcileUnknownLaunch) {
      const evidence = await this.options.reconcileUnknownLaunch(record, preparedCommand);
      if (evidence.state === 'not-started') {
        await this.ledger.writeLaunchCommand({
          ...preparedCommand,
          state: 'not-started',
          message: evidence.message,
          updatedAt: this.nowIso(),
        });
        await this.rollbackUnderLock(teamName, record, evidence.message);
        return (await this.ledger.readRecord(teamName, record.transactionId)) ?? record;
      }
    }
    if (preparedCommand?.state === 'succeeded' && preparedCommand.result) {
      const bindingError = validateRosterAuthorizedLaunchResult(record, preparedCommand.result);
      const commandBound =
        preparedCommand.transactionId === record.transactionId &&
        preparedCommand.rosterFingerprint === record.targetFingerprint &&
        preparedCommand.rosterRevision === record.requestFingerprint &&
        (record.launchRequestFingerprint === undefined ||
          preparedCommand.launchRequestFingerprint === record.launchRequestFingerprint);
      if (!bindingError && commandBound) {
        const outcome = await this.commitUnderLock(teamName, {
          ...record,
          launchRunId: preparedCommand.result.runId,
        });
        const committed = await this.ledger.readRecord(teamName, record.transactionId);
        if (outcome.status === 'committed' && committed) return committed;
      }
    }
    if (preparedCommand?.state === 'not-started') {
      await this.rollbackUnderLock(teamName, record, preparedCommand.message);
      return (await this.ledger.readRecord(teamName, record.transactionId)) ?? record;
    }
    if (
      (preparedCommand?.state === 'dispatched' || preparedCommand?.state === 'unknown') &&
      record.status === 'prepared'
    ) {
      const unknown = {
        ...this.transition(record, 'launch-unknown'),
        message: 'Recovered dispatched launch command without a terminal result',
      };
      await this.ledger.writeRecord(unknown);
      return unknown;
    }
    if (
      (preparedCommand?.state === 'dispatched' || preparedCommand?.state === 'unknown') &&
      record.status === 'launch-unknown' &&
      this.options.reconcileUnknownLaunch
    ) {
      const evidence = await this.options.reconcileUnknownLaunch(record, preparedCommand);
      if (evidence.state === 'not-started') {
        await this.ledger.writeLaunchCommand({
          ...preparedCommand,
          state: 'not-started',
          message: evidence.message,
          updatedAt: this.nowIso(),
        });
        await this.rollbackUnderLock(teamName, record, evidence.message);
        return (await this.ledger.readRecord(teamName, record.transactionId)) ?? record;
      }
      if (evidence.state === 'started') {
        const bindingError = validateRosterAuthorizedLaunchResult(record, evidence.result);
        if (!bindingError) {
          await this.ledger.writeLaunchCommand({
            ...preparedCommand,
            state: 'succeeded',
            result: evidence.result,
            updatedAt: this.nowIso(),
          });
          await this.commitUnderLock(teamName, {
            ...record,
            launchRunId: evidence.result.runId,
          });
          return (await this.ledger.readRecord(teamName, record.transactionId)) ?? record;
        }
      }
      if (
        evidence.state === 'unknown' &&
        this.isLeaseExpired(record) &&
        this.options.proveNoInvocationResources &&
        (await this.options.proveNoInvocationResources(record, preparedCommand))
      ) {
        const message = 'Dispatch lease expired with proof that no invocation resource existed';
        await this.ledger.writeLaunchCommand({
          ...preparedCommand,
          state: 'not-started',
          message,
          updatedAt: this.nowIso(),
        });
        await this.rollbackUnderLock(teamName, record, message);
        return (await this.ledger.readRecord(teamName, record.transactionId)) ?? record;
      }
    }
    if (PRE_DISPATCH.has(record.status) && this.isLeaseExpired(record)) {
      if (current.fingerprint === record.targetFingerprint) {
        await this.rollbackUnderLock(teamName, record, 'Roster authorization lease expired');
        return (await this.ledger.readRecord(teamName, record.transactionId)) ?? record;
      }
      if (current.fingerprint === record.priorSnapshotFingerprint) {
        const rolledBack = this.terminal(
          record,
          'rolled-back',
          'Roster authorization lease expired before durable apply'
        );
        await this.ledger.writeTerminalRecord(rolledBack);
        return rolledBack;
      }
      return this.persistConflict(
        { ...record, currentFingerprint: current.fingerprint },
        'Roster changed while an expired authorization lease was recovered'
      );
    }
    if (record.status === 'pending') {
      if (current.fingerprint === record.targetFingerprint) {
        await syncDirectoryDurably(path.join(getTeamsBasePath(), teamName));
        const applied = this.transition(record, 'applied');
        await this.ledger.writeRecord(applied);
        return applied;
      }
      if (current.fingerprint === record.priorSnapshotFingerprint) {
        const rolledBack = this.terminal(record, 'rolled-back', 'Roster target was not applied');
        await this.ledger.writeTerminalRecord(rolledBack);
        return rolledBack;
      }
      return this.persistConflict(
        { ...record, currentFingerprint: current.fingerprint },
        'Pending roster transaction found an unrelated durable roster'
      );
    }
    if (
      record.priorSnapshotFingerprint !== record.targetFingerprint &&
      current.fingerprint === record.priorSnapshotFingerprint
    ) {
      await syncDirectoryDurably(path.join(getTeamsBasePath(), teamName));
      const rolledBack = this.terminal(
        record,
        'rolled-back',
        'Recovered a durable roster rollback completed before its terminal journal transition'
      );
      await this.ledger.writeTerminalRecord(rolledBack);
      return rolledBack;
    }
    if (current.fingerprint !== record.targetFingerprint) {
      return this.persistConflict(
        { ...record, currentFingerprint: current.fingerprint },
        'Roster changed while reserved by the authorization transaction'
      );
    }
    return record;
  }

  private async commitUnderLock(
    teamName: string,
    record: RosterAuthorizationTransactionRecord
  ): Promise<RosterAuthorizationTransactionOutcome> {
    const current = await this.membersMetaStore.readDurableSnapshotUnderLock(teamName);
    if (current.fingerprint !== record.targetFingerprint) {
      const conflict = await this.persistConflict(
        { ...record, currentFingerprint: current.fingerprint },
        'Roster changed before transaction commit'
      );
      return toOutcome(record.transactionId, 'conflict', conflict);
    }
    const committed = this.terminal(record, 'committed');
    await this.ledger.writeTerminalRecord(committed);
    return toOutcome(record.transactionId, 'committed', committed);
  }

  private async rollbackUnderLock(
    teamName: string,
    record: RosterAuthorizationTransactionRecord,
    message?: string
  ): Promise<RosterAuthorizationTransactionOutcome> {
    const current = await this.membersMetaStore.readDurableSnapshotUnderLock(teamName);
    if (current.fingerprint !== record.targetFingerprint) {
      const conflict = await this.persistConflict(
        { ...record, currentFingerprint: current.fingerprint },
        'Roster changed before transaction rollback'
      );
      return toOutcome(record.transactionId, 'conflict', conflict);
    }
    const priorRaw = decodePriorRosterSnapshot(record);
    try {
      await this.membersMetaStore.restoreDurableSnapshotCasUnderLock(
        teamName,
        { raw: priorRaw, fingerprint: record.priorSnapshotFingerprint },
        record.targetFingerprint,
        record.transactionId
      );
    } catch (error) {
      if (!(error instanceof RosterCompareAndSwapConflictError)) throw error;
      const conflict = await this.persistConflict(
        { ...record, currentFingerprint: error.currentFingerprint },
        'Roster changed during rollback compare-and-swap'
      );
      return toOutcome(record.transactionId, 'conflict', conflict);
    }
    const restored = await this.membersMetaStore.readDurableSnapshotUnderLock(teamName);
    if (restored.fingerprint !== record.priorSnapshotFingerprint) {
      throw new Error('Exact roster snapshot restore could not be verified');
    }
    const rolledBack = this.terminal(record, 'rolled-back', message);
    await this.ledger.writeTerminalRecord(rolledBack);
    return toOutcome(record.transactionId, 'rolled-back', rolledBack);
  }

  private async persistLaunchUnknown(
    record: RosterAuthorizationTransactionRecord,
    message: string
  ): Promise<RosterAuthorizationTransactionOutcome> {
    const unknown = { ...this.transition(record, 'launch-unknown'), message };
    await this.ledger.writeRecord(unknown);
    this.scheduleRecovery(unknown);
    return toOutcome(record.transactionId, 'launch-unknown', unknown);
  }

  private async persistConflict(
    record: RosterAuthorizationTransactionRecord,
    message: string
  ): Promise<RosterAuthorizationTransactionRecord> {
    const conflict = this.terminal(record, 'conflict', message);
    await this.ledger.writeTerminalRecord(conflict);
    return conflict;
  }

  private transition(
    record: RosterAuthorizationTransactionRecord,
    status: DurableStatus
  ): RosterAuthorizationTransactionRecord {
    return { ...record, status, updatedAt: this.nowIso() };
  }

  private terminal(
    record: RosterAuthorizationTransactionRecord,
    status: Extract<DurableStatus, 'committed' | 'rolled-back' | 'conflict'>,
    message?: string
  ): RosterAuthorizationTransactionRecord {
    this.recoveryScheduler.cancel(record);
    return buildTerminalRosterAuthorizationRecord(record, status, this.nowIso(), message);
  }

  private get reservationLeaseMs(): number {
    return Math.max(1, this.options.reservationLeaseMs ?? DEFAULT_RESERVATION_LEASE_MS);
  }

  private readonly nowMs = (): number => this.options.now?.() ?? Date.now();
  private readonly nowIso = (): string => new Date(this.nowMs()).toISOString();
  private isLeaseExpired(record: RosterAuthorizationTransactionRecord): boolean {
    const deadline = Date.parse(record.deadlineAt);
    return !Number.isFinite(deadline) || deadline <= this.nowMs();
  }

  private scheduleRecovery = (record: RosterAuthorizationTransactionRecord): void =>
    this.recoveryScheduler.scheduleRecord(record);

  private assertTransactionId(transactionId: string): void {
    if (!UUID_PATTERN.test(transactionId)) throw new Error('Invalid roster transactionId');
  }
}
