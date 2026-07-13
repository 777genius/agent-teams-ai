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
  readonly release: () => Promise<void>;
};

export type ProjectControlOperationClaimEnvironment = {
  readonly hostname?: string;
  readonly pid?: number;
  readonly leaseDurationMs?: number;
  readonly now?: () => Date;
  readonly isProcessAlive?: (pid: number) => boolean;
};

export function projectControlOperationClaimDirectory(
  operationFilePath: string,
): string {
  return join(dirname(operationFilePath), ".execution-claim");
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
    try {
      await mkdir(claimDirectory, { mode: 0o700 });
      await syncDirectory(dirname(claimDirectory));
      const acquiredAt = environment.now().toISOString();
      let record: ProjectControlOperationExecutionClaimRecord = {
        format: 1,
        operationId: input.operationId,
        claimId: randomUUID(),
        hostname: environment.hostname,
        pid: environment.pid,
        acquiredAt,
        renewedAt: acquiredAt,
        expiresAt: new Date(
          Date.parse(acquiredAt) + environment.leaseDurationMs,
        ).toISOString(),
      };
      // The owner stays immutable; claim-specific heartbeats cannot overwrite a successor.
      const heartbeatPath = join(
        claimDirectory,
        `heartbeat.${record.claimId}.json`,
      );
      try {
        await durableReplaceJsonFile({
          path: claimPath,
          value: record,
          ensureParent: false,
        });
      } catch (error) {
        await rm(claimDirectory, { recursive: true, force: true });
        await syncDirectory(dirname(claimDirectory));
        throw error;
      }
      return {
        get record() {
          return record;
        },
        renew: async () => {
          const current = await readExecutionClaim(claimPath);
          if (current?.claimId !== record.claimId) return false;
          const renewedAt = environment.now().toISOString();
          record = {
            ...record,
            renewedAt,
            expiresAt: new Date(
              Date.parse(renewedAt) + environment.leaseDurationMs,
            ).toISOString(),
          };
          try {
            await durableReplaceJsonFile({
              path: heartbeatPath,
              value: record,
              ensureParent: false,
            });
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
          }
        },
        release: async () => {
          const current = await readExecutionClaim(claimPath);
          if (current?.claimId !== record.claimId) return;
          const releasedPath = `${claimDirectory}.released.${record.claimId}`;
          try {
            await rename(claimDirectory, releasedPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
          }
          await syncDirectory(dirname(claimDirectory));
          await rm(releasedPath, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    if (!await executionClaimIsStale({
      claimDirectory,
      claimPath,
      environment,
    })) {
      return undefined;
    }

    const stalePath = `${claimDirectory}.stale.${process.pid}.${randomUUID()}`;
    try {
      await rename(claimDirectory, stalePath);
      await syncDirectory(dirname(claimDirectory));
      await rm(stalePath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

async function executionClaimIsStale(input: {
  readonly claimDirectory: string;
  readonly claimPath: string;
  readonly environment: Required<ProjectControlOperationClaimEnvironment>;
}): Promise<boolean> {
  const claim = await readExecutionClaim(input.claimPath);
  if (claim) {
    const heartbeat = await readExecutionClaim(join(
      input.claimDirectory,
      `heartbeat.${claim.claimId}.json`,
    ));
    const observed = heartbeat?.claimId === claim.claimId ? heartbeat : claim;
    if (claim.hostname === input.environment.hostname) {
      return !input.environment.isProcessAlive(claim.pid);
    }
    return Date.parse(observed.expiresAt) <= input.environment.now().getTime();
  }
  try {
    const metadata = await stat(input.claimDirectory);
    return metadata.mtimeMs + input.environment.leaseDurationMs <=
      input.environment.now().getTime();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
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

function claimEnvironment(
  environment: ProjectControlOperationClaimEnvironment | undefined,
): Required<ProjectControlOperationClaimEnvironment> {
  return {
    hostname: environment?.hostname ?? hostname(),
    pid: environment?.pid ?? process.pid,
    leaseDurationMs: environment?.leaseDurationMs ?? 5 * 60_000,
    now: environment?.now ?? (() => new Date()),
    isProcessAlive: environment?.isProcessAlive ?? localProcessIsAlive,
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
