import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { LocalFileWorkerAccountCapacityStore } from "@vioxen/subscription-runtime/store-local-file";
import type { ObservabilityPort } from "@vioxen/subscription-runtime/core";
import {
  WorkerAccountCapacitySignalScope,
  type WorkerAccountCapacityStore,
} from "@vioxen/subscription-runtime/worker-core";
import { CodexAccountCapacityAliasStore } from "./codex-account-capacity-alias-store";

export function codexAccountCapacityRootDir(authRootDir: string): string {
  const resolvedAuthRoot = resolve(authRootDir);
  const canonicalAuthRoot = existsSync(resolvedAuthRoot)
    ? realpathSync(resolvedAuthRoot)
    : resolvedAuthRoot;
  const scope = createHash("sha256")
    .update(canonicalAuthRoot)
    .digest("hex")
    .slice(0, 24);
  return join(
    dirname(canonicalAuthRoot),
    ".subscription-runtime-account-capacity",
    scope,
  );
}

export function codexAccountCapacityStore(
  authRootDir: string,
  options: {
    readonly authJsonPaths?: Readonly<Record<string, string>>;
    readonly authJsonByAlias?: Readonly<Record<string, string>>;
    readonly observability?: ObservabilityPort;
  } = {},
): WorkerAccountCapacityStore {
  const store = new LocalFileWorkerAccountCapacityStore({
    rootDir: codexAccountCapacityRootDir(authRootDir),
    ...(options.observability
      ? { observability: options.observability }
      : {}),
  });
  return new CodexAccountCapacityAliasStore({
    authRootDir,
    store,
    ...(options.authJsonPaths
      ? { authJsonPaths: options.authJsonPaths }
      : {}),
    ...(options.authJsonByAlias
      ? { authJsonByAlias: options.authJsonByAlias }
      : {}),
  });
}

export function migrateLegacyCodexAccountCapacity(input: {
  readonly authRootDir: string;
  readonly stateRootDir: string;
  readonly accountIds: readonly string[];
  readonly authJsonPaths?: Readonly<Record<string, string>>;
  readonly observability?: ObservabilityPort;
  readonly now?: Date;
}): WorkerAccountCapacityStore {
  const shared = codexAccountCapacityStore(input.authRootDir, {
    ...(input.authJsonPaths ? { authJsonPaths: input.authJsonPaths } : {}),
    ...(input.observability ? { observability: input.observability } : {}),
  });
  const legacy = new LocalFileWorkerAccountCapacityStore({
    rootDir: join(input.stateRootDir, "worker-account-capacity"),
  });
  const now = input.now ?? new Date();
  const markerPath = legacyMigrationMarkerPath(input);
  const migratedRevisions = readMigrationMarker(markerPath);
  for (const accountId of new Set(input.accountIds)) {
    const state = legacy.readState({ accountId, now });
    if (!state || migratedRevisions[accountId] === state.revision) continue;
    const migrated = shared.observe({
      accountId,
      ...(state.demand
        ? { demand: state.demand }
        : { scope: WorkerAccountCapacitySignalScope.AccountWide }),
      capacity: state.capacity,
      observedAt: state.capacity.lastLimitSignalAt ?? now,
      retainExpiredForRecheck: true,
    });
    if (migrated) migratedRevisions[accountId] = state.revision;
  }
  writeMigrationMarker(markerPath, migratedRevisions);
  return shared;
}

function legacyMigrationMarkerPath(input: {
  readonly authRootDir: string;
  readonly stateRootDir: string;
}): string {
  const source = resolve(input.stateRootDir);
  const sourceId = createHash("sha256").update(source).digest("hex").slice(0, 24);
  return join(
    codexAccountCapacityRootDir(input.authRootDir),
    "legacy-migrations",
    `${sourceId}.json`,
  );
}

function readMigrationMarker(path: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function writeMigrationMarker(
  path: string,
  revisions: Readonly<Record<string, string>>,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(revisions, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
}
