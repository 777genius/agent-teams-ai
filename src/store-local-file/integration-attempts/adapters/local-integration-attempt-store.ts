import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  IntegrationAttempt,
  IntegrationAttemptStorePort,
  IntegrationAuditEvent,
} from "../ports/integration-attempt-store-contracts";
import { hashIntegrationAttemptId } from "../domain/integration-attempt-file-policy";

export type LocalIntegrationAttemptStoreOptions = {
  readonly rootDir: string;
  readonly attemptsDir?: string;
};

export class LocalIntegrationAttemptStore implements IntegrationAttemptStorePort {
  constructor(private readonly options: LocalIntegrationAttemptStoreOptions) {}

  async create(attempt: IntegrationAttempt): Promise<void> {
    const existing = await this.get(attempt.attemptId);
    if (existing) throw new Error("integration_attempt_already_exists");
    await this.writeAttempt(attempt);
  }

  async get(attemptId: string): Promise<IntegrationAttempt | null> {
    try {
      const text = await readFile(this.attemptPath(attemptId), "utf8");
      return JSON.parse(text) as IntegrationAttempt;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async update(attempt: IntegrationAttempt): Promise<void> {
    await this.writeAttempt(attempt);
  }

  async appendEvent(
    attemptId: string,
    event: IntegrationAuditEvent,
  ): Promise<void> {
    const path = this.eventsPath(attemptId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async readEvents(attemptId: string): Promise<readonly IntegrationAuditEvent[]> {
    try {
      const text = await readFile(this.eventsPath(attemptId), "utf8");
      return text
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as IntegrationAuditEvent);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeAttempt(attempt: IntegrationAttempt): Promise<void> {
    const path = this.attemptPath(attempt.attemptId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tempPath = join(dirname(path), `${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, `${JSON.stringify(attempt, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(tempPath, path);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  private attemptPath(attemptId: string): string {
    return join(this.attemptDir(attemptId), "attempt.json");
  }

  private eventsPath(attemptId: string): string {
    return join(this.attemptDir(attemptId), "events.jsonl");
  }

  private attemptDir(attemptId: string): string {
    return join(this.attemptsDir(), hashIntegrationAttemptId(attemptId));
  }

  private attemptsDir(): string {
    return this.options.attemptsDir ??
      join(this.options.rootDir, "integration-attempts");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
