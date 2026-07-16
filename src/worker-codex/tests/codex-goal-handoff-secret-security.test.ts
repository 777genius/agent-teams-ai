import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { OpaqueSecretDetectionPolicy } from "@vioxen/subscription-runtime/worker-core";
import { materializeCodexGoalHandoffArtifacts } from "../codex-goal-handoff-artifacts";
import { assertGitPatchBlobsSecretSafe } from "../git-patch-secret-validator";
import { git } from "./codex-goal-mcp-test-support";

const cleanup: string[] = [];

describe("Codex goal handoff secret security", () => {
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ));
  });

  it("allows an exact fixture literal only in an explicit fixture path", async () => {
    const fixture = await createFixture();
    const fixtureDirectory = join(fixture.workspacePath, "tests", "fixtures");
    await mkdir(fixtureDirectory, { recursive: true });
    await writeFile(
      join(fixtureDirectory, "config.env"),
      ["API_", "KEY=", "test-", "fixture-literal", "\n"].join(""),
    );

    await expect(materialize(fixture)).resolves.toMatchObject({
      changedPaths: ["tests/fixtures/config.env"],
    });

    const productionFixture = await createFixture();
    await writeFile(
      join(productionFixture.workspacePath, "config.env"),
      ["API_", "KEY=", "test-", "fixture-literal", "\n"].join(""),
    );
    await expect(materialize(productionFixture)).rejects.toThrow(
      "handoff_raw_secret_rejected",
    );
  });

  it("rejects a deleted binary preimage without storing a raw provider secret", async () => {
    const fixture = await createFixture();
    const relativePath = "deleted-provider.bin";
    const filePath = join(fixture.workspacePath, relativePath);
    await writeFile(filePath, Buffer.concat([
      Buffer.from([0x00, 0x01]),
      Buffer.from([["s", "k", "-"].join(""), "w".repeat(24)].join("")),
      Buffer.from([0xff]),
    ]));
    await git(fixture.workspacePath, ["add", relativePath]);
    await git(fixture.workspacePath, ["commit", "-m", "test: binary preimage"]);
    await rm(filePath);

    await expect(materializeCodexGoalHandoffArtifacts({
      workerJobId: "worker-1",
      taskId: "task-1",
      workspacePath: fixture.workspacePath,
      jobRootDir: fixture.jobRootDir,
    })).rejects.toThrow("handoff_raw_secret_rejected");
  });

  it("rejects a replaced binary preimage", async () => {
    const fixture = await createFixture();
    const relativePath = "replaced-provider.bin";
    const filePath = join(fixture.workspacePath, relativePath);
    await writeFile(filePath, Buffer.concat([
      Buffer.from([0x00]),
      Buffer.from([["s", "k", "-"].join(""), "r".repeat(24)].join("")),
      Buffer.from([0xff]),
    ]));
    await git(fixture.workspacePath, ["add", relativePath]);
    await git(fixture.workspacePath, ["commit", "-m", "test: binary preimage"]);
    await writeFile(filePath, "safe replacement\n");

    await expect(materializeCodexGoalHandoffArtifacts({
      workerJobId: "worker-1",
      taskId: "task-1",
      workspacePath: fixture.workspacePath,
      jobRootDir: fixture.jobRootDir,
    })).rejects.toThrow("handoff_raw_secret_rejected");
  });

  it("fails closed when a changed blob is opaque", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.workspacePath, "opaque.bin"),
      Buffer.from([0x00, 0xff, 0x01, 0x02]),
    );

    await expect(materialize(fixture)).rejects.toThrow(
      "handoff_raw_secret_rejected",
    );
  });

  it("binds both safety scans to the exact emitted patch under hostile mutation", async () => {
    const fixture = await createFixture();
    const relativePath = "mutation-window.txt";
    const filePath = join(fixture.workspacePath, relativePath);
    const safe = "safe content\n";
    const unsafe = [["s", "k", "-"].join(""), "m".repeat(24), "\n"].join("");
    await writeFile(filePath, safe);

    await expect(materializeCodexGoalHandoffArtifacts({
      workerJobId: "worker-1",
      taskId: "task-1",
      workspacePath: fixture.workspacePath,
      jobRootDir: fixture.jobRootDir,
      expectedBaseCommit: fixture.baseCommit,
      testHooks: {
        afterSafetyScan: async () => {
          await writeFile(filePath, unsafe);
        },
        afterPatchSnapshot: async (snapshot) => {
          if (snapshot === 1) await writeFile(filePath, safe);
        },
      },
    })).rejects.toThrow(`handoff_raw_secret_rejected:${relativePath}`);
  });

  it("keeps rejected patch objects out of the workspace object database", async () => {
    const fixture = await createFixture();
    const relativePath = "rejected-secret.txt";
    await writeFile(
      join(fixture.workspacePath, relativePath),
      [["s", "k", "-"].join(""), "x".repeat(24), "\n"].join(""),
    );
    const patch = await gitOutput(fixture.workspacePath, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-index",
      "--",
      "/dev/null",
      relativePath,
    ], true);
    const patchPath = join(fixture.root, "rejected.patch");
    await writeFile(patchPath, patch);
    const before = await gitOutput(fixture.workspacePath, ["count-objects", "-v"]);

    await expect(assertGitPatchBlobsSecretSafe({
      workspacePath: fixture.workspacePath,
      baseCommit: fixture.baseCommit,
      patchPath,
      changedPaths: [relativePath],
      tempRootDir: join(fixture.root, "scanner-temp"),
    })).rejects.toThrow(`git_patch_secret_like_content:${relativePath}`);

    expect(await gitOutput(
      fixture.workspacePath,
      ["count-objects", "-v"],
    )).toBe(before);
  });

  it("accepts Git-produced forward and reverse binary delta hunks within limits", async () => {
    const fixture = await createFixture();
    const relativePath = "bounded-delta.bin";
    const filePath = join(fixture.workspacePath, relativePath);
    const before = deterministicBinary(32 * 1024);
    await writeFile(filePath, before);
    await git(fixture.workspacePath, ["add", relativePath]);
    await git(fixture.workspacePath, ["commit", "-m", "test: delta base"]);
    const baseCommit = await gitOutput(fixture.workspacePath, ["rev-parse", "HEAD"]);
    const after = Buffer.from(before);
    const changedByte = after.byteLength / 2;
    after[changedByte] = (after[changedByte] ?? 0) ^ 0xff;
    await writeFile(filePath, after);
    const patch = `${await gitOutput(fixture.workspacePath, [
      "diff",
      "--binary",
      baseCommit,
      "--",
      relativePath,
    ])}\n\n`;
    expect(patch.match(/^delta [0-9]+$/gm)).toHaveLength(2);

    await expect(assertGitPatchBlobsSecretSafe({
      workspacePath: fixture.workspacePath,
      baseCommit,
      patch,
      changedPaths: [relativePath],
      tempRootDir: join(fixture.root, "scanner-temp"),
      maxFileBytes: 32 * 1024,
      maxTotalFileBytes: 64 * 1024,
      opaqueContentPolicy: OpaqueSecretDetectionPolicy.ScanKnownSignatures,
    })).resolves.toBe(64 * 1024);
  });

  it("rejects an oversized expanded binary before materializing patch objects", async () => {
    const fixture = await createFixture();
    const patchPath = join(fixture.root, "oversized-binary.patch");
    const tempRootDir = join(fixture.root, "scanner-temp-not-created");
    await writeFile(patchPath, [
      "diff --git a/huge.bin b/huge.bin",
      "new file mode 100644",
      "GIT binary patch",
      "literal 1048577",
      "HcmV?d00001",
      "",
    ].join("\n"));

    await expect(assertGitPatchBlobsSecretSafe({
      workspacePath: fixture.workspacePath,
      baseCommit: fixture.baseCommit,
      patchPath,
      changedPaths: ["huge.bin"],
      tempRootDir,
      maxFileBytes: 1024 * 1024,
    })).rejects.toThrow("git_patch_secret_file_limit_exceeded");

    await expect(lstat(tempRootDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["forward", "reverse"] as const)(
    "rejects an oversized reconstructed %s delta target before Git parses it",
    async (position) => {
      const fixture = await createFixture();
      const patchPath = join(fixture.root, `oversized-${position}-delta.patch`);
      const tempRootDir = join(fixture.root, `delta-${position}-temp-not-created`);
      const delta = binaryHunk(
        "delta",
        Buffer.concat([encodeDeltaSize(8), encodeDeltaSize(1025)]),
      );
      const literal = binaryHunk("literal", Buffer.from("fixture\n"));
      await writeFile(patchPath, [
        "diff --git a/README.md b/README.md",
        "GIT binary patch",
        ...(position === "forward"
          ? [delta, "", literal]
          : [literal, "", delta]),
        "",
      ].join("\n"));

      await expect(assertGitPatchBlobsSecretSafe({
        workspacePath: fixture.workspacePath,
        baseCommit: fixture.baseCommit,
        patchPath,
        changedPaths: ["README.md"],
        tempRootDir,
        maxFileBytes: 1024,
      })).rejects.toThrow("git_patch_secret_file_limit_exceeded");

      await expect(lstat(tempRootDir)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects a reconstructed delta target above the aggregate limit", async () => {
    const fixture = await createFixture();
    const patchPath = join(fixture.root, "oversized-total-delta.patch");
    const tempRootDir = join(fixture.root, "delta-total-temp-not-created");
    const delta = binaryHunk(
      "delta",
      Buffer.concat([encodeDeltaSize(8), encodeDeltaSize(1025)]),
    );
    await writeFile(patchPath, [
      "diff --git a/README.md b/README.md",
      "GIT binary patch",
      delta,
      "",
    ].join("\n"));

    await expect(assertGitPatchBlobsSecretSafe({
      workspacePath: fixture.workspacePath,
      baseCommit: fixture.baseCommit,
      patchPath,
      changedPaths: ["README.md"],
      tempRootDir,
      maxFileBytes: 2048,
      maxTotalFileBytes: 1024,
    })).rejects.toThrow("git_patch_secret_total_limit_exceeded");
    await expect(lstat(tempRootDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["replacement", "symlink", "growth"] as const)(
    "feeds Git the exact preflight snapshot after pathname %s",
    async (mutation) => {
      const fixture = await createFixture();
      const safePath = "safe-snapshot.txt";
      const hostilePath = "hostile-snapshot.txt";
      await writeFile(join(fixture.workspacePath, safePath), "safe\n");
      await writeFile(join(fixture.workspacePath, hostilePath), "hostile\n");
      const safePatch = ensureTrailingNewline(await gitOutput(
        fixture.workspacePath,
        ["diff", "--binary", "--no-index", "--", "/dev/null", safePath],
        true,
      ));
      const hostilePatch = ensureTrailingNewline(await gitOutput(
        fixture.workspacePath,
        ["diff", "--binary", "--no-index", "--", "/dev/null", hostilePath],
        true,
      ));
      const patchPath = join(fixture.root, "stable.patch");
      const hostilePatchPath = join(fixture.root, "hostile.patch");
      await writeFile(patchPath, safePatch);
      await writeFile(hostilePatchPath, hostilePatch);

      await expect(assertGitPatchBlobsSecretSafe({
        workspacePath: fixture.workspacePath,
        baseCommit: fixture.baseCommit,
        patchPath,
        changedPaths: [safePath],
        tempRootDir: join(fixture.root, "scanner-temp"),
        testHooks: {
          afterPatchPreflight: async () => {
            if (mutation === "replacement") {
              await rename(hostilePatchPath, patchPath);
              return;
            }
            if (mutation === "symlink") {
              await rm(patchPath);
              await symlink(hostilePatchPath, patchPath);
              return;
            }
            await appendFile(patchPath, hostilePatch);
          },
        },
      })).resolves.toBe(5);
    },
  );

  it("rejects a patch-path symlink before creating validation state", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspacePath, "safe.txt"), "safe\n");
    const realPatchPath = join(fixture.root, "real.patch");
    const patchPath = join(fixture.root, "linked.patch");
    const tempRootDir = join(fixture.root, "symlink-temp-not-created");
    await writeFile(realPatchPath, ensureTrailingNewline(await gitOutput(
      fixture.workspacePath,
      ["diff", "--binary", "--no-index", "--", "/dev/null", "safe.txt"],
      true,
    )));
    await symlink(realPatchPath, patchPath);

    await expect(assertGitPatchBlobsSecretSafe({
      workspacePath: fixture.workspacePath,
      baseCommit: fixture.baseCommit,
      patchPath,
      changedPaths: ["safe.txt"],
      tempRootDir,
    })).rejects.toThrow("git_patch_secret_patch_unreadable");
    await expect(lstat(tempRootDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

const gitBase85Alphabet =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";

function binaryHunk(kind: "literal" | "delta", bytes: Buffer): string {
  return `${kind} ${bytes.byteLength}\n${encodeGitBase85(deflateSync(bytes))}`;
}

function encodeGitBase85(bytes: Buffer): string {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 52) {
    const line = bytes.subarray(offset, offset + 52);
    const prefix = line.byteLength <= 26
      ? String.fromCharCode(0x41 + line.byteLength - 1)
      : String.fromCharCode(0x61 + line.byteLength - 27);
    let encoded = "";
    for (let blockOffset = 0; blockOffset < line.byteLength; blockOffset += 4) {
      let value = 0;
      for (let byteOffset = 0; byteOffset < 4; byteOffset += 1) {
        value = value * 256 + (line[blockOffset + byteOffset] ?? 0);
      }
      const digits = Array<string>(5);
      for (let digit = 4; digit >= 0; digit -= 1) {
        digits[digit] = gitBase85Alphabet[value % 85] as string;
        value = Math.floor(value / 85);
      }
      encoded += digits.join("");
    }
    lines.push(`${prefix}${encoded}`);
  }
  return lines.join("\n");
}

function encodeDeltaSize(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function deterministicBinary(byteLength: number): Buffer {
  const result = Buffer.allocUnsafe(byteLength);
  let state = 0x1234_5678;
  for (let index = 0; index < result.byteLength; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    result[index] = state >>> 24;
  }
  return result;
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-handoff-secret-security-"));
  cleanup.push(root);
  const workspacePath = join(root, "workspace");
  const jobRootDir = join(root, "worker-jobs", "worker-1");
  await mkdir(workspacePath, { recursive: true });
  await mkdir(jobRootDir, { recursive: true });
  await git(workspacePath, ["init"]);
  await git(workspacePath, ["config", "user.email", "test@example.com"]);
  await git(workspacePath, ["config", "user.name", "Test User"]);
  await writeFile(join(workspacePath, "README.md"), "fixture\n");
  await git(workspacePath, ["add", "README.md"]);
  await git(workspacePath, ["commit", "-m", "test: fixture"]);
  const baseCommit = await gitOutput(workspacePath, ["rev-parse", "HEAD"]);
  return { root, workspacePath, jobRootDir, baseCommit };
}

async function materialize(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return await materializeCodexGoalHandoffArtifacts({
    workerJobId: "worker-1",
    taskId: "task-1",
    workspacePath: fixture.workspacePath,
    jobRootDir: fixture.jobRootDir,
    expectedBaseCommit: fixture.baseCommit,
  });
}

async function gitOutput(
  cwd: string,
  args: readonly string[],
  allowFailure = false,
): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    const result = await promisify(execFile)("git", args, {
      cwd,
      encoding: "utf8",
    });
    return result.stdout.trim();
  } catch (error) {
    if (!allowFailure) throw error;
    const output = (error as { readonly stdout?: string }).stdout;
    if (typeof output !== "string") throw error;
    return output;
  }
}
