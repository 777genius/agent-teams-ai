import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  SelectRuntimeAccountUseCase,
  type WorkerAccountCapacityStore,
  type WorkerAccountLeaseStore,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalFileWorkerAccountLeaseStore } from "@vioxen/subscription-runtime/store-local-file";
import type { CodexGoalJobManifest } from "../../codex-goal-jobs";
import type { CodexGoalLaunchInput } from "../../codex-goal-ops";
import {
  codexAccountCapacityRootDir,
  codexAccountCapacityStore,
} from "../codex-account-capacity-store";

const reservationSchemaVersion = 1 as const;
const reservationGraceMs = 10 * 60_000;

type PersistedCodexProjectAccountReservation = {
  readonly schemaVersion: typeof reservationSchemaVersion;
  readonly accountId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
};

export type CodexProjectAccountReservation = {
  readonly accountId: string;
  readonly fencingToken: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly launch: CodexGoalLaunchInput;
};

export type CodexProjectAccountReservationDeps = {
  readonly capacityStore?: WorkerAccountCapacityStore;
  readonly leaseStore?: WorkerAccountLeaseStore;
  readonly now?: Date;
};

export async function reserveCodexProjectAccount(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
  readonly deps?: CodexProjectAccountReservationDeps;
}): Promise<CodexProjectAccountReservation> {
  const now = input.deps?.now ?? new Date();
  const ttlMs = Math.max(
    reservationGraceMs,
    (input.launch.config.taskTimeoutMs ?? 0) + reservationGraceMs,
  );
  const leaseStore = input.deps?.leaseStore ?? codexProjectAccountLeaseStore(
    input.launch.config.authRootDir,
  );
  const receiptPath = codexProjectAccountReservationPath(input.manifest);
  const existing = await readReservation(receiptPath);
  if (
    existing &&
    input.launch.config.accounts.some((account) =>
      account.name === existing.accountId
    )
  ) {
    const renewed = await leaseStore.renew({
      leaseId: existing.leaseId,
      ownerId: input.manifest.jobId,
      ttlMs,
      now,
    });
    if (renewed.status === "renewed") {
      const receipt = receiptFromLease(renewed.lease);
      await writeReservation(receiptPath, receipt);
      return reservationResult(input.launch, receipt);
    }
  }

  const capacityStore = input.deps?.capacityStore ?? codexAccountCapacityStore(
    input.launch.config.authRootDir,
    {
      authJsonPaths: Object.fromEntries(
        input.launch.config.accounts.flatMap((account) =>
          account.authJsonPath
            ? [[account.name, account.authJsonPath]]
            : []
        ),
      ),
    },
  );
  const selection = await new SelectRuntimeAccountUseCase().execute({
    allowedAccounts: input.launch.config.accounts.map((account) => account.name),
    demand: {
      provider: "codex",
      ...(input.launch.config.model
        ? { model: input.launch.config.model }
        : {}),
      ...(input.launch.config.reasoningEffort
        ? { reasoningEffort: input.launch.config.reasoningEffort }
        : {}),
      ...(input.launch.config.serviceTier
        ? { serviceTier: input.launch.config.serviceTier }
        : {}),
    },
    leaseDemand: null,
    ownerId: input.manifest.jobId,
    leaseTtlMs: ttlMs,
    capacityStore,
    leaseStore,
    now,
  });
  if (selection.type === "all_unavailable") {
    const retryAt = selection.waitPlan.waitUntil?.toISOString();
    throw new Error(
      retryAt
        ? `project_control_account_reservation_unavailable_until:${retryAt}`
        : "project_control_account_reservation_unavailable",
    );
  }
  const receipt = receiptFromLease(selection.lease);
  try {
    await writeReservation(receiptPath, receipt);
  } catch (error) {
    await leaseStore.release({
      leaseId: selection.lease.leaseId,
      ownerId: input.manifest.jobId,
      reason: "reservation_receipt_write_failed",
      now,
    });
    throw error;
  }
  return reservationResult(input.launch, receipt);
}

export async function releaseCodexProjectAccount(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
  readonly reason: string;
  readonly deps?: Pick<CodexProjectAccountReservationDeps, "leaseStore" | "now">;
}): Promise<boolean> {
  const receiptPath = codexProjectAccountReservationPath(input.manifest);
  const receipt = await readReservation(receiptPath);
  if (!receipt) return false;
  const leaseStore = input.deps?.leaseStore ?? codexProjectAccountLeaseStore(
    input.launch.config.authRootDir,
  );
  await leaseStore.release({
    leaseId: receipt.leaseId,
    ownerId: input.manifest.jobId,
    reason: input.reason,
    now: input.deps?.now ?? new Date(),
  });
  await rm(receiptPath, { force: true });
  return true;
}

export function codexProjectAccountReservationPath(
  manifest: CodexGoalJobManifest,
): string {
  return join(manifest.jobRootDir, "account-reservation.json");
}

function codexProjectAccountLeaseStore(
  authRootDir: string,
): WorkerAccountLeaseStore {
  const capacityRoot = codexAccountCapacityRootDir(authRootDir);
  return new LocalFileWorkerAccountLeaseStore({
    rootDir: join(
      dirname(dirname(capacityRoot)),
      ".subscription-runtime-account-leases",
      basename(capacityRoot),
    ),
  });
}

function reservationResult(
  launch: CodexGoalLaunchInput,
  receipt: PersistedCodexProjectAccountReservation,
): CodexProjectAccountReservation {
  const account = launch.config.accounts.find((candidate) =>
    candidate.name === receipt.accountId
  );
  if (!account) throw new Error("project_control_reserved_account_missing");
  return {
    accountId: receipt.accountId,
    fencingToken: receipt.fencingToken,
    acquiredAt: receipt.acquiredAt,
    expiresAt: receipt.expiresAt,
    launch: {
      ...launch,
      config: {
        ...launch.config,
        accounts: [account],
        maxAccountCycles: 1,
      },
    },
  };
}

function receiptFromLease(lease: {
  readonly accountId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly acquiredAt: Date;
  readonly expiresAt: Date;
}): PersistedCodexProjectAccountReservation {
  return {
    schemaVersion: reservationSchemaVersion,
    accountId: lease.accountId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    acquiredAt: lease.acquiredAt.toISOString(),
    expiresAt: lease.expiresAt.toISOString(),
  };
}

async function readReservation(
  path: string,
): Promise<PersistedCodexProjectAccountReservation | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value) || value.schemaVersion !== reservationSchemaVersion) {
      throw new Error("project_control_account_reservation_invalid");
    }
    const receipt: PersistedCodexProjectAccountReservation = {
      schemaVersion: reservationSchemaVersion,
      accountId: requiredText(value.accountId),
      leaseId: requiredText(value.leaseId),
      fencingToken: requiredPositiveInteger(value.fencingToken),
      acquiredAt: requiredIsoDate(value.acquiredAt),
      expiresAt: requiredIsoDate(value.expiresAt),
    };
    return receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeReservation(
  path: string,
  receipt: PersistedCodexProjectAccountReservation,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const stagingPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(stagingPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(stagingPath, path);
  } finally {
    await rm(stagingPath, { force: true });
  }
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("project_control_account_reservation_invalid");
  }
  return value;
}

function requiredPositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error("project_control_account_reservation_invalid");
  }
  return Number(value);
}

function requiredIsoDate(value: unknown): string {
  const text = requiredText(value);
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error("project_control_account_reservation_invalid");
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
