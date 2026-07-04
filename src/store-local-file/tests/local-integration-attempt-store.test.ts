import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalIntegrationAttemptStore } from "../index";
import {
  IntegrationAttemptStatus,
  IntegrationAuditEventType,
  ReviewDecisionStatus,
  openIntegrationAttempt,
  type IntegrationAuditEvent,
} from "@vioxen/subscription-runtime/worker-core";

describe("LocalIntegrationAttemptStore", () => {
  it("persists attempts across store instances", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "integration-attempt-store-"));
    const first = new LocalIntegrationAttemptStore({ rootDir });
    const attempt = attemptFixture();

    await first.create(attempt);

    const second = new LocalIntegrationAttemptStore({ rootDir });
    await expect(second.get(attempt.attemptId)).resolves.toEqual(attempt);
  });

  it("updates attempts atomically through a temp file and rename", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "integration-attempt-store-"));
    const store = new LocalIntegrationAttemptStore({ rootDir });
    const attempt = attemptFixture();
    await store.create(attempt);

    await store.update({
      ...attempt,
      status: IntegrationAttemptStatus.Applied,
      updatedAt: "2026-01-01T00:00:01.000Z",
    });

    await expect(store.get(attempt.attemptId)).resolves.toMatchObject({
      status: IntegrationAttemptStatus.Applied,
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
  });

  it("appends and reads integration audit events", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "integration-attempt-store-"));
    const store = new LocalIntegrationAttemptStore({ rootDir });
    const attempt = attemptFixture();
    const event: IntegrationAuditEvent = {
      schemaVersion: 1,
      type: IntegrationAuditEventType.AttemptOpened,
      occurredAt: attempt.createdAt,
      attemptId: attempt.attemptId,
      projectId: attempt.projectId,
      controllerJobId: attempt.controllerJobId,
      workerJobId: attempt.workerJobId,
      status: attempt.status,
      files: attempt.expectedFiles,
    };

    await store.appendEvent(attempt.attemptId, event);

    await expect(store.readEvents(attempt.attemptId)).resolves.toEqual([event]);
  });

  it("does not use attempt ids as filesystem path segments", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "integration-attempt-store-"));
    const store = new LocalIntegrationAttemptStore({ rootDir });
    const attempt = attemptFixture("../escape");

    await store.create(attempt);

    await expect(store.get(attempt.attemptId)).resolves.toEqual(attempt);
    await expect(readFile(join(rootDir, "escape", "attempt.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});

function attemptFixture(attemptId = "attempt/with/slashes") {
  return openIntegrationAttempt({
    attemptId,
    projectId: "infinity-context",
    controllerJobId: "infinity-context-controller",
    workerOutput: {
      workerJobId: "infinity-context-child-v1",
      workspacePath: "/work/infinity-context-child",
      changedFiles: ["src/memory.ts"],
    },
    sourceWorkspacePath: "/work/infinity-context-child",
    targetWorkspacePath: "/work/infinity-context-main",
    targetBranch: "main",
    targetRemote: "origin",
    reviewDecision: {
      reviewedBy: "controller",
      decision: ReviewDecisionStatus.Approved,
      reason: "reviewed",
      approvedFiles: ["src/memory.ts"],
      requiredChecks: [],
    },
    now: "2026-01-01T00:00:00.000Z",
  });
}
