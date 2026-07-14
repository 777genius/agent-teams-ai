import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export enum DurableJsonPublishStatus {
  Published = "published",
  AlreadyExists = "already_exists",
}

export type ProjectControlOperationExecutionClaimRecord = {
  readonly format: 1;
  readonly operationId: string;
  readonly claimId: string;
  readonly hostname: string;
  readonly pid: number;
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
};

export type ProjectControlOperationExecutionClaim = {
  readonly record: ProjectControlOperationExecutionClaimRecord;
  readonly renew: () => Promise<boolean>;
  readonly revalidate: () => Promise<boolean>;
  readonly runIfCurrent: <T>(effect: () => Promise<T>) => Promise<
    | { readonly executed: true; readonly value: T }
    | { readonly executed: false }
  >;
  readonly release: () => Promise<void>;
};

export type ProjectControlOperationClaimEnvironment = {
  readonly hostname?: string;
  readonly pid?: number;
  readonly leaseDurationMs?: number;
  readonly now?: () => Date;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly onStaleOwnerObserved?: () => Promise<void>;
};

export type ProjectControlOperationUpdateLockEnvironment = {
  readonly hostname?: string;
  readonly pid?: number;
  readonly staleDurationMs?: number;
  readonly retryMs?: number;
  readonly maxAttempts?: number;
  readonly now?: () => Date;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly onStaleOwnerObserved?: () => Promise<void>;
};

export type ProjectControlOperationUpdateLockFence = {
  readonly assertOwned: () => Promise<void>;
  readonly runIfOwned: <T>(effect: () => Promise<T>) => Promise<T>;
};

type ProjectControlOperationUpdateLockRecord = {
  readonly format: 1;
  readonly lockId: string;
  readonly hostname: string;
  readonly pid: number;
  readonly acquiredAt: string;
};

type DirectoryIdentity = {
  readonly dev: number;
  readonly ino: number;
};

type StaleOwnerObservation<T> =
  | { readonly owner: T; readonly directoryIdentity?: never }
  | { readonly owner?: never; readonly directoryIdentity: DirectoryIdentity };

type ResolvedClaimEnvironment = Required<Omit<
  ProjectControlOperationClaimEnvironment,
  "onStaleOwnerObserved"
>> & Pick<ProjectControlOperationClaimEnvironment, "onStaleOwnerObserved">;

type ResolvedUpdateLockEnvironment = Required<Omit<
  ProjectControlOperationUpdateLockEnvironment,
  "onStaleOwnerObserved"
>> & Pick<ProjectControlOperationUpdateLockEnvironment, "onStaleOwnerObserved">;

const UPDATE_LOCK_STALE_MS = 30_000;
const UPDATE_LOCK_RETRY_MS = 10;
const UPDATE_LOCK_MAX_ATTEMPTS = 1_000;

export function projectControlOperationClaimDirectory(
  operationFilePath: string,
): string {
  return join(dirname(operationFilePath), ".execution-claim");
}

export async function withProjectControlOperationUpdateLock<T>(input: {
  readonly operationFilePath: string;
  readonly environment?: ProjectControlOperationUpdateLockEnvironment;
  readonly effect: (
    fence: ProjectControlOperationUpdateLockFence,
  ) => Promise<T>;
}): Promise<T> {
  const operationDirectory = dirname(input.operationFilePath);
  const lockDirectory = join(operationDirectory, ".update-lock");
  const ownerPath = join(lockDirectory, "owner.json");
  const environment = updateLockEnvironment(input.environment);
  const ownerIdentity = {
    format: 1,
    lockId: randomUUID(),
    hostname: environment.hostname,
    pid: environment.pid,
  } as const;

  for (let attempt = 0; attempt < environment.maxAttempts; attempt += 1) {
    const owner: ProjectControlOperationUpdateLockRecord = {
      ...ownerIdentity,
      acquiredAt: environment.now().toISOString(),
    };
    if (await tryPublishProjectControlOperationUpdateLock({
      operationDirectory,
      lockDirectory,
      owner,
    })) {
      try {
        return await input.effect({
          assertOwned: () => assertProjectControlOperationUpdateLockOwned({
            ownerPath,
            owner,
          }),
          runIfOwned: (effect) => runWithProjectControlOperationUpdateLock({
            lockDirectory,
            ownerPath,
            owner,
            effect,
          }),
        });
      } finally {
        await releaseProjectControlOperationUpdateLock({
          lockDirectory,
          ownerPath,
          owner,
        });
      }
    }

    const staleObservation = await observeStaleUpdateLock({
      lockDirectory,
      ownerPath,
      environment,
    });
    if (staleObservation) {
      await environment.onStaleOwnerObserved?.();
      const stalePath = `${lockDirectory}.stale.${process.pid}.${randomUUID()}`;
      if (await moveDirectoryIfStillObserved({
        directory: lockDirectory,
        ownerPath,
        expected: staleObservation,
        destination: stalePath,
        readOwner: readUpdateLockOwner,
        sameOwner: sameUpdateLockOwner,
      })) {
        await syncDirectory(operationDirectory);
        await rm(stalePath, { recursive: true, force: true });
      }
      continue;
    }
    await delay(environment.retryMs);
  }
  throw new Error("project_control_operation_update_lock_timeout");
}

export async function durableReplaceJsonFile(input: {
  readonly path: string;
  readonly value: unknown;
  readonly mode?: number;
  readonly ensureParent?: boolean;
}): Promise<void> {
  const parent = dirname(input.path);
  if (input.ensureParent !== false) {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await syncDirectory(dirname(parent));
  }
  const temporaryPath = join(
    parent,
    `.${input.path.slice(parent.length + 1)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeSyncedFile({
      path: temporaryPath,
      value: input.value,
      mode: input.mode ?? 0o600,
    });
    await rename(temporaryPath, input.path);
    await syncDirectory(parent);
  } finally {
    await unlink(temporaryPath).catch(ignoreMissingFile);
  }
}

export async function durablePublishJsonFile(input: {
  readonly path: string;
  readonly value: unknown;
  readonly mode?: number;
}): Promise<DurableJsonPublishStatus> {
  const parent = dirname(input.path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await syncDirectory(dirname(parent));
  const temporaryPath = join(
    parent,
    `.${input.path.slice(parent.length + 1)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeSyncedFile({
      path: temporaryPath,
      value: input.value,
      mode: input.mode ?? 0o600,
    });
    try {
      // Publish the synced inode without replacing an already durable result.
      await link(temporaryPath, input.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return DurableJsonPublishStatus.AlreadyExists;
      }
      throw error;
    }
    await syncDirectory(parent);
    return DurableJsonPublishStatus.Published;
  } finally {
    await unlink(temporaryPath).catch(ignoreMissingFile);
  }
}

export async function tryAcquireProjectControlOperationClaim(input: {
  readonly operationId: string;
  readonly operationFilePath: string;
  readonly environment?: ProjectControlOperationClaimEnvironment;
}): Promise<ProjectControlOperationExecutionClaim | undefined> {
  const environment = claimEnvironment(input.environment);
  const claimDirectory = projectControlOperationClaimDirectory(
    input.operationFilePath,
  );
  const claimPath = join(claimDirectory, "claim.json");

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const acquiredAtDate = environment.now();
    const acquiredAtMs = stableNowMs(() => acquiredAtDate);
    const acquiredAt = acquiredAtDate.toISOString();
    let record: ProjectControlOperationExecutionClaimRecord = {
      format: 1,
      operationId: input.operationId,
      claimId: randomUUID(),
      hostname: environment.hostname,
      pid: environment.pid,
      acquiredAt,
      renewedAt: acquiredAt,
      expiresAt: new Date(
        acquiredAtMs + environment.leaseDurationMs,
      ).toISOString(),
    };
    if (await tryPublishExecutionClaimDirectory({
      claimDirectory,
      record,
    })) {
      // The owner stays immutable; claim-specific heartbeats cannot overwrite a successor.
      const heartbeatPath = join(
        claimDirectory,
        `heartbeat.${record.claimId}.json`,
      );
      const renewCurrentClaim = async <T>(
        effect?: () => Promise<T>,
      ): Promise<
        | { readonly executed: true; readonly value: T | undefined }
        | { readonly executed: false }
      > => {
        for (
          let transitionAttempt = 0;
          transitionAttempt < 8;
          transitionAttempt += 1
        ) {
          const transitioned = await withDirectoryOwnershipTransition({
            directory: claimDirectory,
            effect: async () => {
              const renewedAtDate = environment.now();
              const nowMs = stableNowMs(() => renewedAtDate);
              const observed = await readObservedExecutionClaim({
                claimDirectory,
                claimPath,
              });
              if (
                !sameExecutionClaimOwner(observed?.owner, record) ||
                !executionClaimUnexpired(observed?.lease, nowMs)
              ) {
                return { executed: false } as const;
              }
              const renewedAt = renewedAtDate.toISOString();
              const renewedRecord = {
                ...record,
                renewedAt,
                expiresAt: new Date(
                  nowMs + environment.leaseDurationMs,
                ).toISOString(),
              };
              await durableReplaceJsonFile({
                path: heartbeatPath,
                value: renewedRecord,
                ensureParent: false,
              });
              record = renewedRecord;
              return {
                executed: true,
                value: effect ? await effect() : undefined,
              } as const;
            },
          });
          if (transitioned.acquired) return transitioned.value;
          await delay(1);
        }
        return { executed: false };
      };
      return {
        get record() {
          return record;
        },
        revalidate: async () => {
          // Every lease decision uses one clock sample for an unambiguous
          // before/at/after-expiry boundary.
          const nowMs = stableNowMs(environment.now);
          for (
            let transitionAttempt = 0;
            transitionAttempt < 8;
            transitionAttempt += 1
          ) {
            const transitioned = await withDirectoryOwnershipTransition({
              directory: claimDirectory,
              effect: async () => {
                const observed = await readObservedExecutionClaim({
                  claimDirectory,
                  claimPath,
                });
                return sameExecutionClaimOwner(observed?.owner, record) &&
                  executionClaimUnexpired(observed?.lease, nowMs);
              },
            });
            if (transitioned.acquired) return transitioned.value;
            await delay(1);
          }
          return false;
        },
        renew: async () => (await renewCurrentClaim()).executed,
        runIfCurrent: async <T>(effect: () => Promise<T>) => {
          const result = await renewCurrentClaim(effect);
          return result.executed
            ? { executed: true, value: result.value as T }
            : { executed: false };
        },
        release: async () => {
          const releasedPath = `${claimDirectory}.released.${record.claimId}`;
          if (await moveDirectoryIfStillObserved({
            directory: claimDirectory,
            ownerPath: claimPath,
            expected: { owner: record },
            destination: releasedPath,
            readOwner: readExecutionClaim,
            sameOwner: sameExecutionClaimOwner,
          })) {
            await syncDirectory(dirname(claimDirectory));
            await rm(releasedPath, { recursive: true, force: true });
          }
        },
      };
    }

    const staleObservation = await observeStaleExecutionClaim({
      claimDirectory,
      claimPath,
      environment,
    });
    if (!staleObservation) {
      return undefined;
    }

    await environment.onStaleOwnerObserved?.();
    const stalePath = `${claimDirectory}.stale.${process.pid}.${randomUUID()}`;
    if (await moveDirectoryIfStillObserved({
      directory: claimDirectory,
      ownerPath: claimPath,
      expected: staleObservation,
      destination: stalePath,
      readOwner: readExecutionClaim,
      sameOwner: sameExecutionClaimOwner,
    })) {
      await syncDirectory(dirname(claimDirectory));
      await rm(stalePath, { recursive: true, force: true });
    }
  }
  return undefined;
}

function sameExecutionClaimOwner(
  left: ProjectControlOperationExecutionClaimRecord | undefined,
  right: ProjectControlOperationExecutionClaimRecord,
): boolean {
  return left?.operationId === right.operationId &&
    left.claimId === right.claimId &&
    left.hostname === right.hostname &&
    left.pid === right.pid &&
    left.acquiredAt === right.acquiredAt;
}

async function tryPublishExecutionClaimDirectory(input: {
  readonly claimDirectory: string;
  readonly record: ProjectControlOperationExecutionClaimRecord;
}): Promise<boolean> {
  const candidateDirectory = `${input.claimDirectory}.candidate.${input.record.claimId}.${randomUUID()}`;
  const candidateClaimPath = join(candidateDirectory, "claim.json");
  await mkdir(candidateDirectory, { mode: 0o700 });
  try {
    await durableReplaceJsonFile({
      path: candidateClaimPath,
      value: input.record,
      ensureParent: false,
    });
    try {
      await rename(candidateDirectory, input.claimDirectory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY") return false;
      throw error;
    }
    await syncDirectory(dirname(input.claimDirectory));
    return true;
  } finally {
    await rm(candidateDirectory, { recursive: true, force: true });
  }
}

async function observeStaleExecutionClaim(input: {
  readonly claimDirectory: string;
  readonly claimPath: string;
  readonly environment: ResolvedClaimEnvironment;
}): Promise<StaleOwnerObservation<ProjectControlOperationExecutionClaimRecord> | undefined> {
  const claim = await readExecutionClaim(input.claimPath);
  if (claim) {
    const heartbeat = await readExecutionClaim(join(
      input.claimDirectory,
      `heartbeat.${claim.claimId}.json`,
    ));
    const observed = heartbeat?.claimId === claim.claimId ? heartbeat : claim;
    const nowMs = stableNowMs(input.environment.now);
    if (
      !executionClaimUnexpired(observed, nowMs) ||
      (claim.hostname === input.environment.hostname &&
        !input.environment.isProcessAlive(claim.pid))
    ) {
      return { owner: claim };
    }
    return undefined;
  }
  try {
    const metadata = await stat(input.claimDirectory);
    return metadata.mtimeMs + input.environment.leaseDurationMs <=
        stableNowMs(input.environment.now)
      ? { directoryIdentity: directoryIdentity(metadata) }
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readObservedExecutionClaim(input: {
  readonly claimDirectory: string;
  readonly claimPath: string;
}): Promise<{
  readonly owner: ProjectControlOperationExecutionClaimRecord;
  readonly lease: ProjectControlOperationExecutionClaimRecord;
} | undefined> {
  const owner = await readExecutionClaim(input.claimPath);
  if (!owner) return undefined;
  const heartbeat = await readExecutionClaim(join(
    input.claimDirectory,
    `heartbeat.${owner.claimId}.json`,
  ));
  return {
    owner,
    lease: heartbeat !== undefined && sameExecutionClaimOwner(heartbeat, owner)
      ? heartbeat
      : owner,
  };
}

function executionClaimUnexpired(
  record: ProjectControlOperationExecutionClaimRecord | undefined,
  nowMs: number,
): boolean {
  if (!record) return false;
  const expiresAtMs = Date.parse(record.expiresAt);
  return Number.isFinite(expiresAtMs) && nowMs < expiresAtMs;
}

async function readExecutionClaim(
  claimPath: string,
): Promise<ProjectControlOperationExecutionClaimRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(claimPath, "utf8")) as unknown;
    if (!isRecord(value) || value.format !== 1) return undefined;
    if (
      typeof value.operationId !== "string" ||
      typeof value.claimId !== "string" ||
      typeof value.hostname !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.acquiredAt !== "string" ||
      typeof value.renewedAt !== "string" ||
      typeof value.expiresAt !== "string"
    ) {
      return undefined;
    }
    return value as ProjectControlOperationExecutionClaimRecord;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof SyntaxError
    ) {
      return undefined;
    }
    throw error;
  }
}

async function observeStaleUpdateLock(input: {
  readonly lockDirectory: string;
  readonly ownerPath: string;
  readonly environment: ResolvedUpdateLockEnvironment;
}): Promise<StaleOwnerObservation<ProjectControlOperationUpdateLockRecord> | undefined> {
  const owner = await readUpdateLockOwner(input.ownerPath);
  if (owner) {
    if (owner.hostname === input.environment.hostname) {
      return input.environment.isProcessAlive(owner.pid)
        ? undefined
        : { owner };
    }
    return Date.parse(owner.acquiredAt) + input.environment.staleDurationMs <=
        stableNowMs(input.environment.now)
      ? { owner }
      : undefined;
  }
  try {
    const metadata = await stat(input.lockDirectory);
    return metadata.mtimeMs + input.environment.staleDurationMs <=
        stableNowMs(input.environment.now)
      ? { directoryIdentity: directoryIdentity(metadata) }
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function tryPublishProjectControlOperationUpdateLock(input: {
  readonly operationDirectory: string;
  readonly lockDirectory: string;
  readonly owner: ProjectControlOperationUpdateLockRecord;
}): Promise<boolean> {
  const candidateDirectory = `${input.lockDirectory}.candidate.${input.owner.lockId}.${randomUUID()}`;
  const candidateOwnerPath = join(candidateDirectory, "owner.json");
  await mkdir(candidateDirectory, { mode: 0o700 });
  try {
    await durableReplaceJsonFile({
      path: candidateOwnerPath,
      value: input.owner,
      ensureParent: false,
    });
    try {
      await rename(candidateDirectory, input.lockDirectory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY") return false;
      throw error;
    }
    await syncDirectory(input.operationDirectory);
    return true;
  } finally {
    await rm(candidateDirectory, { recursive: true, force: true });
  }
}

async function assertProjectControlOperationUpdateLockOwned(input: {
  readonly ownerPath: string;
  readonly owner: ProjectControlOperationUpdateLockRecord;
}): Promise<void> {
  const current = await readUpdateLockOwner(input.ownerPath);
  if (!sameUpdateLockOwner(current, input.owner)) {
    throw new Error("project_control_operation_update_lock_lost");
  }
}

async function readUpdateLockOwner(
  ownerPath: string,
): Promise<ProjectControlOperationUpdateLockRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(ownerPath, "utf8")) as unknown;
    if (
      !isRecord(value) ||
      value.format !== 1 ||
      typeof value.lockId !== "string" ||
      typeof value.hostname !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.acquiredAt !== "string"
    ) {
      return undefined;
    }
    return value as ProjectControlOperationUpdateLockRecord;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof SyntaxError
    ) {
      return undefined;
    }
    throw error;
  }
}

async function releaseProjectControlOperationUpdateLock(input: {
  readonly lockDirectory: string;
  readonly ownerPath: string;
  readonly owner: ProjectControlOperationUpdateLockRecord;
}): Promise<void> {
  const releasedPath = `${input.lockDirectory}.released.${input.owner.lockId}`;
  if (await moveDirectoryIfStillObserved({
    directory: input.lockDirectory,
    ownerPath: input.ownerPath,
    expected: { owner: input.owner },
    destination: releasedPath,
    readOwner: readUpdateLockOwner,
    sameOwner: sameUpdateLockOwner,
  })) {
    await syncDirectory(dirname(input.lockDirectory));
    await rm(releasedPath, { recursive: true, force: true });
  }
}

function sameUpdateLockOwner(
  left: ProjectControlOperationUpdateLockRecord | undefined,
  right: ProjectControlOperationUpdateLockRecord,
): boolean {
  return left?.lockId === right.lockId &&
    left.hostname === right.hostname &&
    left.pid === right.pid &&
    left.acquiredAt === right.acquiredAt;
}

async function runWithProjectControlOperationUpdateLock<T>(input: {
  readonly lockDirectory: string;
  readonly ownerPath: string;
  readonly owner: ProjectControlOperationUpdateLockRecord;
  readonly effect: () => Promise<T>;
}): Promise<T> {
  const transitioned = await withDirectoryOwnershipTransition({
    directory: input.lockDirectory,
    effect: async () => {
      const current = await readUpdateLockOwner(input.ownerPath);
      if (!sameUpdateLockOwner(current, input.owner)) {
        throw new Error("project_control_operation_update_lock_lost");
      }
      return input.effect();
    },
  });
  if (!transitioned.acquired) {
    throw new Error("project_control_operation_update_lock_lost");
  }
  return transitioned.value;
}

async function withDirectoryOwnershipTransition<T>(input: {
  readonly directory: string;
  readonly effect: () => Promise<T>;
}): Promise<
  | { readonly acquired: true; readonly value: T }
  | { readonly acquired: false }
> {
  const transitionPath = join(input.directory, ".ownership-transition");
  let transitionHandle;
  try {
    transitionHandle = await open(transitionPath, "wx", 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOENT") return { acquired: false };
    throw error;
  }
  try {
    return { acquired: true, value: await input.effect() };
  } finally {
    await transitionHandle.close();
    await unlink(transitionPath).catch(ignoreMissingFile);
  }
}

async function moveDirectoryIfStillObserved<T>(input: {
  readonly directory: string;
  readonly ownerPath: string;
  readonly expected: StaleOwnerObservation<T>;
  readonly destination: string;
  readonly readOwner: (path: string) => Promise<T | undefined>;
  readonly sameOwner: (left: T | undefined, right: T) => boolean;
}): Promise<boolean> {
  const transitionPath = join(input.directory, ".ownership-transition");
  let transitionHandle;
  try {
    transitionHandle = await open(transitionPath, "wx", 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOENT") return false;
    throw error;
  }

  let moved = false;
  try {
    if ("owner" in input.expected) {
      const currentOwner = await input.readOwner(input.ownerPath);
      if (!input.sameOwner(currentOwner, input.expected.owner)) return false;
    } else {
      let currentIdentity: DirectoryIdentity;
      try {
        currentIdentity = directoryIdentity(await stat(input.directory));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      if (!sameDirectoryIdentity(
        currentIdentity,
        input.expected.directoryIdentity,
      )) {
        return false;
      }
    }
    try {
      await rename(input.directory, input.destination);
      moved = true;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  } finally {
    await transitionHandle.close();
    const transitionCleanupPath = join(
      moved ? input.destination : input.directory,
      ".ownership-transition",
    );
    await unlink(transitionCleanupPath).catch(ignoreMissingFile);
  }
}

function directoryIdentity(metadata: {
  readonly dev: number;
  readonly ino: number;
}): DirectoryIdentity {
  return { dev: metadata.dev, ino: metadata.ino };
}

function sameDirectoryIdentity(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stableNowMs(now: () => Date): number {
  const value = now().getTime();
  if (!Number.isFinite(value)) {
    throw new Error("project_control_operation_clock_invalid");
  }
  return value;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function claimEnvironment(
  environment: ProjectControlOperationClaimEnvironment | undefined,
): ResolvedClaimEnvironment {
  return {
    hostname: environment?.hostname ?? hostname(),
    pid: environment?.pid ?? process.pid,
    leaseDurationMs: environment?.leaseDurationMs ?? 5 * 60_000,
    now: environment?.now ?? (() => new Date()),
    isProcessAlive: environment?.isProcessAlive ?? localProcessIsAlive,
    ...(environment?.onStaleOwnerObserved === undefined
      ? {}
      : { onStaleOwnerObserved: environment.onStaleOwnerObserved }),
  };
}

function updateLockEnvironment(
  environment: ProjectControlOperationUpdateLockEnvironment | undefined,
): ResolvedUpdateLockEnvironment {
  return {
    hostname: environment?.hostname ?? hostname(),
    pid: environment?.pid ?? process.pid,
    staleDurationMs: environment?.staleDurationMs ?? UPDATE_LOCK_STALE_MS,
    retryMs: environment?.retryMs ?? UPDATE_LOCK_RETRY_MS,
    maxAttempts: environment?.maxAttempts ?? UPDATE_LOCK_MAX_ATTEMPTS,
    now: environment?.now ?? (() => new Date()),
    isProcessAlive: environment?.isProcessAlive ?? localProcessIsAlive,
    ...(environment?.onStaleOwnerObserved === undefined
      ? {}
      : { onStaleOwnerObserved: environment.onStaleOwnerObserved }),
  };
}

function localProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function writeSyncedFile(input: {
  readonly path: string;
  readonly value: unknown;
  readonly mode: number;
}): Promise<void> {
  const handle = await open(input.path, "wx", input.mode);
  try {
    await handle.writeFile(`${JSON.stringify(input.value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!directorySyncUnsupported(error)) throw error;
  } finally {
    await handle?.close();
  }
}

function directorySyncUnsupported(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EISDIR" || code === "EINVAL" || code === "ENOTSUP" ||
    code === "EPERM" || code === "EACCES";
}

function ignoreMissingFile(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
