import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readdir,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ClockPort,
  ProviderTaskTelemetry,
  SessionArtifact,
  SessionEnvelope,
  SessionStorePort,
  WorkspacePort,
} from "@vioxen/subscription-runtime/core";
import {
  sessionArtifactFromClaudeOAuth,
  validateClaudeSessionArtifact,
} from "@vioxen/subscription-runtime/provider-claude";
import type {
  ClaudeTaskEngineInput,
  ClaudeTaskExecutionEngine,
  ClaudeTaskExecutionResult,
} from "@vioxen/subscription-runtime/provider-claude";
import {
  BoundedSubscriptionWorkerPool,
  InMemoryWorkerAccountCapacityStore,
  WorkerControlService,
  accountCapacityAwareWorkerFactory,
  type SubscriptionWorker,
  type WorkerPoolScheduler,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalFileWorkerControlInboxStore } from "@vioxen/subscription-runtime/store-local-file";
import {
  FileBackendClaudeWorker,
  FileClaudeLogicalThreadStore,
  FileClaudeTranscriptBundleStore,
  FileClaudeRateLimitTelemetry,
  type ClaudeRateLimitTelemetrySnapshot,
  type ClaudeRateLimitTelemetrySource,
  type ClaudeRateLimitWindowName,
  type FileBackendClaudeWorkerJob,
  type FileBackendClaudeWorkerResult,
  type FileBackendClaudeWorkerThreadJob,
  type FileBackendClaudeWorkerThreadResult,
} from "../index";

export class RecordingClaudeEngine implements ClaudeTaskExecutionEngine {
  readonly kind = "recording-claude-engine";
  readonly capabilities = {
    supportsStreaming: false,
    supportsToolCalls: false,
    supportsUsage: true,
    supportsProviderRunId: true,
    supportsCleanup: true,
  };
  readonly records: ClaudeTaskEngineInput[] = [];

  constructor(
    private readonly options: {
      readonly outputText?: string;
      readonly throwMessage?: string;
      readonly sessionIds?: readonly string[];
      readonly writeTranscripts?: boolean;
      readonly delayMs?: number;
    } = {},
  ) {}

  async run(
    input: ClaudeTaskEngineInput,
  ): Promise<ClaudeTaskExecutionResult> {
    this.records.push(input);
    if (this.options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }
    if (this.options.throwMessage) {
      throw new Error(this.options.throwMessage);
    }
    const sessionId =
      this.options.sessionIds?.[this.records.length - 1] ??
      `session-${this.records.length}`;
    if (this.options.writeTranscripts) {
      if (!input.session.configDir) {
        throw new Error("recording_claude_config_dir_required");
      }
      await writeFakeClaudeTranscript({
        configDir: input.session.configDir,
        workspacePath: input.workspacePath,
        sessionId,
        text: input.prompt,
      });
    }
    return {
      outputText: this.options.outputText ?? "ok",
      telemetry: {
        providerRunId: `run-${this.records.length}`,
        providerSessionId: sessionId,
      } satisfies ProviderTaskTelemetry,
      warnings: [],
    };
  }

  async dispose(): Promise<void> {}
}

export class MutableClock implements ClockPort {
  private current: Date;

  constructor(initial: Date) {
    this.current = initial;
  }

  now(): Date {
    return new Date(this.current);
  }

  monotonicMs(): number {
    return this.current.getTime();
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class MutableRateLimitTelemetry implements ClaudeRateLimitTelemetrySource {
  constructor(private snapshot: ClaudeRateLimitTelemetrySnapshot | null = null) {}

  latest(): ClaudeRateLimitTelemetrySnapshot | null {
    return this.snapshot;
  }

  set(snapshot: ClaudeRateLimitTelemetrySnapshot | null): void {
    this.snapshot = snapshot;
  }
}

export class ManualScheduler implements WorkerPoolScheduler {
  private nextId = 1;
  private readonly timers = new Map<
    number,
    { readonly callback: () => void; readonly delayMs: number }
  >();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(Number(handle));
  }

  delays(): number[] {
    return Array.from(this.timers.values(), (timer) => timer.delayMs);
  }

  runNext(): void {
    const entry = this.timers.entries().next().value;
    if (!entry) {
      throw new Error("manual_scheduler_empty");
    }
    const [id, timer] = entry;
    this.timers.delete(id);
    timer.callback();
  }
}

export class FixedWorkspace implements WorkspacePort {
  readonly workspaceId = "fixed-workspace";
  readonly capabilities = {
    workspaceId: this.workspaceId,
    supportsTempDir: false,
    supportsExistingCheckout: true,
    supportsContainer: false,
  };

  constructor(private readonly workspacePath: string) {}

  async create() {
    await mkdir(this.workspacePath, { recursive: true, mode: 0o700 });
    return { path: this.workspacePath };
  }
}

export class StaleOnceSessionStore implements SessionStorePort {
  readonly storeId = "stale-once-session-store";
  readonly custody = "local-only" as const;
  readonly capabilities = {
    storeId: this.storeId,
    custody: this.custody,
    supportsRead: true,
    supportsWriteback: true,
    supportsCompareAndSwap: true,
    supportsIdempotency: false,
    supportsDelete: false,
    supportsAuditLog: false,
    supportsMetadataOnlyHealthCheck: false,
    plaintextAvailableToBackend: true,
    maxArtifactBytes: 256_000,
  };
  writeCount = 0;
  current: SessionEnvelope;

  constructor(
    providerInstanceId: string,
    artifact: SessionArtifact,
  ) {
    this.current = {
      providerInstanceId,
      providerId: "claude",
      artifact,
      generation: 1,
      generationHash: "generation-1",
      storageVersion: "stale-once-session-store-v1",
      custody: this.custody,
      metadata: {},
    };
  }

  async read(input: {
    readonly providerInstanceId: string;
    readonly expectedProviderId?: string;
  }): Promise<SessionEnvelope | null> {
    if (input.providerInstanceId !== this.current.providerInstanceId) {
      return null;
    }
    if (
      input.expectedProviderId &&
      input.expectedProviderId !== this.current.providerId
    ) {
      return null;
    }
    return this.current;
  }

  async write(input: {
    readonly providerInstanceId: string;
    readonly expectedGeneration: number;
    readonly nextArtifact: SessionArtifact;
  }) {
    this.writeCount += 1;
    if (this.writeCount === 1) {
      this.current = {
        ...this.current,
        generation: this.current.generation + 1,
        generationHash: "generation-2",
      };
      return {
        status: "stale_generation" as const,
        currentGeneration: this.current.generation,
        currentGenerationHash: this.current.generationHash,
      };
    }

    this.current = {
      ...this.current,
      providerInstanceId: input.providerInstanceId,
      artifact: input.nextArtifact,
      generation: input.expectedGeneration + 1,
      generationHash: "generation-3",
    };
    return {
      status: "accepted" as const,
      generation: this.current.generation,
      generationHash: this.current.generationHash,
    };
  }
}

export function rateLimitSnapshot(
  observedAt: Date,
  windows: Partial<
    Record<
      ClaudeRateLimitWindowName,
      { readonly usedPercentage: number; readonly resetsAt: Date }
    >
  >,
): ClaudeRateLimitTelemetrySnapshot {
  return {
    observedAt,
    windows: Object.fromEntries(
      Object.entries(windows).map(([name, window]) => [
        name,
        {
          usedPercentage: window!.usedPercentage,
          remainingPercentage: Math.max(0, 100 - window!.usedPercentage),
          resetsAt: window!.resetsAt,
        },
      ]),
    ) as ClaudeRateLimitTelemetrySnapshot["windows"],
  };
}

export async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "subscription-runtime-claude-worker-"));
}

export function hashStringForTest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

export async function transcriptBundleIds(rootDir: string): Promise<readonly string[]> {
  try {
    return (await readdir(join(rootDir, "claude-transcript-bundles", "bundles"))).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function encryptionKey(): Uint8Array {
  return new Uint8Array(32).fill(7);
}

export async function writeFakeClaudeTranscript(input: {
  readonly configDir: string;
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly text: string;
}): Promise<void> {
  const path = fakeClaudeTranscriptPath(
    input.configDir,
    input.workspacePath,
    input.sessionId,
  );
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await mkdir(input.workspacePath, { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    `${JSON.stringify({
      type: "assistant",
      sessionId: input.sessionId,
      text: input.text,
    })}\n`,
    "utf8",
  );
}

export function fakeClaudeTranscriptPath(
  configDir: string,
  workspacePath: string,
  sessionId: string,
): string {
  return join(configDir, "projects", fakeClaudeProjectKey(workspacePath), `${sessionId}.jsonl`);
}

export function fakeClaudeProjectKey(workspacePath: string): string {
  return workspacePath.replace(/[^A-Za-z0-9]/gu, "-");
}
