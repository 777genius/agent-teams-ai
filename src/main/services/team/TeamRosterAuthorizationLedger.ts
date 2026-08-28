import { atomicWriteAsync, syncDirectoryDurably } from '@main/utils/atomicWrite';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import type {
  AuthoritativeModelExecutionProof,
  RosterAuthorizationTransactionStatus,
  RosterAuthorizedLaunchResult,
} from '@shared/types';

export type DurableRosterAuthorizationStatus = Exclude<
  RosterAuthorizationTransactionStatus,
  'not-started' | 'unknown'
>;

export interface RosterAuthorizationTransactionRecord {
  version: 2;
  transactionId: string;
  teamName: string;
  requestFingerprint: string;
  /** Exact proof-admitted production request, excluding its generated transaction ID. */
  admissionRequestFingerprint?: string;
  status: DurableRosterAuthorizationStatus;
  priorSnapshotFingerprint: string;
  targetFingerprint: string;
  priorRawBase64?: string | null;
  targetRawBase64?: string;
  launchCommandId?: string;
  launchRunId?: string;
  executionProof?: AuthoritativeModelExecutionProof;
  launchRequestFingerprint?: string;
  currentFingerprint?: string;
  message?: string;
  createdAt: string;
  deadlineAt: string;
  updatedAt: string;
}

export interface DurableLaunchCommandRecord {
  version: 1;
  transactionId: string;
  teamName: string;
  rosterFingerprint: string;
  rosterRevision: string;
  launchRequestFingerprint?: string;
  launchCommandId: string;
  /** `prepared` is durable intent, never evidence that a process was invoked. */
  state: 'prepared' | 'dispatched' | 'succeeded' | 'not-started' | 'unknown';
  result?: RosterAuthorizedLaunchResult;
  message?: string;
  updatedAt: string;
}

export interface RosterAuthorizationAdmissionIndex {
  version: 1;
  active: {
    transactionId: string;
    admissionRequestFingerprint?: string;
    requestFingerprint: string;
  } | null;
}

const MAX_ADMISSION_INDEX_BYTES = 16 * 1024;

const TERMINAL = new Set<DurableRosterAuthorizationStatus>([
  'committed',
  'rolled-back',
  'conflict',
]);

export class TeamRosterAuthorizationLedger {
  private readonly pruneScans = new Map<
    string,
    {
      cursor: string | null;
      terminals: Array<{ id: string; updatedAt: string; launchCommandId?: string }>;
      obsolete?: Array<{ id: string; updatedAt: string; launchCommandId?: string }>;
      deleteIndex: number;
    }
  >();
  private readonly orphanPruneScans = new Map<
    string,
    {
      cursor: string | null;
      terminals: Array<{ path: string; updatedAt: string }>;
      obsolete?: Array<{ path: string; updatedAt: string }>;
      deleteIndex: number;
    }
  >();
  constructor(private readonly reservationLeaseMs: () => number) {}

  getAdmissionIndexPath(teamName: string): string {
    return path.join(getTeamsBasePath(), teamName, '.roster-authorization-index.json');
  }

  async readAdmissionIndex(teamName: string): Promise<RosterAuthorizationAdmissionIndex | null> {
    const indexPath = this.getAdmissionIndexPath(teamName);
    let raw: string;
    try {
      const stat = await fs.promises.stat(indexPath);
      if (!stat.isFile() || stat.size > MAX_ADMISSION_INDEX_BYTES) {
        throw new Error('Roster authorization admission index is unreadable or oversized');
      }
      raw = await fs.promises.readFile(indexPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error('Roster authorization admission index is unreadable', { cause: error });
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Roster authorization admission index is invalid');
    }
    const index = value as Partial<RosterAuthorizationAdmissionIndex>;
    const active = index.active;
    if (
      index.version !== 1 ||
      (active !== null &&
        (!active ||
          typeof active.transactionId !== 'string' ||
          typeof active.requestFingerprint !== 'string' ||
          (active.admissionRequestFingerprint !== undefined &&
            typeof active.admissionRequestFingerprint !== 'string')))
    ) {
      throw new Error('Roster authorization admission index is invalid');
    }
    return index as RosterAuthorizationAdmissionIndex;
  }

  async writeAdmissionIndex(
    index: RosterAuthorizationAdmissionIndex,
    teamName: string
  ): Promise<void> {
    const indexPath = this.getAdmissionIndexPath(teamName);
    await this.ensureDirectoryHierarchyDurably(path.dirname(indexPath));
    await atomicWriteAsync(indexPath, JSON.stringify(index, null, 2), {
      durability: 'strict',
      syncDirectory: true,
    });
  }

  async clearAdmissionIndexIfMatches(teamName: string, transactionId: string): Promise<void> {
    const index = await this.readAdmissionIndex(teamName);
    if (index?.active?.transactionId !== transactionId) return;
    await this.writeAdmissionIndex({ version: 1, active: null }, teamName);
  }

  getRecordPath(teamName: string, transactionId: string): string {
    return path.join(
      getTeamsBasePath(),
      teamName,
      '.roster-authorization-transactions',
      `${transactionId}.json`
    );
  }

  async listRecordIds(teamName: string, limit = Number.POSITIVE_INFINITY): Promise<string[]> {
    const directory = path.dirname(
      this.getRecordPath(teamName, '00000000-0000-4000-8000-000000000000')
    );
    try {
      const ids: string[] = [];
      const handle = await fs.promises.opendir(directory);
      for await (const entry of handle) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        ids.push(entry.name.slice(0, -5));
        if (ids.length >= limit) break;
      }
      return ids;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async listRecordIdsPage(
    teamName: string,
    afterId: string | null,
    limit: number
  ): Promise<{ ids: string[]; nextCursor: string | null }> {
    const directory = path.dirname(
      this.getRecordPath(teamName, '00000000-0000-4000-8000-000000000000')
    );
    try {
      const allIds = (await fs.promises.readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name.slice(0, -5))
        .sort();
      // Keyset pagination remains deletion-safe when the prior cursor file was
      // pruned between passes; exact cursor presence is never required.
      const remaining = afterId === null ? allIds : allIds.filter((id) => id > afterId);
      const ids = remaining.slice(0, Math.max(1, limit));
      return {
        ids,
        nextCursor: remaining.length > ids.length ? (ids.at(-1) ?? null) : null,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ids: [], nextCursor: null };
      throw error;
    }
  }

  async readRecord(
    teamName: string,
    transactionId: string
  ): Promise<RosterAuthorizationTransactionRecord | null> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.getRecordPath(teamName, transactionId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const record = JSON.parse(raw) as RosterAuthorizationTransactionRecord;
    if (
      record.version !== 2 ||
      record.transactionId !== transactionId ||
      record.teamName !== teamName ||
      typeof record.requestFingerprint !== 'string' ||
      (record.admissionRequestFingerprint !== undefined &&
        typeof record.admissionRequestFingerprint !== 'string') ||
      typeof record.priorSnapshotFingerprint !== 'string' ||
      typeof record.targetFingerprint !== 'string' ||
      ![
        'pending',
        'applied',
        'prepared',
        'launch-unknown',
        'committed',
        'rolled-back',
        'conflict',
      ].includes(record.status)
    ) {
      throw new Error('Invalid roster authorization transaction record');
    }
    record.createdAt = typeof record.createdAt === 'string' ? record.createdAt : record.updatedAt;
    record.deadlineAt =
      typeof record.deadlineAt === 'string'
        ? record.deadlineAt
        : new Date(Date.parse(record.createdAt) + this.reservationLeaseMs()).toISOString();
    return record;
  }

  async writeRecord(record: RosterAuthorizationTransactionRecord): Promise<void> {
    const recordPath = this.getRecordPath(record.teamName, record.transactionId);
    await this.ensureDirectoryHierarchyDurably(path.dirname(recordPath));
    await atomicWriteAsync(recordPath, JSON.stringify(record, null, 2), {
      durability: 'strict',
      syncDirectory: true,
    });
  }

  async writeTerminalRecord(record: RosterAuthorizationTransactionRecord): Promise<void> {
    await this.writeRecord(record);
    await this.clearAdmissionIndexIfMatches(record.teamName, record.transactionId);
  }

  getLaunchCommandPath(teamName: string, launchCommandId: string): string {
    return path.join(
      getTeamsBasePath(),
      teamName,
      '.roster-launch-command-ledger',
      `${launchCommandId}.json`
    );
  }

  async readLaunchCommand(
    teamName: string,
    launchCommandId: string
  ): Promise<DurableLaunchCommandRecord | null> {
    try {
      const value = JSON.parse(
        await fs.promises.readFile(this.getLaunchCommandPath(teamName, launchCommandId), 'utf8')
      ) as DurableLaunchCommandRecord;
      if (
        value.version !== 1 ||
        value.teamName !== teamName ||
        value.launchCommandId !== launchCommandId ||
        typeof value.transactionId !== 'string' ||
        typeof value.rosterFingerprint !== 'string' ||
        value.rosterFingerprint.length === 0 ||
        typeof value.rosterRevision !== 'string' ||
        value.rosterRevision.length === 0 ||
        (value.launchRequestFingerprint !== undefined &&
          (typeof value.launchRequestFingerprint !== 'string' ||
            value.launchRequestFingerprint.length === 0)) ||
        typeof value.updatedAt !== 'string' ||
        !['prepared', 'dispatched', 'succeeded', 'not-started', 'unknown'].includes(value.state)
      ) {
        throw new Error('Invalid roster launch command ledger record');
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async writeLaunchCommand(record: DurableLaunchCommandRecord): Promise<void> {
    const commandPath = this.getLaunchCommandPath(record.teamName, record.launchCommandId);
    await this.ensureDirectoryHierarchyDurably(path.dirname(commandPath));
    await atomicWriteAsync(commandPath, JSON.stringify(record, null, 2), {
      durability: 'strict',
      syncDirectory: true,
    });
  }

  async prune(
    teamName: string,
    maxWork = Number.POSITIVE_INFINITY,
    shouldYield: () => boolean = () => false
  ): Promise<boolean> {
    const directory = path.dirname(
      this.getRecordPath(teamName, '00000000-0000-4000-8000-000000000000')
    );
    const scan = this.pruneScans.get(teamName) ?? {
      cursor: null,
      terminals: [],
      deleteIndex: 0,
    };
    let work = 0;
    if (!scan.obsolete) {
      const page = await this.listRecordIdsPage(teamName, scan.cursor, Math.max(1, maxWork));
      for (const id of page.ids) {
        if (work > 0 && shouldYield()) {
          this.pruneScans.set(teamName, scan);
          return false;
        }
        work += 1;
        scan.cursor = id;
        try {
          const record = await this.readRecord(teamName, id);
          if (record && TERMINAL.has(record.status)) {
            const command = record.launchCommandId
              ? await this.readLaunchCommand(teamName, record.launchCommandId)
              : null;
            // A transaction becoming conflict/terminal does not prove that an
            // independently dispatched command is terminal. Retain both until
            // the command has a durable succeeded/no-start outcome.
            if (
              record.launchCommandId &&
              ((command && command.state !== 'succeeded' && command.state !== 'not-started') ||
                (!command && record.status === 'conflict') ||
                (command && (await this.hasRetainedLaunchEvidence(teamName, command))))
            ) {
              continue;
            }
            scan.terminals.push({
              id,
              updatedAt: record.updatedAt,
              launchCommandId: record.launchCommandId,
            });
          }
        } catch {
          // Unreadable state is retained fail-closed.
        }
      }
      if (page.nextCursor) {
        this.pruneScans.set(teamName, scan);
        return false;
      }
      scan.obsolete = scan.terminals
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(64);
    }
    const obsolete = scan.obsolete;
    while (scan.deleteIndex < obsolete.length && work < maxWork && !shouldYield()) {
      const entry = obsolete[scan.deleteIndex++];
      work += 1;
      if (entry.launchCommandId) {
        const commandPath = this.getLaunchCommandPath(teamName, entry.launchCommandId);
        const removed = await fs.promises.unlink(commandPath).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
            return false;
          }
        );
        if (removed) await syncDirectoryDurably(path.dirname(commandPath));
      }
      await fs.promises
        .unlink(this.getRecordPath(teamName, entry.id))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
    }
    if (scan.deleteIndex < obsolete.length) {
      this.pruneScans.set(teamName, scan);
      return false;
    }
    if (obsolete.length > 0) await syncDirectoryDurably(directory);
    this.pruneScans.delete(teamName);
    return this.pruneOrphanTerminalCommands(teamName, maxWork - work, shouldYield);
  }

  private async pruneOrphanTerminalCommands(
    teamName: string,
    maxWork: number,
    shouldYield: () => boolean
  ): Promise<boolean> {
    if (maxWork <= 0) return false;
    const directory = path.dirname(
      this.getLaunchCommandPath(teamName, '00000000-0000-4000-8000-000000000000')
    );
    const scan = this.orphanPruneScans.get(teamName) ?? {
      cursor: null,
      terminals: [],
      deleteIndex: 0,
    };
    let work = 0;
    let names: string[];
    try {
      names = (await fs.promises.readdir(directory))
        .filter((name) => name.endsWith('.json') && (scan.cursor === null || name > scan.cursor))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.orphanPruneScans.delete(teamName);
        return true;
      }
      throw error;
    }
    if (!scan.obsolete) {
      for (const name of names.slice(0, maxWork)) {
        if (work > 0 && shouldYield()) {
          this.orphanPruneScans.set(teamName, scan);
          return false;
        }
        scan.cursor = name;
        work += 1;
        try {
          const command = await this.readLaunchCommand(teamName, name.slice(0, -5));
          if (!command || (command.state !== 'succeeded' && command.state !== 'not-started'))
            continue;
          if (
            !(await this.readRecord(teamName, command.transactionId)) &&
            !(await this.hasRetainedLaunchEvidence(teamName, command))
          ) {
            scan.terminals.push({ path: path.join(directory, name), updatedAt: command.updatedAt });
          }
        } catch {
          // Unknown, active, and unreadable commands are retained fail-closed.
        }
      }
      if (names.length > work) {
        this.orphanPruneScans.set(teamName, scan);
        return false;
      }
      scan.obsolete = scan.terminals
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(64);
    }
    const obsolete = scan.obsolete;
    while (scan.deleteIndex < obsolete.length && work < maxWork && !shouldYield()) {
      const entry = obsolete[scan.deleteIndex++];
      work += 1;
      await fs.promises.unlink(entry.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    if (scan.deleteIndex < obsolete.length) {
      this.orphanPruneScans.set(teamName, scan);
      return false;
    }
    if (obsolete.length > 0) await syncDirectoryDurably(directory);
    this.orphanPruneScans.delete(teamName);
    return true;
  }

  private async ensureDirectoryHierarchyDurably(directoryPath: string): Promise<void> {
    const missing: string[] = [];
    let cursor = path.resolve(directoryPath);
    while (true) {
      try {
        const stats = await fs.promises.stat(cursor);
        if (!stats.isDirectory())
          throw new Error(`Roster ledger parent is not a directory: ${cursor}`);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        missing.push(cursor);
        const parent = path.dirname(cursor);
        if (parent === cursor) throw error;
        cursor = parent;
      }
    }
    for (const directory of missing.reverse()) {
      try {
        await fs.promises.mkdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!(await fs.promises.stat(directory)).isDirectory()) throw error;
      }
      await syncDirectoryDurably(path.dirname(directory));
    }
  }

  private async hasRetainedLaunchEvidence(
    teamName: string,
    command: DurableLaunchCommandRecord
  ): Promise<boolean> {
    if (command.state === 'unknown' || command.state === 'dispatched') return true;
    const identities = [
      command.launchCommandId,
      command.result?.runId,
      command.result?.attemptId,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (identities.length === 0) return false;
    const teamDirectory = path.join(getTeamsBasePath(), teamName);
    // Only the current launch-state projection is live ownership evidence.
    // Bootstrap state/journals are historical and may intentionally outlive a
    // stopped run, so treating them as live would retain successful commands forever.
    for (const evidencePath of [path.join(teamDirectory, 'launch-state.json')]) {
      try {
        const raw = await fs.promises.readFile(evidencePath, 'utf8');
        if (identities.some((identity) => raw.includes(identity))) return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
      }
    }
    return false;
  }
}
