import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  ControlledAgentEvent,
  ControlledAgentEventPort,
  ControlledAgentRun,
  ControlledAgentSession,
  ControllerStateStorePort,
} from "../ports/controlled-agent-state-store-contracts";
import { hashControlledAgentStateId } from "../domain/controlled-agent-state-file-policy";

export type LocalControlledAgentStateStoreOptions = {
  readonly rootDir: string;
};

export class LocalControlledAgentStateStore
  implements ControllerStateStorePort, ControlledAgentEventPort
{
  constructor(private readonly options: LocalControlledAgentStateStoreOptions) {}

  async readSession(sessionId: string): Promise<ControlledAgentSession | null> {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(this.sessionPath(sessionId), "utf8"),
      );
      return parseSession(parsed, sessionId);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async saveSession(session: ControlledAgentSession): Promise<void> {
    await writeJsonAtomic(this.sessionPath(session.sessionId), session);
  }

  async readRun(runId: string): Promise<ControlledAgentRun | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.runPath(runId), "utf8"));
      return parseRun(parsed, runId);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async readLatestRunForSession(
    sessionId: string,
  ): Promise<ControlledAgentRun | null> {
    let runId: string;
    try {
      runId = (await readFile(this.latestRunPath(sessionId), "utf8")).trim();
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
    if (!runId) return null;
    const run = await this.readRun(runId);
    return run?.sessionId === sessionId ? run : null;
  }

  async saveRun(run: ControlledAgentRun): Promise<void> {
    await writeJsonAtomic(this.runPath(run.runId), run);
    await writeTextAtomic(this.latestRunPath(run.sessionId), `${run.runId}\n`);
  }

  async append(event: ControlledAgentEvent): Promise<void> {
    const path = this.eventsPath(event.sessionId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  private sessionPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), "session.json");
  }

  private latestRunPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), "latest-run-id");
  }

  private eventsPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), "events.jsonl");
  }

  private sessionDir(sessionId: string): string {
    return join(
      this.options.rootDir,
      "controlled-agent",
      "sessions",
      hashControlledAgentStateId(sessionId),
    );
  }

  private runPath(runId: string): string {
    return join(
      this.options.rootDir,
      "controlled-agent",
      "runs",
      hashControlledAgentStateId(runId),
      "run.json",
    );
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = join(dirname(path), `${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, value, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function parseSession(
  value: unknown,
  expectedSessionId: string,
): ControlledAgentSession | null {
  if (!isRecord(value)) return null;
  if (
    value.schemaVersion !== 1 ||
    value.sessionId !== expectedSessionId ||
    !isRecord(value.identity) ||
    typeof value.stateDir !== "string" ||
    typeof value.status !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !isRecord(value.toolSurface)
  ) {
    return null;
  }
  return value as ControlledAgentSession;
}

function parseRun(value: unknown, expectedRunId: string): ControlledAgentRun | null {
  if (!isRecord(value)) return null;
  if (
    value.schemaVersion !== 1 ||
    value.runId !== expectedRunId ||
    typeof value.sessionId !== "string" ||
    typeof value.controllerJobId !== "string" ||
    typeof value.providerKind !== "string" ||
    typeof value.status !== "string" ||
    typeof value.startedAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return value as ControlledAgentRun;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
