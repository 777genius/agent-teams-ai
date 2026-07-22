import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  IntegrationAttemptStatus,
  OperatorArtifactRecoveryState,
} from "@vioxen/subscription-runtime/worker-core";
import {
  assertOperatorRecoveryPermitFileSecurity,
  runProjectIntegrationOperatorRecoveryCli,
} from "../project-integration-operator-recovery-cli";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("project integration operator recovery CLI", () => {
  it("is preview-only by default and passes the exact permit hash", async () => {
    const fixture = await createFixture();
    let observed:
      { readonly confirm: boolean; readonly permitSha256: string } | undefined;
    const exitCode = await runProjectIntegrationOperatorRecoveryCli(
      ["--permit-file", fixture.permitPath],
      fixture.io,
      {
        execute: async (input) => {
          observed = input;
          return {
            state: OperatorArtifactRecoveryState.Ready,
            permitSha256: input.permitSha256,
          };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(observed).toMatchObject({ confirm: false });
    expect(observed?.permitSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(fixture.stdout.join(""))).toMatchObject({
      mode: "preview",
      state: OperatorArtifactRecoveryState.Ready,
    });
  });

  it("requires an explicit confirm flag for mutation mode", async () => {
    const fixture = await createFixture();
    const exitCode = await runProjectIntegrationOperatorRecoveryCli(
      ["--permit-file", fixture.permitPath, "--confirm"],
      fixture.io,
      {
        execute: async (input) => ({
          state: input.confirm
            ? OperatorArtifactRecoveryState.Completed
            : OperatorArtifactRecoveryState.Ready,
          permitSha256: input.permitSha256,
        }),
      },
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(fixture.stdout.join(""))).toMatchObject({
      mode: "confirm",
      state: OperatorArtifactRecoveryState.Completed,
    });
  });

  it("rejects ambiguous or malformed permits without invoking recovery", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.permitPath, "{}\n");
    let called = false;
    const exitCode = await runProjectIntegrationOperatorRecoveryCli(
      ["--permit-file", fixture.permitPath],
      fixture.io,
      {
        execute: async () => {
          called = true;
          throw new Error("must not run");
        },
      },
    );
    expect(exitCode).toBe(1);
    expect(called).toBe(false);
    expect(fixture.stderr).toEqual([
      "operator_artifact_recovery_permit_invalid\n",
    ]);
  });

  it("rejects a permit symlink before parsing or executing", async () => {
    const fixture = await createFixture();
    const symlinkPath = join(fixture.root, "permit-link.json");
    await symlink(fixture.permitPath, symlinkPath);
    let called = false;
    const exitCode = await runProjectIntegrationOperatorRecoveryCli(
      ["--permit-file", symlinkPath],
      fixture.io,
      {
        execute: async () => {
          called = true;
          throw new Error("must not run");
        },
      },
    );
    expect(exitCode).toBe(1);
    expect(called).toBe(false);
    expect(fixture.stderr).toEqual([
      "operator_artifact_recovery_permit_open_failed\n",
    ]);
  });

  it("requires root execution and a root-owned 0600 production permit", () => {
    expect(() =>
      assertOperatorRecoveryPermitFileSecurity({ uid: 0, mode: 0o100600 }, 0),
    ).not.toThrow();
    expect(() =>
      assertOperatorRecoveryPermitFileSecurity({ uid: 0, mode: 0o100644 }, 0),
    ).toThrow("operator_artifact_recovery_permit_mode_invalid");
    expect(() =>
      assertOperatorRecoveryPermitFileSecurity(
        { uid: 1000, mode: 0o100600 },
        0,
      ),
    ).toThrow("operator_artifact_recovery_permit_owner_invalid");
    expect(() =>
      assertOperatorRecoveryPermitFileSecurity(
        { uid: 1000, mode: 0o100600 },
        1000,
      ),
    ).toThrow("operator_artifact_recovery_root_required");
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "operator-recovery-cli-"));
  roots.push(root);
  const permitPath = join(root, "permit.json");
  await writeFile(
    permitPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        registryRootDir: "/registry",
        controllerJobId: "controller-1",
        projectId: "project-1",
        attemptId: "attempt-1",
        expectedAttemptStatus: IntegrationAttemptStatus.ChecksPassed,
        targetWorkspacePath: "/work/canonical",
        targetBranch: "main",
        targetHeadSha: "a".repeat(40),
        candidatePatchSha256: "b".repeat(64),
        candidatePatchSize: 123,
        artifact: {
          path: ".eslintcache",
          sha256: "c".repeat(64),
          size: 42,
          mode: 0o600,
          mtimeMs: Date.parse("2026-07-22T00:00:01.500Z"),
        },
        check: {
          checkId: "lint",
          command: ["npm", "run", "lint"],
          startedAt: "2026-07-22T00:00:01.000Z",
          completedAt: "2026-07-22T00:00:02.000Z",
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    root,
    permitPath,
    stdout,
    stderr,
    io: {
      cwd: () => root,
      writeStdout: (chunk: string) => stdout.push(chunk),
      writeStderr: (chunk: string) => stderr.push(chunk),
    },
  };
}
