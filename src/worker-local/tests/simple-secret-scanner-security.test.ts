import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { SecretScanStatus } from "@vioxen/subscription-runtime/worker-core";
import { readGitBlobBatch } from "../git-blob-batch-reader";
import { SimpleSecretScanner } from "../project-integration-local-adapters";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

describe("SimpleSecretScanner security", () => {
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ));
  });

  it("keeps configured scanner patterns authoritative in fixture files", async () => {
    const workspacePath = await createGitFixture();
    const relativePath = "src/config.fixture.ts";
    const configuredLiteral = ["test-", "fixture-literal"].join("");
    await writeFile(
      join(workspacePath, relativePath),
      ["API_", "KEY=", configuredLiteral, "\n"].join(""),
      "utf8",
    );
    const scanner = new SimpleSecretScanner({
      patterns: [new RegExp(["test-", "fixture"].join(""), "g")],
    });

    await expect(scanner.scanFiles({
      workspacePath,
      files: [relativePath],
    })).resolves.toEqual({
      status: SecretScanStatus.Failed,
      safeMessage: `secret_like_content:${relativePath}`,
    });
  });

  it("allows only exact fixture literals at explicit context boundaries", async () => {
    const workspacePath = await createGitFixture();
    const fixturePath = "src/allowed.fixture.ts";
    const productionPath = "src/fixtures-adjacent/config.ts";
    const content = ["API_", "KEY=", "test-", "fixture-literal", "\n"].join("");
    await mkdir(join(workspacePath, "src", "fixtures-adjacent"));
    await writeFile(join(workspacePath, fixturePath), content, "utf8");
    await writeFile(join(workspacePath, productionPath), content, "utf8");
    const scanner = new SimpleSecretScanner();

    await expect(scanner.scanFiles({
      workspacePath,
      files: [fixturePath],
    })).resolves.toEqual({ status: SecretScanStatus.Passed });
    await expect(scanner.scanFiles({
      workspacePath,
      files: [productionPath],
    })).resolves.toEqual({
      status: SecretScanStatus.Failed,
      safeMessage: `secret_like_content:${productionPath}`,
    });
  });

  it("scans a deleted binary preimage and reports only its path", async () => {
    const workspacePath = await createGitFixture();
    const relativePath = "src/deleted.bin";
    const filePath = join(workspacePath, relativePath);
    const providerShapedBytes = Buffer.concat([
      Buffer.from([0x00, 0x01]),
      Buffer.from([["s", "k", "-"].join(""), "q".repeat(24)].join("")),
      Buffer.from([0xff]),
    ]);
    await writeFile(filePath, providerShapedBytes);
    await git(workspacePath, ["add", relativePath]);
    await git(workspacePath, ["commit", "-m", "test: add binary fixture"]);
    await rm(filePath);
    const scanner = new SimpleSecretScanner();

    await expect(scanner.scanFiles({
      workspacePath,
      files: [relativePath],
    })).resolves.toEqual({
      status: SecretScanStatus.Failed,
      safeMessage: `secret_like_content:${relativePath}`,
    });
  });

  it("fails closed on opaque current content", async () => {
    const workspacePath = await createGitFixture();
    const relativePath = "src/opaque.bin";
    await writeFile(
      join(workspacePath, relativePath),
      Buffer.from([0x00, 0xff, 0x01, 0x02]),
    );
    const scanner = new SimpleSecretScanner();

    await expect(scanner.scanFiles({
      workspacePath,
      files: [relativePath],
    })).resolves.toEqual({
      status: SecretScanStatus.Failed,
      safeMessage: `secret_like_content:${relativePath}`,
    });
  });

  it("rejects non-regular current paths before attempting a read", async () => {
    const workspacePath = await createGitFixture();
    await writeFile(join(workspacePath, "src", "target.ts"), "safe content\n");
    await symlink("target.ts", join(workspacePath, "src", "linked.ts"));
    await mkdir(join(workspacePath, "src", "directory.ts"));
    const scanner = new SimpleSecretScanner();

    for (const relativePath of ["src/linked.ts", "src/directory.ts"]) {
      await expect(scanner.scanFiles({
        workspacePath,
        files: [relativePath],
      })).resolves.toEqual({
        status: SecretScanStatus.Failed,
        safeMessage: `secret_scan_unreadable_file:${relativePath}`,
      });
    }
  });

  it("rejects an oversized current file from metadata before reading it", async () => {
    const workspacePath = await createGitFixture();
    const relativePath = "src/oversized.ts";
    await writeFile(join(workspacePath, relativePath), "x".repeat(65));

    await expect(new SimpleSecretScanner({ maxFileBytes: 64 }).scanFiles({
      workspacePath,
      files: [relativePath],
    })).resolves.toEqual({
      status: SecretScanStatus.Failed,
      safeMessage: `secret_scan_file_too_large:${relativePath}`,
    });
  });

  it("enforces the remaining aggregate current-file budget before allocation", async () => {
    const workspacePath = await createGitFixture();
    await writeFile(join(workspacePath, "src", "first.txt"), "a".repeat(40));
    await writeFile(join(workspacePath, "src", "second.txt"), "b".repeat(40));

    await expect(new SimpleSecretScanner({
      maxFileBytes: 64,
      maxTotalFileBytes: 64,
    }).scanFiles({
      workspacePath,
      files: ["src/first.txt", "src/second.txt"],
    })).resolves.toEqual({
      status: SecretScanStatus.Failed,
      safeMessage: "secret_scan_total_file_bytes_exceeded",
    });
  });

  it("deduplicates paths, caps unique paths, and validates maxFileBytes", async () => {
    const workspacePath = await createGitFixture();
    await expect(new SimpleSecretScanner().scanFiles({
      workspacePath,
      files: Array.from({ length: 300 }, () => "README.md"),
    })).resolves.toEqual({ status: SecretScanStatus.Passed });

    await expect(new SimpleSecretScanner().scanFiles({
      workspacePath,
      files: Array.from({ length: 257 }, (_, index) => `src/file-${index}.ts`),
    })).resolves.toEqual({
      status: SecretScanStatus.Failed,
      safeMessage: "secret_scan_changed_file_limit_exceeded",
    });

    for (const maxFileBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(new SimpleSecretScanner({ maxFileBytes }).scanFiles({
        workspacePath,
        files: ["README.md"],
      })).rejects.toThrow("secret_scan_max_file_bytes_invalid");
    }
  });

  it("uses one bounded batch Git read for every base blob", async () => {
    const workspacePath = await createGitFixture();
    for (const name of ["one.ts", "two.ts", "three.ts"]) {
      await writeFile(join(workspacePath, "src", name), "export const before = 1;\n");
    }
    await git(workspacePath, ["add", "src"]);
    await git(workspacePath, ["commit", "-m", "test: base files"]);
    for (const name of ["one.ts", "two.ts", "three.ts"]) {
      await writeFile(join(workspacePath, "src", name), "export const after = 2;\n");
    }
    const logPath = join(workspacePath, "git-calls.log");
    const wrapperPath = join(workspacePath, "git-wrapper.sh");
    await writeFile(wrapperPath, [
      "#!/bin/sh",
      `printf '%s\\n' \"$*\" >> ${JSON.stringify(logPath)}`,
      "exec git \"$@\"",
      "",
    ].join("\n"));
    await chmod(wrapperPath, 0o700);

    await expect(new SimpleSecretScanner({
      gitBinaryPath: wrapperPath,
    }).scanFiles({
      workspacePath,
      files: ["src/one.ts", "src/two.ts", "src/three.ts"],
    })).resolves.toEqual({ status: SecretScanStatus.Passed });

    const calls = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(calls.filter((call) => call === "cat-file --batch")).toHaveLength(1);
    expect(calls.some((call) => /^cat-file (?:-s|blob) /.test(call))).toBe(false);
  });

  it("rejects a batch response that substitutes another object identity", async () => {
    const workspacePath = await createGitFixture();
    const requested = "a".repeat(40);
    const substituted = "b".repeat(40);
    const executablePath = await createBatchResponseExecutable(
      workspacePath,
      "substituted",
      `${substituted} blob 1\nX\n`,
    );

    await expect(readGitBlobBatch({
      workspacePath,
      objectNames: [requested],
      maxBlobBytes: 16,
      maxTotalBytes: 16,
      gitBinaryPath: executablePath,
    })).rejects.toThrow("git_blob_batch_output_invalid");
  });

  it("rejects reordered batch responses even when every object was requested", async () => {
    const workspacePath = await createGitFixture();
    const first = "a".repeat(40);
    const second = "b".repeat(40);
    const executablePath = await createBatchResponseExecutable(
      workspacePath,
      "reordered",
      `${second} blob 1\nB\n${first} blob 1\nA\n`,
    );

    await expect(readGitBlobBatch({
      workspacePath,
      objectNames: [first, second],
      maxBlobBytes: 16,
      maxTotalBytes: 16,
      gitBinaryPath: executablePath,
    })).rejects.toThrow("git_blob_batch_output_invalid");
  });

  it("terminates a batch child before consuming a blob over its declared limit", async () => {
    const workspacePath = await createGitFixture();
    const adversary = await createAdversarialBatchExecutable(
      workspacePath,
      "declared",
    );

    await expect(readGitBlobBatch({
      workspacePath,
      objectNames: ["a".repeat(40)],
      maxBlobBytes: 16,
      maxTotalBytes: 16,
      gitBinaryPath: adversary.executablePath,
      timeoutMs: 5_000,
    })).rejects.toThrow("git_blob_batch_blob_limit_exceeded");

    await expect(readProgress(adversary.progressPath)).resolves.toBeLessThan(65_536);
    await expect(readFile(adversary.completionPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("terminates a batch child before consuming streamed bytes past its declaration", async () => {
    const workspacePath = await createGitFixture();
    const adversary = await createAdversarialBatchExecutable(
      workspacePath,
      "streamed",
    );

    await expect(readGitBlobBatch({
      workspacePath,
      objectNames: ["a".repeat(40)],
      maxBlobBytes: 16,
      maxTotalBytes: 16,
      gitBinaryPath: adversary.executablePath,
      timeoutMs: 5_000,
    })).rejects.toThrow("git_blob_batch_output_invalid");

    await expect(readFile(adversary.streamStartPath, "utf8")).resolves.toBe("started");
    await expect(readProgress(adversary.progressPath)).resolves.toBeLessThan(65_536);
    await expect(readFile(adversary.completionPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

async function createAdversarialBatchExecutable(
  workspacePath: string,
  mode: "declared" | "streamed",
): Promise<{
  readonly executablePath: string;
  readonly progressPath: string;
  readonly streamStartPath: string;
  readonly completionPath: string;
}> {
  const executablePath = join(workspacePath, `adversarial-${mode}-git.sh`);
  const progressPath = join(workspacePath, `adversarial-${mode}-progress`);
  const streamStartPath = join(workspacePath, `adversarial-${mode}-started`);
  const completionPath = join(workspacePath, `adversarial-${mode}-complete`);
  const headerSize = mode === "declared" ? 1024 : 4;
  const initialBody = mode === "streamed" ? "ABCD" : "";
  const header = `${"a".repeat(40)} blob ${headerSize}\n${initialBody}`;
  await writeFile(executablePath, [
    "#!/bin/sh",
    "IFS= read -r request",
    `header=${shellSingleQuoted(header)}`,
    `chunk=${shellSingleQuoted("x".repeat(1024))}`,
    'printf "%s" "$header"',
    `printf started > ${shellSingleQuoted(streamStartPath)}`,
    "index=0",
    "while [ \"$index\" -lt 65536 ]; do",
    '  printf "%s" "$chunk"',
    `  printf x >> ${shellSingleQuoted(progressPath)}`,
    "  index=$((index + 1))",
    "done",
    `printf complete > ${shellSingleQuoted(completionPath)}`,
    "",
  ].join("\n"));
  await chmod(executablePath, 0o700);
  return { executablePath, progressPath, streamStartPath, completionPath };
}

async function createBatchResponseExecutable(
  workspacePath: string,
  name: string,
  response: string,
): Promise<string> {
  const executablePath = join(workspacePath, `batch-${name}-git.sh`);
  await writeFile(executablePath, [
    "#!/bin/sh",
    "while IFS= read -r request; do :; done",
    `printf %s ${shellSingleQuoted(response)}`,
    "",
  ].join("\n"));
  await chmod(executablePath, 0o700);
  return executablePath;
}

function shellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function readProgress(path: string): Promise<number> {
  try {
    return (await readFile(path)).byteLength;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return 0;
    }
    throw error;
  }
}

async function createGitFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "simple-secret-scanner-security-"));
  cleanup.push(root);
  const workspacePath = join(root, "workspace");
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await git(workspacePath, ["init"]);
  await git(workspacePath, ["config", "user.email", "test@example.com"]);
  await git(workspacePath, ["config", "user.name", "Test User"]);
  await writeFile(join(workspacePath, "README.md"), "fixture\n");
  await git(workspacePath, ["add", "README.md"]);
  await git(workspacePath, ["commit", "-m", "test: fixture"]);
  return workspacePath;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd });
}
