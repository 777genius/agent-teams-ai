import { execPath } from "node:process";
import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { GitHubActionRunner, githubActionRunnerManifest } from "../index";

describe("GitHub Action runner adapter", () => {
  it("declares a runner manifest", () => {
    expect(githubActionRunnerManifest).toMatchObject({
      adapterId: "runner.github-action",
      adapterKind: "runner",
    });
    expect(githubActionRunnerManifest.capabilities.supportsEnvAllowlist).toBe(
      true,
    );
  });

  it("runs a process with explicit args and redacts captured output", async () => {
    const redactor = new DefaultRedactor();
    redactor.registerSecret("super-secret", "unit");
    const stdout: string[] = [];
    const runner = new GitHubActionRunner({ redactor });

    const result = await runner.run({
      command: "/bin/sh",
      args: ["-c", "printf '%s' 'hello super-secret access_token=abc123'"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 30_000,
      stdout: { write: (chunk) => stdout.push(String(chunk)) },
      abortSignal: new AbortController().signal,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[redacted:unit]");
    expect(result.stdout).toContain("access_token=[redacted:token-field]");
    expect(stdout.join("")).not.toContain("super-secret");
  });

  it("fails closed on timeout", async () => {
    const runner = new GitHubActionRunner();

    await expect(
      runner.run({
        command: execPath,
        args: ["-e", "setTimeout(() => {}, 10000)"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 10,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("process_timeout");
  });

  it("force-kills timed-out work that ignores SIGTERM", async () => {
    const runner = new GitHubActionRunner({ killGraceMs: 25 });

    await expect(
      runner.run({
        command: execPath,
        args: [
          "-e",
          [
            "process.on('SIGTERM', () => {});",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 10,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("process_timeout");
  });

  it("fails closed when stdout sink writes fail", async () => {
    const runner = new GitHubActionRunner({ killGraceMs: 25 });

    await expect(
      runner.run({
        command: "/bin/sh",
        args: ["-c", "printf '%s' 'chunk'; exec sleep 30"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 30_000,
        stdout: {
          write: () => {
            throw new Error("sink exploded");
          },
        },
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("process_output_sink_failed:stdout:sink exploded");
  });

  it("fails closed when stderr sink writes fail", async () => {
    const runner = new GitHubActionRunner({ killGraceMs: 25 });

    await expect(
      runner.run({
        command: "/bin/sh",
        args: ["-c", "printf '%s' 'chunk' >&2; exec sleep 30"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 30_000,
        stderr: {
          write: () => {
            throw new Error("sink exploded");
          },
        },
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("process_output_sink_failed:stderr:sink exploded");
  });

  it("fails closed when stdin stream writes fail", async () => {
    const runner = new GitHubActionRunner({ killGraceMs: 25 });

    await expect(
      runner.run({
        command: execPath,
        args: [
          "-e",
          [
            "require('node:fs').closeSync(0);",
            "process.on('SIGTERM', () => {});",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 30_000,
        stdin: Buffer.alloc(16 * 1024 * 1024),
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow(/process_stdin_failed:.*(EPIPE|broken pipe)/i);
  });

  it("rejects forbidden host auth env before spawning a child process", async () => {
    const runner = new GitHubActionRunner();

    await expect(
      runner.run({
        command: execPath,
        args: ["-e", "process.exit(0)"],
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? "",
          GITHUB_TOKEN: "must-not-pass",
        },
        timeoutMs: 30_000,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("runner_forbidden_env:GITHUB_TOKEN");
  });
});
