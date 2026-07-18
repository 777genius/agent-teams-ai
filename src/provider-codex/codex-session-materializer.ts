import type {
  RedactorPort,
  SessionArtifact,
} from "@vioxen/subscription-runtime/core";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  codexAuthJsonFromArtifact,
  sessionArtifactFromCodexAuthJson,
} from "./codex-auth-json-codec";
import { cleanupCodexRuntimeTempRoot } from "./codex-cli-temp-cleanup";
import { createCodexRuntimeTempRoot } from "./codex-runtime-temp";
import {
  codexProviderEgressConfigToml,
  codexProviderEgressEnv,
} from "./codex-provider-egress-policy";
import type { CodexMaterializedSession } from "./codex-json-execution-engine";

export type CodexSessionPrewarmResult = {
  readonly mode: "ephemeral" | "worker-cache";
  readonly home: string;
  readonly codexHome: string;
  readonly sessionHash: string;
  readonly reusable: boolean;
  readonly engine?: {
    readonly kind: string;
    readonly reusable: boolean;
  };
  readonly warmedAt: Date;
  readonly warnings?: readonly {
    readonly code: string;
    readonly safeMessage: string;
  }[];
};

export type CodexSessionMaterializer = {
  readonly mode: "ephemeral" | "worker-cache";
  materialize(input: {
    readonly session: SessionArtifact;
    readonly redactor: RedactorPort;
  }): Promise<CodexMaterializedSession>;
  prewarm?(input: {
    readonly session: SessionArtifact;
    readonly redactor: RedactorPort;
  }): Promise<CodexSessionPrewarmResult>;
  dispose?(): Promise<void>;
};

export class CodexEphemeralSessionMaterializer implements CodexSessionMaterializer {
  readonly mode = "ephemeral" as const;

  async materialize(input: {
    readonly session: SessionArtifact;
    readonly redactor: RedactorPort;
  }): Promise<CodexMaterializedSession> {
    const authJson = codexAuthJsonFromArtifact(input.session);
    input.redactor.registerSecret(authJson, "codex-auth-json");

    const tempRoot = await createCodexRuntimeTempRoot({
      prefix: "subscription-runtime-codex-",
    });
    const home = join(tempRoot, "home");
    const codexHome = join(tempRoot, "codex-home");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await writeCodexJsonHomeSnapshot({ codexHome, authJson });

    return {
      home,
      codexHome,
      sessionHash: sessionArtifactHash(input.session),
      env: {
        HOME: home,
        CODEX_HOME: codexHome,
        ...codexProviderEgressEnv(),
      },
      snapshotSession: () => snapshotCodexSession({ codexHome }),
      release: once(async () => {
        try {
          await cleanupCodexRuntimeTempRoot({
            tempRoot,
            tempCodexHome: codexHome,
          });
        } catch {
          await rm(tempRoot, { recursive: true, force: true });
        }
      }),
    };
  }

  async prewarm(input: {
    readonly session: SessionArtifact;
    readonly redactor: RedactorPort;
  }): Promise<CodexSessionPrewarmResult> {
    const materialized = await this.materialize(input);
    try {
      return {
        mode: this.mode,
        home: materialized.home,
        codexHome: materialized.codexHome,
        sessionHash: sessionArtifactHash(input.session),
        reusable: false,
        warmedAt: new Date(),
      };
    } finally {
      await materialized.release();
    }
  }
}

export type CodexWorkerCacheSessionMaterializerOptions = {
  /**
   * Host-owned stable scope, for example
   * `provider-account:${accountId}:slot:${slot}`.
   *
   * Use one materializer per worker slot. A single materializer serializes
   * access to its CODEX_HOME to avoid concurrent auth.json rewrites.
   */
  readonly cacheKey: string;
  /**
   * Parent directory for cache entries. If omitted, a process-local temp
   * directory is created and removed on dispose.
   */
  readonly rootDir?: string;
  /**
   * Keep the cache directory on dispose. Useful only for local debugging; host
   * apps should normally let durable storage own the real session.
   */
  readonly preserveOnDispose?: boolean;
};

type WorkerCacheEntry = {
  readonly cacheRoot: string;
  readonly home: string;
  readonly codexHome: string;
  sessionHash: string | null;
  initialized: boolean;
};

export class CodexWorkerCacheSessionMaterializer implements CodexSessionMaterializer {
  readonly mode = "worker-cache" as const;
  private readonly cacheKeyHash: string;
  private entry: WorkerCacheEntry | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: CodexWorkerCacheSessionMaterializerOptions,
  ) {
    if (!options.cacheKey.trim()) {
      throw new Error("codex_worker_cache_key_required");
    }
    this.cacheKeyHash = stableHash(options.cacheKey).slice(0, 32);
  }

  async materialize(input: {
    readonly session: SessionArtifact;
    readonly redactor: RedactorPort;
  }): Promise<CodexMaterializedSession> {
    const releaseLock = await this.acquireExclusiveUse();
    let released = false;
    try {
      const entry = await this.ensureEntry(input);
      return {
        home: entry.home,
        codexHome: entry.codexHome,
        sessionHash: entry.sessionHash ?? sessionArtifactHash(input.session),
        env: {
          HOME: entry.home,
          CODEX_HOME: entry.codexHome,
          ...codexProviderEgressEnv(),
        },
        snapshotSession: () =>
          snapshotCodexSession({ codexHome: entry.codexHome }),
        release: once(async () => {
          released = true;
          releaseLock();
        }),
      };
    } catch (error) {
      if (!released) releaseLock();
      throw error;
    }
  }

  async prewarm(input: {
    readonly session: SessionArtifact;
    readonly redactor: RedactorPort;
  }): Promise<CodexSessionPrewarmResult> {
    const materialized = await this.materialize(input);
    try {
      return {
        mode: this.mode,
        home: materialized.home,
        codexHome: materialized.codexHome,
        sessionHash: sessionArtifactHash(input.session),
        reusable: true,
        warmedAt: new Date(),
      };
    } finally {
      await materialized.release();
    }
  }

  async dispose(): Promise<void> {
    const releaseLock = await this.acquireExclusiveUse();
    try {
      if (!this.entry || this.options.preserveOnDispose) return;
      await rm(this.entry.cacheRoot, { recursive: true, force: true });
      this.entry = null;
    } finally {
      releaseLock();
    }
  }

  private async ensureEntry(input: {
    readonly session: SessionArtifact;
    readonly redactor: RedactorPort;
  }): Promise<WorkerCacheEntry> {
    const authJson = codexAuthJsonFromArtifact(input.session);
    input.redactor.registerSecret(authJson, "codex-auth-json");
    const sessionHash = sessionArtifactHash(input.session);

    const entry = this.entry ?? (await this.createEntry());
    if (!entry.initialized) {
      await mkdir(entry.home, { recursive: true, mode: 0o700 });
      await mkdir(entry.codexHome, { recursive: true, mode: 0o700 });
      await writeCodexJsonHomeSnapshot({
        codexHome: entry.codexHome,
        authJson,
      });
      entry.sessionHash = sessionHash;
      entry.initialized = true;
      return entry;
    }

    await writeCodexJsonConfig({ codexHome: entry.codexHome });

    if (entry.sessionHash !== sessionHash) {
      await writeCodexAuthJson({
        codexHome: entry.codexHome,
        authJson,
      });
      entry.sessionHash = sessionHash;
    }
    return entry;
  }

  private async createEntry(): Promise<WorkerCacheEntry> {
    const cacheRoot = this.options.rootDir
      ? join(this.options.rootDir, `codex-${this.cacheKeyHash}`)
      : await createCodexRuntimeTempRoot({
          prefix: "subscription-runtime-codex-cache-",
        });
    const entry = {
      cacheRoot,
      home: join(cacheRoot, "home"),
      codexHome: join(cacheRoot, "codex-home"),
      sessionHash: null,
      initialized: false,
    };
    this.entry = entry;
    return entry;
  }

  private async acquireExclusiveUse(): Promise<() => void> {
    const previous = this.tail;
    let releaseNext!: () => void;
    this.tail = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    await previous;
    return onceSync(releaseNext);
  }
}

export type CodexWorkerCacheSessionPoolMaterializerOptions = {
  /**
   * Host-owned stable scope, for example `provider-account:${accountId}`.
   * The pool appends a deterministic slot suffix.
   */
  readonly cacheKey: string;
  /**
   * Number of reusable CODEX_HOME slots.
   *
   * Use this together with an app-server engine pool. One slot should handle
   * one active turn at a time unless a higher-level load test proves otherwise.
   */
  readonly slots: number;
  readonly rootDir?: string;
  readonly preserveOnDispose?: boolean;
};

export class CodexWorkerCacheSessionPoolMaterializer implements CodexSessionMaterializer {
  readonly mode = "worker-cache" as const;
  private readonly slots: readonly CodexWorkerCacheSessionMaterializer[];
  private readonly idleSlotIndexes: number[];
  private readonly waiters: ((slotIndex: number) => void)[] = [];

  constructor(
    private readonly options: CodexWorkerCacheSessionPoolMaterializerOptions,
  ) {
    if (!options.cacheKey.trim()) {
      throw new Error("codex_worker_cache_pool_key_required");
    }
    if (!Number.isInteger(options.slots) || options.slots < 1) {
      throw new Error("codex_worker_cache_pool_slots_invalid");
    }

    this.slots = Array.from({ length: options.slots }, (_, index) => {
      return new CodexWorkerCacheSessionMaterializer({
        cacheKey: `${options.cacheKey}:slot:${index + 1}`,
        ...(options.rootDir ? { rootDir: options.rootDir } : {}),
        ...(options.preserveOnDispose !== undefined
          ? { preserveOnDispose: options.preserveOnDispose }
          : {}),
      });
    });
    this.idleSlotIndexes = this.slots.map((_, index) => index);
  }

  async materialize(input: {
    readonly session: SessionArtifact;
    readonly redactor: RedactorPort;
  }): Promise<CodexMaterializedSession> {
    const slotIndex = await this.acquireSlot();
    let returnedSlot = false;
    try {
      const materialized = await this.slots[slotIndex]!.materialize(input);
      return {
        ...materialized,
        release: once(async () => {
          try {
            await materialized.release();
          } finally {
            returnedSlot = true;
            this.releaseSlot(slotIndex);
          }
        }),
      };
    } catch (error) {
      if (!returnedSlot) this.releaseSlot(slotIndex);
      throw error;
    }
  }

  async prewarm(input: {
    readonly session: SessionArtifact;
    readonly redactor: RedactorPort;
  }): Promise<CodexSessionPrewarmResult> {
    const materialized = await this.materialize(input);
    try {
      return {
        mode: this.mode,
        home: materialized.home,
        codexHome: materialized.codexHome,
        sessionHash: sessionArtifactHash(input.session),
        reusable: true,
        warmedAt: new Date(),
      };
    } finally {
      await materialized.release();
    }
  }

  async dispose(): Promise<void> {
    await Promise.all(this.slots.map((slot) => slot.dispose()));
  }

  private acquireSlot(): Promise<number> {
    const slotIndex = this.idleSlotIndexes.shift();
    if (slotIndex !== undefined) return Promise.resolve(slotIndex);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private releaseSlot(slotIndex: number): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(slotIndex);
      return;
    }
    this.idleSlotIndexes.push(slotIndex);
  }
}

export async function writeCodexJsonHomeSnapshot(input: {
  readonly codexHome: string;
  readonly authJson: string;
}): Promise<void> {
  await writeCodexJsonConfig({ codexHome: input.codexHome });
  await writeCodexAuthJson(input);
}

async function writeCodexJsonConfig(input: { readonly codexHome: string }): Promise<void> {
  await writeFileAtomic(join(input.codexHome, "config.toml"), codexJsonHomeConfigToml());
}

export async function writeCodexAuthJson(input: {
  readonly codexHome: string;
  readonly authJson: string;
}): Promise<void> {
  await writeFileAtomic(join(input.codexHome, "auth.json"), input.authJson);
}

async function snapshotCodexSession(input: {
  readonly codexHome: string;
}): Promise<SessionArtifact> {
  const authJson = await readFile(join(input.codexHome, "auth.json"), "utf8");
  return sessionArtifactFromCodexAuthJson(authJson);
}

function codexJsonHomeConfigToml(): string {
  return [
    'cli_auth_credentials_store = "file"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    "disable_response_storage = true",
    'model_verbosity = "low"',
    "",
    "[features]",
    "apps = false",
    "hooks = false",
    "memories = false",
    "multi_agent = false",
    "shell_snapshot = false",
    "skill_mcp_dependency_install = false",
    "",
    "[history]",
    'persistence = "none"',
    "",
    "[otel]",
    'exporter = "none"',
    'metrics_exporter = "none"',
    'trace_exporter = "none"',
    "log_user_prompt = false",
    "",
    "[shell_environment_policy]",
    'inherit = "none"',
    'include_only = ["PATH", "HOME", "CI", "CODEX_HOME"]',
    "",
    codexProviderEgressConfigToml(),
  ].join("\n");
}

export function sessionArtifactHash(session: SessionArtifact): string {
  return stableHash(new TextDecoder().decode(session.bytes));
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeFileAtomic(path: string, value: string): Promise<void> {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, value, { mode: 0o600 });
  await rename(tempPath, path);
}

function once<T>(fn: () => Promise<T>): () => Promise<T | undefined> {
  let called = false;
  return async () => {
    if (called) return undefined;
    called = true;
    return fn();
  };
}

function onceSync(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}
