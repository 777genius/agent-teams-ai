import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  WorkerControlDeliveryReceipt,
  WorkerControlInboxStore,
  WorkerControlSignal,
  WorkerControlTarget,
} from "../ports/worker-control-inbox-store-contracts";
import { workerControlTargetMatches } from "@vioxen/subscription-runtime/worker-core";
import {
  localWorkerControlInboxStorageVersion as storageVersion,
} from "../domain/worker-control-inbox-record-policy";

export type LocalFileWorkerControlInboxStoreOptions = {
  readonly rootDir: string;
};

type PersistedWorkerControlSignal = Omit<
  WorkerControlSignal,
  "createdAt" | "expiresAt"
> & {
  readonly storageVersion: typeof storageVersion;
  readonly createdAt: string;
  readonly expiresAt?: string;
};

type PersistedWorkerControlDeliveryReceipt = Omit<
  WorkerControlDeliveryReceipt,
  "createdAt" | "deliveredAt" | "appliedAt"
> & {
  readonly storageVersion: typeof storageVersion;
  readonly createdAt: string;
  readonly deliveredAt?: string;
  readonly appliedAt?: string;
};

export class LocalFileWorkerControlInboxStore
  implements WorkerControlInboxStore
{
  constructor(
    private readonly options: LocalFileWorkerControlInboxStoreOptions,
  ) {}

  async appendSignal(
    signal: WorkerControlSignal,
  ): Promise<WorkerControlSignal> {
    await appendJsonLine(
      this.signalsPath(signal.target),
      persistSignal(signal),
    );
    return signal;
  }

  async listSignals(input: {
    readonly target?: WorkerControlTarget;
    readonly signalIds?: readonly string[];
  } = {}): Promise<readonly WorkerControlSignal[]> {
    const signalIds = new Set(input.signalIds ?? []);
    const records = await this.readJobRecords(
      input.target,
      "signals.jsonl",
      parseSignal,
    );
    return records
      .filter((signal) =>
        input.target ? workerControlTargetMatches(input.target, signal.target) : true
      )
      .filter((signal) =>
        signalIds.size === 0 || signalIds.has(signal.signalId)
      );
  }

  async appendReceipt(
    receipt: WorkerControlDeliveryReceipt,
  ): Promise<WorkerControlDeliveryReceipt> {
    await appendJsonLine(
      this.receiptsPath(receipt.target),
      persistReceipt(receipt),
    );
    return receipt;
  }

  async tryClaimDelivery(
    receipt: WorkerControlDeliveryReceipt,
  ): Promise<WorkerControlDeliveryReceipt | null> {
    const path = this.claimPath(receipt.target, receipt.signalId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(path, JSON.stringify(persistReceipt(receipt)), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (isAlreadyExistsError(error)) return null;
      throw error;
    }
    return receipt;
  }

  async releaseDeliveryClaim(input: {
    readonly target: WorkerControlTarget;
    readonly signalId: string;
    readonly deliveryAttemptId?: string;
  }): Promise<boolean> {
    const path = this.claimPath(input.target, input.signalId);
    let existing: WorkerControlDeliveryReceipt | null = null;
    try {
      existing = parseReceipt(JSON.parse(await readFile(path, "utf8")));
    } catch {
      return false;
    }
    if (!existing || existing.state !== "accepted") return false;
    if (
      input.deliveryAttemptId !== undefined &&
      existing.deliveryAttemptId !== input.deliveryAttemptId
    ) {
      return false;
    }
    await rm(path, { force: true });
    return true;
  }

  async listReceipts(input: {
    readonly target?: WorkerControlTarget;
    readonly signalIds?: readonly string[];
  } = {}): Promise<readonly WorkerControlDeliveryReceipt[]> {
    const signalIds = new Set(input.signalIds ?? []);
    const records = [
      ...await this.readJobRecords(input.target, "receipts.jsonl", parseReceipt),
      ...await this.readClaimReceipts(input.target),
    ];
    return records
      .filter((receipt) =>
        input.target ? workerControlTargetMatches(input.target, receipt.target) : true
      )
      .filter((receipt) =>
        signalIds.size === 0 || signalIds.has(receipt.signalId)
      );
  }

  private signalsPath(target: WorkerControlTarget): string {
    return join(this.jobDir(target.jobId), "signals.jsonl");
  }

  private receiptsPath(target: WorkerControlTarget): string {
    return join(this.jobDir(target.jobId), "receipts.jsonl");
  }

  private claimPath(target: WorkerControlTarget, signalId: string): string {
    return join(this.claimDir(target.jobId), `${hashText(signalId)}.json`);
  }

  private claimDir(jobId: string): string {
    return join(this.jobDir(jobId), "delivery-claims");
  }

  private jobDir(jobId: string): string {
    return join(this.options.rootDir, "worker-control-inbox", hashText(jobId));
  }

  private async readJobRecords<T>(
    target: WorkerControlTarget | undefined,
    fileName: string,
    parse: (value: unknown) => T | null,
  ): Promise<readonly T[]> {
    const paths = target
      ? [join(this.jobDir(target.jobId), fileName)]
      : await this.allRecordPaths(fileName);
    const groups = await Promise.all(paths.map((path) => readJsonLines(path, parse)));
    return groups.flat();
  }

  private async readClaimReceipts(
    target: WorkerControlTarget | undefined,
  ): Promise<readonly WorkerControlDeliveryReceipt[]> {
    const dirs = target
      ? [this.claimDir(target.jobId)]
      : await this.allClaimDirs();
    const groups = await Promise.all(dirs.map((dir) => readJsonFiles(dir, parseReceipt)));
    return groups.flat();
  }

  private async allClaimDirs(): Promise<readonly string[]> {
    let entries;
    try {
      entries = await readdir(join(this.options.rootDir, "worker-control-inbox"), {
        withFileTypes: true,
      });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        join(this.options.rootDir, "worker-control-inbox", entry.name, "delivery-claims")
      );
  }

  private async allRecordPaths(fileName: string): Promise<readonly string[]> {
    let entries;
    try {
      entries = await readdir(join(this.options.rootDir, "worker-control-inbox"), {
        withFileTypes: true,
      });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        join(this.options.rootDir, "worker-control-inbox", entry.name, fileName)
      );
  }
}

function persistSignal(
  signal: WorkerControlSignal,
): PersistedWorkerControlSignal {
  return {
    storageVersion,
    schemaVersion: signal.schemaVersion,
    signalId: signal.signalId,
    idempotencyKey: signal.idempotencyKey,
    target: signal.target,
    intent: signal.intent,
    deliveryMode: signal.deliveryMode,
    body: signal.body,
    createdAt: signal.createdAt.toISOString(),
    createdBy: signal.createdBy,
    priority: signal.priority,
    ...(signal.expiresAt === undefined
      ? {}
      : { expiresAt: signal.expiresAt.toISOString() }),
    supersedesSignalIds: signal.supersedesSignalIds,
    metadata: signal.metadata,
  };
}

function parseSignal(value: unknown): WorkerControlSignal | null {
  if (!isRecord(value) || value.storageVersion !== storageVersion) return null;
  if (
    value.schemaVersion !== 1 ||
    typeof value.signalId !== "string" ||
    typeof value.idempotencyKey !== "string" ||
    !isTarget(value.target) ||
    !isIntent(value.intent) ||
    !isDeliveryMode(value.deliveryMode) ||
    typeof value.body !== "string" ||
    typeof value.createdAt !== "string" ||
    !isActor(value.createdBy) ||
    !isPriority(value.priority) ||
    !Array.isArray(value.supersedesSignalIds) ||
    !isStringRecord(value.metadata)
  ) {
    return null;
  }
  const createdAt = parseDate(value.createdAt);
  const expiresAt = optionalDate(value.expiresAt);
  if (!createdAt || expiresAt === false) return null;
  if (!value.supersedesSignalIds.every((item) => typeof item === "string")) {
    return null;
  }
  return {
    schemaVersion: 1,
    signalId: value.signalId,
    idempotencyKey: value.idempotencyKey,
    target: value.target,
    intent: value.intent,
    deliveryMode: value.deliveryMode,
    body: value.body,
    createdAt,
    createdBy: value.createdBy,
    priority: value.priority,
    ...(expiresAt === null ? {} : { expiresAt }),
    supersedesSignalIds: value.supersedesSignalIds,
    metadata: value.metadata,
  };
}

function persistReceipt(
  receipt: WorkerControlDeliveryReceipt,
): PersistedWorkerControlDeliveryReceipt {
  return {
    storageVersion,
    schemaVersion: receipt.schemaVersion,
    receiptId: receipt.receiptId,
    signalId: receipt.signalId,
    target: receipt.target,
    state: receipt.state,
    createdAt: receipt.createdAt.toISOString(),
    ...(receipt.deliveryAttemptId === undefined
      ? {}
      : { deliveryAttemptId: receipt.deliveryAttemptId }),
    ...(receipt.deliveredAt === undefined
      ? {}
      : { deliveredAt: receipt.deliveredAt.toISOString() }),
    ...(receipt.appliedAt === undefined
      ? {}
      : { appliedAt: receipt.appliedAt.toISOString() }),
    ...(receipt.rejectedReason === undefined
      ? {}
      : { rejectedReason: receipt.rejectedReason }),
    ...(receipt.failure === undefined ? {} : { failure: receipt.failure }),
    metadata: receipt.metadata,
  };
}

function parseReceipt(value: unknown): WorkerControlDeliveryReceipt | null {
  if (!isRecord(value) || value.storageVersion !== storageVersion) return null;
  if (
    value.schemaVersion !== 1 ||
    typeof value.receiptId !== "string" ||
    typeof value.signalId !== "string" ||
    !isTarget(value.target) ||
    !isReceiptState(value.state) ||
    typeof value.createdAt !== "string" ||
    !isStringRecord(value.metadata)
  ) {
    return null;
  }
  const createdAt = parseDate(value.createdAt);
  const deliveredAt = optionalDate(value.deliveredAt);
  const appliedAt = optionalDate(value.appliedAt);
  if (!createdAt || deliveredAt === false || appliedAt === false) return null;
  if (value.failure !== undefined && !isFailure(value.failure)) return null;
  return {
    schemaVersion: 1,
    receiptId: value.receiptId,
    signalId: value.signalId,
    target: value.target,
    state: value.state,
    createdAt,
    ...(typeof value.deliveryAttemptId === "string"
      ? { deliveryAttemptId: value.deliveryAttemptId }
      : {}),
    ...(deliveredAt === null ? {} : { deliveredAt }),
    ...(appliedAt === null ? {} : { appliedAt }),
    ...(typeof value.rejectedReason === "string"
      ? { rejectedReason: value.rejectedReason }
      : {}),
    ...(value.failure === undefined ? {} : { failure: value.failure }),
    metadata: value.metadata,
  };
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function readJsonLines<T>(
  path: string,
  parse: (value: unknown) => T | null,
): Promise<readonly T[]> {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return parse(JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter((value): value is T => value !== null);
}

async function readJsonFiles<T>(
  dir: string,
  parse: (value: unknown) => T | null,
): Promise<readonly T[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const records: T[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      const parsed = parse(JSON.parse(await readFile(join(dir, entry.name), "utf8")));
      if (parsed !== null) records.push(parsed);
    } catch {
      // Ignore corrupt claim files for the same reason corrupt JSONL rows are ignored.
    }
  }
  return records;
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EEXIST"
  );
}

function isTarget(value: unknown): value is WorkerControlTarget {
  return isRecord(value) && typeof value.jobId === "string";
}

function isIntent(value: unknown): value is WorkerControlSignal["intent"] {
  return (
    value === "guidance" ||
    value === "pause_requested" ||
    value === "stop_requested" ||
    value === "cancel_requested" ||
    value === "resume_requested" ||
    value === "repair_requested" ||
    value === "policy_update" ||
    value === "operator_note"
  );
}

function isDeliveryMode(
  value: unknown,
): value is WorkerControlSignal["deliveryMode"] {
  return (
    value === "record_only" ||
    value === "next_safe_point" ||
    value === "pause_then_continue" ||
    value === "interrupt_then_continue" ||
    value === "idle_turn_if_supported" ||
    value === "live_if_supported"
  );
}

function isActor(value: unknown): value is WorkerControlSignal["createdBy"] {
  return (
    value === "user" ||
    value === "operator" ||
    value === "orchestrator" ||
    value === "runtime" ||
    value === "agent"
  );
}

function isPriority(value: unknown): value is WorkerControlSignal["priority"] {
  return value === "low" || value === "normal" || value === "high";
}

function isReceiptState(
  value: unknown,
): value is WorkerControlDeliveryReceipt["state"] {
  return (
    value === "accepted" ||
    value === "interrupt_requested" ||
    value === "interrupting" ||
    value === "interrupted" ||
    value === "delivered" ||
    value === "continued" ||
    value === "acknowledged" ||
    value === "superseded" ||
    value === "expired" ||
    value === "rejected" ||
    value === "failed"
  );
}

function isFailure(
  value: unknown,
): value is WorkerControlDeliveryReceipt["failure"] {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}

function isStringRecord(
  value: unknown,
): value is Readonly<Record<string, string>> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalDate(value: unknown): Date | false | null {
  if (value === undefined) return null;
  return typeof value === "string" ? parseDate(value) ?? false : false;
}

function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
