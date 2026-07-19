import { describe, expect, it } from "vitest";

import {
  IntegrationErrorReason,
  applyWorkerOutput,
  openProjectIntegrationAttempt,
} from "../../index";
import {
  createFixture,
  mergeInput,
} from "./project-integration-use-cases.fixture";

describe("reviewed merge patch subset", () => {
  it("allows immutable patch files to be a subset of approved conflicts", async () => {
    const fixture = createFixture();
    const candidate = mergeInput();
    fixture.git.appliedFiles = ["src/base-change.ts", "src/memory.ts"];

    const opened = await openProjectIntegrationAttempt(fixture.deps(), {
      ...candidate,
      reviewDecision: {
        ...candidate.reviewDecision,
        approvedFiles: ["src/memory.ts", "src/target-only-conflict.ts"],
      },
    });
    const applied = await applyWorkerOutput(fixture.deps(), {
      attemptId: opened.attemptId,
    });

    expect(applied).toMatchObject({
      expectedFiles: ["src/memory.ts", "src/target-only-conflict.ts"],
      workerOutput: { changedFiles: ["src/memory.ts"] },
      appliedFiles: ["src/base-change.ts", "src/memory.ts"],
    });
  });

  it("rejects immutable patch files outside approved conflicts", async () => {
    const fixture = createFixture();
    const candidate = mergeInput();

    await expect(
      openProjectIntegrationAttempt(fixture.deps(), {
        ...candidate,
        workerOutput: {
          ...candidate.workerOutput,
          changedFiles: ["src/memory.ts", "src/unapproved.ts"],
        },
      }),
    ).rejects.toMatchObject({
      reason: IntegrationErrorReason.PathOutsideExpectedFiles,
      evidence: ["src/unapproved.ts"],
    });
  });
});
