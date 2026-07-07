import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  RunEventOrchestratorPolicyState,
  RunEventOrchestratorStateStorePort,
} from "../ports/run-event-orchestrator-state-store-contracts";
import { hashRunEventOrchestratorId } from "../domain/run-event-orchestrator-state-file-policy";

export type LocalFileRunEventOrchestratorStateStoreOptions = {
  readonly rootDir: string;
};

export class LocalFileRunEventOrchestratorStateStore
  implements RunEventOrchestratorStateStorePort
{
  constructor(
    private readonly options: LocalFileRunEventOrchestratorStateStoreOptions,
  ) {}

  async readState(
    orchestratorId: string,
  ): Promise<RunEventOrchestratorPolicyState | null> {
    const path = this.statePath(orchestratorId);
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
    const state = parseState(parsed);
    if (!state || state.orchestratorId !== orchestratorId) {
      await rm(path, { force: true });
      return null;
    }
    return state;
  }

  async writeState(state: RunEventOrchestratorPolicyState): Promise<void> {
    const path = this.statePath(state.orchestratorId);
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

  private statePath(orchestratorId: string): string {
    return join(
      this.options.rootDir,
      "run-event-orchestrator-state",
      hashRunEventOrchestratorId(orchestratorId),
    );
  }
}

function parseState(value: unknown): RunEventOrchestratorPolicyState | null {
  if (!isRecord(value)) return null;
  if (
    value.schemaVersion !== 1 ||
    typeof value.orchestratorId !== "string" ||
    typeof value.updatedAt !== "string" ||
    !Array.isArray(value.processedEventIds) ||
    !Array.isArray(value.cooldowns)
  ) {
    return null;
  }
  if (!optionalCursor(value.cursor)) return null;
  const processedEventIds = value.processedEventIds.filter((item) =>
    typeof item === "string"
  );
  if (processedEventIds.length !== value.processedEventIds.length) return null;
  const cooldowns = value.cooldowns.map(parseCooldown);
  if (cooldowns.some((item) => item === null)) return null;
  const actionAttemptsSource = value.actionAttempts === undefined
    ? []
    : value.actionAttempts;
  if (!Array.isArray(actionAttemptsSource)) return null;
  const actionAttempts = actionAttemptsSource.map(parseActionAttempt);
  if (actionAttempts.some((item) => item === null)) return null;
  return {
    schemaVersion: 1,
    orchestratorId: value.orchestratorId,
    ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
    processedEventIds,
    cooldowns: cooldowns as NonNullable<(typeof cooldowns)[number]>[],
    actionAttempts: actionAttempts as NonNullable<(typeof actionAttempts)[number]>[],
    updatedAt: value.updatedAt,
  };
}

function parseCooldown(value: unknown): {
  readonly key: string;
  readonly until: string;
} | null {
  if (!isRecord(value)) return null;
  if (typeof value.key !== "string" || typeof value.until !== "string") return null;
  return {
    key: value.key,
    until: value.until,
  };
}

function parseActionAttempt(value: unknown): {
  readonly key: string;
  readonly count: number;
  readonly latestEventId: string;
  readonly latestAttemptAt: string;
} | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.key !== "string" ||
    typeof value.count !== "number" ||
    !Number.isFinite(value.count) ||
    value.count < 0 ||
    typeof value.latestEventId !== "string" ||
    typeof value.latestAttemptAt !== "string"
  ) {
    return null;
  }
  return {
    key: value.key,
    count: value.count,
    latestEventId: value.latestEventId,
    latestAttemptAt: value.latestAttemptAt,
  };
}

function optionalCursor(value: unknown): value is { readonly value: string } | undefined {
  return value === undefined ||
    (isRecord(value) && typeof value.value === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
