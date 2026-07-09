import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execPath } from "node:process";
import { promisify } from "node:util";
import type {
  ObservabilityPort,
  RuntimeEvent,
  RuntimeMetric,
  RunnerPort,
  WorkspacePort,
} from "@vioxen/subscription-runtime/core";
import {
  AccessBoundary,
  BoundedSubscriptionWorkerPool,
  InMemoryActiveAttemptRegistry,
  InMemoryWorkerAccountCapacityStore,
  InterruptAndContinueWorkerUseCase,
  LaunchPlanStatus,
  WorkerControlService,
  accountCapacityAwareWorkerFactory,
  buildLaunchPlan,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalFileWorkerControlInboxStore } from "@vioxen/subscription-runtime/store-local-file";
import { describe, expect, it } from "vitest";
import {
  CommandPolicyRunner,
  FileBackendCodexSafeExecutor,
  FileBackendCodexWorker,
} from "../index";
import { NodeProcessRunner } from "../node-process-runner";

describe("NodeProcessRunner", () => {
  it("rejects non-zero process exits with a safe error", async () => {
    const runner = new NodeProcessRunner();

    await expect(
      runner.run({
        command: execPath,
        args: ["-e", "process.stderr.write('bad exit'); process.exit(7)"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 30_000,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("node_process_runner_failed:7:bad exit");
  });

  it("rejects timed-out work even when the process exits zero after SIGTERM", async () => {
    const runner = new NodeProcessRunner({ killGraceMs: 500 });

    await expect(
      runner.run({
        command: execPath,
        args: [
          "-e",
          [
            "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 20));",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 50,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("node_process_runner_timeout:50");
  });

  it("terminates a process when stdin stream writes fail", async () => {
    const runner = new NodeProcessRunner({ killGraceMs: 25 });

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
        stdin: Buffer.alloc(16 * 1024 * 1024),
        timeoutMs: 30_000,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow(/EPIPE|broken pipe/i);
  });

  it("keeps non-zero process output when stdin also breaks", async () => {
    const runner = new NodeProcessRunner({ killGraceMs: 25 });

    await expect(
      runner.run({
        command: execPath,
        args: ["-e", "process.stderr.write('bad exit'); process.exit(7);"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        stdin: Buffer.alloc(16 * 1024 * 1024),
        timeoutMs: 30_000,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("node_process_runner_failed:7:bad exit");
  });

  it("keeps timeout classification when shutdown also breaks stdin", async () => {
    const runner = new NodeProcessRunner({ killGraceMs: 500 });

    await expect(
      runner.run({
        command: execPath,
        args: [
          "-e",
          [
            "process.on('SIGTERM', () => {",
            "  try { require('node:fs').closeSync(0); } catch {}",
            "  setTimeout(() => process.exit(0), 20);",
            "});",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        stdin: Buffer.alloc(16 * 1024 * 1024),
        timeoutMs: 50,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("node_process_runner_timeout:50");
  });

  it("terminates a process when stdout sink writes fail", async () => {
    const runner = new NodeProcessRunner({ killGraceMs: 25 });

    await expect(
      runner.run({
        command: execPath,
        args: [
          "-e",
          [
            "process.stdout.write('chunk');",
            "process.on('SIGTERM', () => {});",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        stdout: {
          write: () => {
            throw new Error("sink exploded");
          },
        },
        timeoutMs: 30_000,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      "node_process_runner_output_sink_failed:stdout:sink exploded",
    );
  });

  it("keeps output sink classification when abort fires during shutdown", async () => {
    const runner = new NodeProcessRunner({ killGraceMs: 25 });
    const controller = new AbortController();

    await expect(
      runner.run({
        command: execPath,
        args: [
          "-e",
          [
            "process.stdout.write('chunk');",
            "process.on('SIGTERM', () => {});",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        stdout: {
          write: () => {
            queueMicrotask(() => controller.abort());
            throw new Error("sink exploded");
          },
        },
        timeoutMs: 30_000,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow(
      "node_process_runner_output_sink_failed:stdout:sink exploded",
    );
  });

  it("terminates a process when stderr sink writes fail", async () => {
    const runner = new NodeProcessRunner({ killGraceMs: 25 });

    await expect(
      runner.run({
        command: execPath,
        args: [
          "-e",
          [
            "process.stderr.write('chunk');",
            "process.on('SIGTERM', () => {});",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        stderr: {
          write: () => {
            throw new Error("sink exploded");
          },
        },
        timeoutMs: 30_000,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      "node_process_runner_output_sink_failed:stderr:sink exploded",
    );
  });

  it("does not spawn work for an already-aborted signal", async () => {
    const runner = new NodeProcessRunner();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runner.run({
        command: "/path/that/must/not/spawn",
        args: [],
        cwd: process.cwd(),
        env: {},
        timeoutMs: 1_000,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("node_process_runner_aborted");
  });
});
