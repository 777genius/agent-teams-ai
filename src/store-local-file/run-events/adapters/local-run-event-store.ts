import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  parseRunEvent,
  runEventProviderKindFromString,
  RunAccountCapacityStatus,
  RunEventCompactionSafetyMode,
  RunControlInboxStatus,
  RunLivenessStatus,
  RunOutcomeStatus,
  RunRuntimeIssueKind,
  RunSafetyConfidence,
  RunSafetyStatus,
  RunWorkspaceStatus,
} from "@vioxen/subscription-runtime/worker-core";
import {
  localRunEventLogDefaultLockAcquireTimeoutMs as defaultLockAcquireTimeoutMs,
  localRunEventLogDefaultLockPollMs as defaultLockPollMs,
  localRunEventLogDefaultLockTtlMs as defaultLockTtlMs,
} from "../domain/run-event-log-policy";
import type {
  RunEvent,
  RunEventAppendResult,
  RunEventCompactionPlan,
  RunEventCompactionPort,
  RunEventCompactionResult,
  RunEventCursor,
  RunEventDeliveryCursorRewrite,
  RunEventDeliveryCursorSnapshot,
  RunEventDeliveryCursorStorePort,
  RunEventProjectionState,
  RunEventProjectionStateStorePort,
  RunEventReadModels,
  RunEventReadRequest,
  RunEventReadResult,
  RunEventReadWarning,
  RunEventRetentionPolicy,
  RunEventStorePort,
} from "../ports/run-event-store-contracts";

export type LocalFileRunEventStoreOptions = {
  readonly rootDir: string;
  readonly eventLogPath?: string;
  readonly lockTtlMs?: number;
  readonly lockAcquireTimeoutMs?: number;
  readonly lockPollMs?: number;
};

export class LocalFileRunEventStore
  implements RunEventStorePort, RunEventCompactionPort
{
  constructor(private readonly options: LocalFileRunEventStoreOptions) {}

  async append(events: readonly RunEvent[]): Promise<RunEventAppendResult> {
    if (events.length === 0) {
      return {
        appendedCount: 0,
        skippedDuplicateCount: 0,
      };
    }
    return this.withEventLogLock(async () => {
      const path = this.eventLogPath();
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const existing = await this.readAllEventsForDedupe(path);
      const lines: string[] = [];
      let skippedDuplicateCount = 0;
      for (const event of events) {
        if (existing.has(event.eventId)) {
          skippedDuplicateCount += 1;
          continue;
        }
        existing.add(event.eventId);
        lines.push(JSON.stringify(event));
      }
      if (lines.length === 0) {
        return {
          appendedCount: 0,
          skippedDuplicateCount,
        };
      }
      const prefix = await this.needsSeparatorNewline(path) ? "\n" : "";
      await writeFile(path, `${prefix}${lines.join("\n")}\n`, {
        encoding: "utf8",
        flag: "a",
        mode: 0o600,
      });
      return {
        appendedCount: lines.length,
        skippedDuplicateCount,
      };
    });
  }

  async read(input: RunEventReadRequest = {}): Promise<RunEventReadResult> {
    const path = this.eventLogPath();
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return {
          events: [],
          warnings: [],
        };
      }
      throw error;
    }
    const startLine = parseCursor(input.cursor?.value);
    const lines = splitEventLogLines(contents);
    const events: RunEvent[] = [];
    const warnings: RunEventReadWarning[] = [];
    const typeFilter = input.types === undefined ? null : new Set(input.types);
    const runIdFilter = runEventRunIdFilter(input.runId, input.runIds);
    let nextLine = startLine;

    for (let index = startLine; index < lines.length; index += 1) {
      const line = lines[index];
      nextLine = index + 1;
      if (line === undefined || !line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        warnings.push({
          code: "invalid_event_json",
          message: "Skipped invalid run event JSON line.",
          lineNumber: index + 1,
        });
        continue;
      }
      const event = parseRunEvent(parsed);
      if (!event) {
        warnings.push({
          code: "invalid_event_shape",
          message: "Skipped run event with invalid schema.",
          lineNumber: index + 1,
        });
        continue;
      }
      if (!runIdFilter(event.runId)) continue;
      if (
        input.sourceProviderKind !== undefined &&
        event.source.providerKind !== input.sourceProviderKind
      ) continue;
      if (
        input.sourceRegistryRootDir !== undefined &&
        event.source.registryRootDir !== input.sourceRegistryRootDir
      ) continue;
      if (typeFilter && !typeFilter.has(event.type)) continue;
      events.push(event);
      if (input.limit !== undefined && events.length >= input.limit) {
        break;
      }
    }

    return {
      events,
      nextCursor: { value: String(nextLine) },
      warnings,
    };
  }

  async planCompaction(
    policy: RunEventRetentionPolicy = {},
  ): Promise<RunEventCompactionPlan> {
    return this.withEventLogLock(async () =>
      this.withDeliveryCursorLock(async () =>
        (await this.buildCompactionPlan(policy)).plan
      )
    );
  }

  async compact(
    policy: RunEventRetentionPolicy = {},
  ): Promise<RunEventCompactionResult> {
    return this.withEventLogLock(async () =>
      this.withDeliveryCursorLock(async () => {
        const planned = await this.buildCompactionPlan(policy);
        if (planned.plan.removableLineCount === 0) {
          return {
            ...planned.plan,
            compacted: false,
          };
        }
        const path = this.eventLogPath();
        const tempPath = join(dirname(path), `${randomUUID()}.compact.tmp`);
        try {
          await writeFile(
            tempPath,
            planned.retainedLines.length === 0
              ? ""
              : `${planned.retainedLines.join("\n")}\n`,
            { encoding: "utf8", mode: 0o600 },
          );
          await rename(tempPath, path);
          for (const rewrite of planned.plan.cursorRewrites) {
            await this.writeDeliveryCursorSnapshot({
              consumerId: rewrite.consumerId,
              cursor: rewrite.nextCursor,
            });
          }
          return {
            ...planned.plan,
            compacted: true,
          };
        } catch (error) {
          await rm(tempPath, { force: true });
          throw error;
        }
      })
    );
  }

  private eventLogPath(): string {
    return this.options.eventLogPath ??
      join(this.options.rootDir, "run-events", "events.ndjson");
  }

  private eventLogLockPath(): string {
    return `${this.eventLogPath()}.lock`;
  }

  private async withEventLogLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = this.eventLogLockPath();
    const startedAt = Date.now();
    await mkdir(dirname(this.eventLogPath()), { recursive: true, mode: 0o700 });
    while (true) {
      try {
        await mkdir(lockPath, { recursive: false, mode: 0o700 });
        break;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        if (await this.removeStaleLock(lockPath)) continue;
        if (Date.now() - startedAt > this.lockAcquireTimeoutMs()) {
          throw new Error("local_run_event_store_lock_timeout");
        }
        await sleep(this.lockPollMs());
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  private async removeStaleLock(lockPath: string): Promise<boolean> {
    let item;
    try {
      item = await stat(lockPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return true;
      throw error;
    }
    if (Date.now() - item.mtimeMs < this.lockTtlMs()) return false;
    await rm(lockPath, { recursive: true, force: true });
    return true;
  }

  private lockTtlMs(): number {
    return this.options.lockTtlMs ?? defaultLockTtlMs;
  }

  private lockAcquireTimeoutMs(): number {
    return this.options.lockAcquireTimeoutMs ?? defaultLockAcquireTimeoutMs;
  }

  private lockPollMs(): number {
    return this.options.lockPollMs ?? defaultLockPollMs;
  }

  private async readAllEventsForDedupe(path: string): Promise<Set<string>> {
    const seen = new Set<string>();
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return seen;
      throw error;
    }
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = parseRunEvent(JSON.parse(line));
        if (event) seen.add(event.eventId);
      } catch {
        continue;
      }
    }
    return seen;
  }

  private async needsSeparatorNewline(path: string): Promise<boolean> {
    try {
      const contents = await readFile(path, "utf8");
      return contents.length > 0 && !contents.endsWith("\n");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  private async buildCompactionPlan(
    policy: RunEventRetentionPolicy,
  ): Promise<{
    readonly plan: RunEventCompactionPlan;
    readonly retainedLines: readonly string[];
  }> {
    const safetyMode = policy.safetyMode ??
      RunEventCompactionSafetyMode.PreserveDeliveryCursors;
    const lines = await this.readEventLogLines();
    const records = lines.map((line, index) => eventLogLineRecord(line, index));
    const deliveryCursors = await this.readDeliveryCursorSnapshots();
    const cursorFloorLine = deliveryCursors.length === 0
      ? lines.length
      : Math.min(...deliveryCursors.map((cursor) => cursor.lineNumber));
    const latestRetainedLineIndexes = latestLineIndexesByRun(
      records,
      policy.keepLatestEventsPerRun,
    );
    const cutoffMs = policy.keepEventsAfter === undefined
      ? undefined
      : Date.parse(policy.keepEventsAfter);
    const removableIndexes = new Set<number>();
    let blockedByCursorLineCount = 0;

    for (const record of records) {
      const candidate = compactionCandidate({
        record,
        policy,
        ...(cutoffMs === undefined ? {} : { cutoffMs }),
        cursorFloorLine,
        latestRetainedLineIndexes,
      });
      if (!candidate) continue;
      if (
        safetyMode === RunEventCompactionSafetyMode.PreserveDeliveryCursors &&
        record.index >= cursorFloorLine
      ) {
        blockedByCursorLineCount += 1;
        continue;
      }
      removableIndexes.add(record.index);
    }

    const cursorRewrites = deliveryCursors.map((cursor) =>
      cursorRewriteForRemovedLines(cursor, removableIndexes)
    );
    const warnings = records
      .filter((record) => record.warning !== undefined)
      .map((record) => record.warning as RunEventReadWarning);
    return {
      plan: {
        schemaVersion: 1,
        safetyMode,
        totalLineCount: lines.length,
        validEventCount: records.filter((record) => record.event !== undefined).length,
        invalidLineCount: records.filter((record) => record.invalid).length,
        retainedLineCount: lines.length - removableIndexes.size,
        removableLineCount: removableIndexes.size,
        blockedByCursorLineCount,
        ...(deliveryCursors.length === 0 ? {} : { cursorFloorLine }),
        deliveryCursors,
        cursorRewrites,
        warnings,
      },
      retainedLines: lines.filter((_, index) => !removableIndexes.has(index)),
    };
  }

  private async readEventLogLines(): Promise<readonly string[]> {
    try {
      return splitEventLogLines(await readFile(this.eventLogPath(), "utf8"));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
  }

  private async readDeliveryCursorSnapshots(): Promise<
    readonly RunEventDeliveryCursorSnapshot[]
  > {
    const dir = deliveryCursorDir(this.options.rootDir);
    let entries: readonly string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
    const snapshots: RunEventDeliveryCursorSnapshot[] = [];
    for (const entry of entries) {
      const parsed = await readDeliveryCursorFile(join(dir, entry));
      if (parsed !== null) snapshots.push(parsed);
    }
    return snapshots.sort((left, right) =>
      left.consumerId.localeCompare(right.consumerId)
    );
  }

  private async writeDeliveryCursorSnapshot(input: {
    readonly consumerId: string;
    readonly cursor: RunEventCursor;
  }): Promise<void> {
    await writeDeliveryCursorFile(this.options.rootDir, input);
  }

  private async withDeliveryCursorLock<T>(fn: () => Promise<T>): Promise<T> {
    return withDirectoryLock({
      lockPath: deliveryCursorLockPath(this.options.rootDir),
      parentDir: this.options.rootDir,
      lockTtlMs: this.lockTtlMs(),
      lockAcquireTimeoutMs: this.lockAcquireTimeoutMs(),
      lockPollMs: this.lockPollMs(),
    }, fn);
  }
}

function runEventRunIdFilter(
  runId: string | undefined,
  runIds: readonly string[] | undefined,
): (value: string) => boolean {
  const runIdSet = runIds === undefined ? undefined : new Set(runIds);
  return (value) => {
    if (runId !== undefined && value !== runId) return false;
    if (runIdSet !== undefined && !runIdSet.has(value)) return false;
    return true;
  };
}

export class LocalFileRunEventProjectionStateStore
  implements RunEventProjectionStateStorePort
{
  constructor(private readonly options: LocalFileRunEventStoreOptions) {}

  async readProjectionState(
    runId: string,
  ): Promise<RunEventProjectionState | null> {
    const path = this.statePath(runId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      if (error instanceof SyntaxError) {
        await rm(path, { force: true });
        return null;
      }
      throw error;
    }
    const state = parseProjectionState(parsed);
    if (!state || state.runId !== runId) {
      await rm(path, { force: true });
      return null;
    }
    return state;
  }

  async writeProjectionState(state: RunEventProjectionState): Promise<void> {
    const path = this.statePath(state.runId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tempPath = join(dirname(path), `${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(tempPath, path);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  private statePath(runId: string): string {
    return join(
      this.options.rootDir,
      "run-event-projection-state",
      createHash("sha256").update(runId).digest("hex"),
    );
  }
}

export class LocalFileRunEventDeliveryCursorStore
  implements RunEventDeliveryCursorStorePort
{
  constructor(private readonly options: LocalFileRunEventStoreOptions) {}

  async readDeliveryCursor(consumerId: string): Promise<RunEventCursor | null> {
    return this.withDeliveryCursorLock(async () => {
      const snapshot = await readDeliveryCursorFile(this.cursorPath(consumerId));
      if (snapshot === null || snapshot.consumerId !== consumerId) return null;
      return snapshot.cursor;
    });
  }

  async writeDeliveryCursor(input: {
    readonly consumerId: string;
    readonly cursor: RunEventCursor;
  }): Promise<void> {
    await this.withDeliveryCursorLock(async () =>
      writeDeliveryCursorFile(this.options.rootDir, input)
    );
  }

  private cursorPath(consumerId: string): string {
    return deliveryCursorPath(this.options.rootDir, consumerId);
  }

  private async withDeliveryCursorLock<T>(fn: () => Promise<T>): Promise<T> {
    return withDirectoryLock({
      lockPath: deliveryCursorLockPath(this.options.rootDir),
      parentDir: this.options.rootDir,
      lockTtlMs: this.options.lockTtlMs ?? defaultLockTtlMs,
      lockAcquireTimeoutMs: this.options.lockAcquireTimeoutMs ??
        defaultLockAcquireTimeoutMs,
      lockPollMs: this.options.lockPollMs ?? defaultLockPollMs,
    }, fn);
  }
}

type EventLogLineRecord = {
  readonly index: number;
  readonly raw: string;
  readonly event?: RunEvent;
  readonly invalid: boolean;
  readonly warning?: RunEventReadWarning;
};

function eventLogLineRecord(line: string, index: number): EventLogLineRecord {
  if (!line.trim()) {
    return { index, raw: line, invalid: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {
      index,
      raw: line,
      invalid: true,
      warning: {
        code: "invalid_event_json",
        message: "Skipped invalid run event JSON line.",
        lineNumber: index + 1,
      },
    };
  }
  const event = parseRunEvent(parsed);
  if (!event) {
    return {
      index,
      raw: line,
      invalid: true,
      warning: {
        code: "invalid_event_shape",
        message: "Skipped run event with invalid schema.",
        lineNumber: index + 1,
      },
    };
  }
  return { index, raw: line, event, invalid: false };
}

function latestLineIndexesByRun(
  records: readonly EventLogLineRecord[],
  keepLatestEventsPerRun: number | undefined,
): ReadonlySet<number> {
  const retained = new Set<number>();
  if (keepLatestEventsPerRun === undefined) return retained;
  if (keepLatestEventsPerRun <= 0) return retained;
  const byRun = new Map<string, EventLogLineRecord[]>();
  for (const record of records) {
    if (!record.event) continue;
    const existing = byRun.get(record.event.runId) ?? [];
    existing.push(record);
    byRun.set(record.event.runId, existing);
  }
  for (const recordsForRun of byRun.values()) {
    for (const record of recordsForRun.slice(-keepLatestEventsPerRun)) {
      retained.add(record.index);
    }
  }
  return retained;
}

function compactionCandidate(input: {
  readonly record: EventLogLineRecord;
  readonly policy: RunEventRetentionPolicy;
  readonly cutoffMs?: number;
  readonly cursorFloorLine: number;
  readonly latestRetainedLineIndexes: ReadonlySet<number>;
}): boolean {
  if (input.latestRetainedLineIndexes.has(input.record.index)) return false;
  if (!input.record.event) {
    return input.record.invalid && input.policy.dropInvalidLines === true;
  }
  let candidate = false;
  if (input.cutoffMs !== undefined && Number.isFinite(input.cutoffMs)) {
    const eventTimeMs = Date.parse(
      input.record.event.observedAt || input.record.event.occurredAt,
    );
    if (Number.isFinite(eventTimeMs) && eventTimeMs < input.cutoffMs) {
      candidate = true;
    }
  }
  if (input.policy.keepLatestEventsPerRun !== undefined) {
    candidate = true;
  }
  if (
    input.policy.compactDeliveredEvents === true &&
    input.record.index < input.cursorFloorLine
  ) {
    candidate = true;
  }
  return candidate;
}

function cursorRewriteForRemovedLines(
  cursor: RunEventDeliveryCursorSnapshot,
  removedIndexes: ReadonlySet<number>,
): RunEventDeliveryCursorRewrite {
  let removedBeforeCursor = 0;
  let invalidatedUnreadEvents = false;
  for (const index of removedIndexes) {
    if (index < cursor.lineNumber) removedBeforeCursor += 1;
    if (index >= cursor.lineNumber) invalidatedUnreadEvents = true;
  }
  return {
    consumerId: cursor.consumerId,
    previousCursor: cursor.cursor,
    nextCursor: {
      value: String(Math.max(0, cursor.lineNumber - removedBeforeCursor)),
    },
    invalidatedUnreadEvents,
  };
}

function splitEventLogLines(contents: string): readonly string[] {
  if (!contents) return [];
  const normalized = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  return normalized ? normalized.split("\n") : [];
}

function deliveryCursorDir(rootDir: string): string {
  return join(rootDir, "run-event-delivery-cursors");
}

function deliveryCursorPath(rootDir: string, consumerId: string): string {
  return join(
    deliveryCursorDir(rootDir),
    createHash("sha256").update(consumerId).digest("hex"),
  );
}

function deliveryCursorLockPath(rootDir: string): string {
  return join(rootDir, "run-event-delivery-cursors.lock");
}

async function readDeliveryCursorFile(
  path: string,
): Promise<RunEventDeliveryCursorSnapshot | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (
      isNodeError(error) &&
      (error.code === "ENOENT" || error.code === "EISDIR")
    ) {
      return null;
    }
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.consumerId !== "string" ||
    typeof parsed.cursor !== "string"
  ) {
    return null;
  }
  const lineNumber = parseCursor(parsed.cursor);
  return {
    consumerId: parsed.consumerId,
    cursor: { value: parsed.cursor },
    lineNumber,
  };
}

async function writeDeliveryCursorFile(
  rootDir: string,
  input: {
    readonly consumerId: string;
    readonly cursor: RunEventCursor;
  },
): Promise<void> {
  if (!input.consumerId.trim()) {
    throw new Error("local_run_event_cursor_consumer_id_required");
  }
  const path = deliveryCursorPath(rootDir, input.consumerId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = join(dirname(path), `${randomUUID()}.tmp`);
  try {
    await writeFile(
      tempPath,
      `${JSON.stringify({
        schemaVersion: 1,
        consumerId: input.consumerId,
        cursor: input.cursor.value,
      }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function withDirectoryLock<T>(
  input: {
    readonly lockPath: string;
    readonly parentDir: string;
    readonly lockTtlMs: number;
    readonly lockAcquireTimeoutMs: number;
    readonly lockPollMs: number;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  await mkdir(input.parentDir, { recursive: true, mode: 0o700 });
  while (true) {
    try {
      await mkdir(input.lockPath, { recursive: false, mode: 0o700 });
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      if (await removeStaleDirectoryLock(input.lockPath, input.lockTtlMs)) {
        continue;
      }
      if (Date.now() - startedAt > input.lockAcquireTimeoutMs) {
        throw new Error("local_run_event_cursor_lock_timeout");
      }
      await sleep(input.lockPollMs);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(input.lockPath, { recursive: true, force: true });
  }
}

async function removeStaleDirectoryLock(
  lockPath: string,
  lockTtlMs: number,
): Promise<boolean> {
  let item;
  try {
    item = await stat(lockPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return true;
    throw error;
  }
  if (Date.now() - item.mtimeMs < lockTtlMs) return false;
  await rm(lockPath, { recursive: true, force: true });
  return true;
}

function parseCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function parseProjectionState(value: unknown): RunEventProjectionState | null {
  if (!isRecord(value)) return null;
  if (
    value.schemaVersion !== 1 ||
    typeof value.runId !== "string" ||
    typeof value.providerKind !== "string" ||
    typeof value.observedAt !== "string" ||
    typeof value.status !== "string" ||
    typeof value.liveness !== "string"
  ) {
    return null;
  }
  if (!optionalString(value.progressStatus)) return null;
  if (!optionalString(value.progressUpdatedAt)) return null;
  if (!optionalString(value.resultStatus)) return null;
  if (!optionalString(value.resultReason)) return null;
  if (!optionalString(value.resultUpdatedAt)) return null;
  if (!optionalNumber(value.logByteLength)) return null;
  if (!optionalString(value.workspaceSignature)) return null;
  if (!optionalString(value.capacitySignature)) return null;
  if (!optionalString(value.controlInboxSignature)) return null;
  if (!optionalString(value.decisionKind)) return null;
  if (!optionalString(value.decisionReason)) return null;
  const providerKind = runEventProviderKindFromString(value.providerKind);
  return {
    schemaVersion: 1,
    runId: value.runId,
    providerKind,
    observedAt: value.observedAt,
    status: value.status,
    liveness: value.liveness,
    ...(value.progressStatus === undefined
      ? {}
      : { progressStatus: value.progressStatus }),
    ...(value.progressUpdatedAt === undefined
      ? {}
      : { progressUpdatedAt: value.progressUpdatedAt }),
    ...(value.resultStatus === undefined ? {} : { resultStatus: value.resultStatus }),
    ...(value.resultReason === undefined ? {} : { resultReason: value.resultReason }),
    ...(value.resultUpdatedAt === undefined
      ? {}
      : { resultUpdatedAt: value.resultUpdatedAt }),
    ...(value.logByteLength === undefined
      ? {}
      : { logByteLength: value.logByteLength }),
    ...(value.workspaceSignature === undefined
      ? {}
      : { workspaceSignature: value.workspaceSignature }),
    ...(value.capacitySignature === undefined
      ? {}
      : { capacitySignature: value.capacitySignature }),
    ...(value.controlInboxSignature === undefined
      ? {}
      : { controlInboxSignature: value.controlInboxSignature }),
    ...(value.decisionKind === undefined ? {} : { decisionKind: value.decisionKind }),
    ...(value.decisionReason === undefined
      ? {}
      : { decisionReason: value.decisionReason }),
    readModels: parseReadModels(value.readModels) ?? unknownReadModels({
      runId: value.runId,
      providerKind,
      observedAt: value.observedAt,
      ...(value.decisionReason === undefined ? {} : { reason: value.decisionReason }),
    }),
  };
}

function parseReadModels(value: unknown): RunEventReadModels | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  if (
    typeof value.runId !== "string" ||
    typeof value.providerKind !== "string" ||
    typeof value.observedAt !== "string" ||
    !isRecord(value.safety) ||
    !isRecord(value.liveness) ||
    !isRecord(value.workspace) ||
    !isRecord(value.accountCapacity) ||
    !isRecord(value.outcome) ||
    !isRecord(value.controlInbox)
  ) {
    return null;
  }
  if (!Object.values(RunSafetyStatus).includes(value.safety.status as RunSafetyStatus)) {
    return null;
  }
  if (
    typeof value.safety.safeToContinue !== "boolean" ||
    typeof value.safety.reviewOnly !== "boolean" ||
    typeof value.safety.issueKind !== "string" ||
    !Object.values(RunRuntimeIssueKind).includes(
      value.safety.issueKind as RunRuntimeIssueKind,
    ) ||
    typeof value.safety.reason !== "string" ||
    typeof value.safety.confidence !== "string" ||
    !Object.values(RunSafetyConfidence).includes(
      value.safety.confidence as RunSafetyConfidence,
    ) ||
    !stringArray(value.safety.evidence)
  ) {
    return null;
  }
  if (!Object.values(RunLivenessStatus).includes(value.liveness.status as RunLivenessStatus)) {
    return null;
  }
  if (!Object.values(RunWorkspaceStatus).includes(value.workspace.status as RunWorkspaceStatus)) {
    return null;
  }
  if (
    typeof value.workspace.reviewOnly !== "boolean" ||
    !stringArray(value.workspace.changedFilesSample)
  ) {
    return null;
  }
  if (
    !Object.values(RunAccountCapacityStatus).includes(
      value.accountCapacity.status as RunAccountCapacityStatus,
    ) ||
    typeof value.accountCapacity.totalHints !== "number" ||
    typeof value.accountCapacity.blockedCount !== "number" ||
    typeof value.accountCapacity.cooldownCount !== "number" ||
    !stringArray(value.accountCapacity.maskedAccounts) ||
    !stringArray(value.accountCapacity.reasons)
  ) {
    return null;
  }
  if (!Object.values(RunOutcomeStatus).includes(value.outcome.status as RunOutcomeStatus)) {
    return null;
  }
  if (
    !Object.values(RunControlInboxStatus).includes(
      value.controlInbox.status as RunControlInboxStatus,
    ) ||
    typeof value.controlInbox.pendingCount !== "number" ||
    typeof value.controlInbox.deliveredCount !== "number" ||
    typeof value.controlInbox.blockedDeliveryCount !== "number"
  ) {
    return null;
  }
  return value as unknown as RunEventReadModels;
}

function unknownReadModels(input: {
  readonly runId: string;
  readonly providerKind: RunEventReadModels["providerKind"];
  readonly observedAt: string;
  readonly reason?: string;
}): RunEventReadModels {
  return {
    schemaVersion: 1,
    runId: input.runId,
    providerKind: input.providerKind,
    observedAt: input.observedAt,
    safety: {
      status: RunSafetyStatus.Unknown,
      safeToContinue: false,
      reviewOnly: true,
      issueKind: RunRuntimeIssueKind.Unknown,
      reason: input.reason ?? "legacy_projection_without_read_models",
      confidence: RunSafetyConfidence.Low,
      evidence: [],
    },
    liveness: { status: RunLivenessStatus.Unknown },
    workspace: {
      status: RunWorkspaceStatus.Unknown,
      reviewOnly: true,
      changedFilesSample: [],
    },
    accountCapacity: {
      status: RunAccountCapacityStatus.Unknown,
      totalHints: 0,
      blockedCount: 0,
      cooldownCount: 0,
      maskedAccounts: [],
      reasons: [],
    },
    outcome: { status: RunOutcomeStatus.Unknown },
    controlInbox: {
      status: RunControlInboxStatus.Unknown,
      pendingCount: 0,
      deliveredCount: 0,
      blockedDeliveryCount: 0,
    },
  };
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function optionalNumber(value: unknown): value is number | undefined {
  return value === undefined ||
    (typeof value === "number" && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
