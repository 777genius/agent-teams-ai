import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalFileRunEventStore } from "@vioxen/subscription-runtime/store-local-file";
import {
  RunEventProviderKind,
  RunEventType,
  makeRunEvent,
} from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalCliIo } from "../../codex-goal-cli-support";
import {
  parseCodexGoalRelayEventsCommand,
  runCodexGoalRelayEventsCommand,
} from "../cli-command";

describe("codex goal relay-events cli command", () => {
  it("parses webhook relay flags without changing the command shape", () => {
    const command = parseCodexGoalRelayEventsCommand([
      "--event-root",
      "events",
      "--consumer-id",
      "orchestrator-a",
      "--publisher",
      "webhook",
      "--webhook-url",
      "https://orchestrator.example.test/events",
      "--webhook-timeout-ms",
      "2000",
      "--limit",
      "20",
      "--run-id",
      "job-a",
      "--type",
      "run.failed,run.completed",
      "--json",
    ], fakeIo());

    expect(command).toEqual({
      kind: "relay-events",
      eventRootDir: "/tmp/events",
      consumerId: "orchestrator-a",
      publisherKind: "webhook",
      webhookUrl: "https://orchestrator.example.test/events",
      webhookTimeoutMs: 2000,
      limit: 20,
      runId: "job-a",
      types: ["run.failed", "run.completed"],
      format: "json",
    });
  });

  it("relays stdout events and advances the delivery cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-relay-events-"));
    const store = new LocalFileRunEventStore({ rootDir: root });
    await store.append([
      makeRunEvent({
        runId: "run-a",
        type: RunEventType.Completed,
        occurredAt: "2026-07-02T00:00:00.000Z",
        source: {
          providerKind: RunEventProviderKind.Codex,
        },
        idempotencyParts: ["completed"],
      }),
    ]);

    try {
      const command = parseCodexGoalRelayEventsCommand([
        "--event-root",
        root,
        "--consumer-id",
        "consumer-a",
        "--publisher",
        "stdout",
      ], fakeIo());
      const firstIo = captureIo();

      await expect(runCodexGoalRelayEventsCommand(command, firstIo)).resolves.toBe(0);
      expect(JSON.parse(firstIo.stdout.trim())).toMatchObject({
        runId: "run-a",
        type: "run.completed",
      });

      const secondIo = captureIo();
      await expect(runCodexGoalRelayEventsCommand(command, secondIo)).resolves.toBe(0);
      expect(secondIo.stdout).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function fakeIo(
  env: Readonly<Record<string, string | undefined>> = {},
): CodexGoalCliIo {
  return {
    writeStdout(): void {},
    writeStderr(): void {},
    cwd(): string {
      return "/tmp";
    },
    env(): Readonly<Record<string, string | undefined>> {
      return env;
    },
  };
}

function captureIo(): CodexGoalCliIo & { readonly stdout: string } {
  let stdout = "";
  return {
    writeStdout(chunk): void {
      stdout += chunk;
    },
    writeStderr(): void {},
    cwd(): string {
      return "/tmp";
    },
    env(): Readonly<Record<string, string | undefined>> {
      return {};
    },
    get stdout(): string {
      return stdout;
    },
  };
}
