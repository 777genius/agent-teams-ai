import { describe, expect, it } from "vitest";
import {
  DefaultRedactor,
  RuntimeConfigurationError,
  assertCompatibleRuntimeManifests,
  createAdapterRegistry,
  assertLeaseTransition,
  assertNoSessionBytesInConfig,
  assertSessionTransition,
  createSubscriptionRuntime,
  defineSubscriptionRuntimeConfig,
  negotiateCapabilities,
  type SessionFreshnessAssessment,
} from "../index";
import {
  FakeAgentDriver,
  FakeNoSessionAgentDriver,
  FakeNoSessionDriver,
  FakeProviderSessionDriver,
  FakeStaticAgentDriver,
  FakeStaticProviderSessionDriver,
  InMemorySessionStore,
  MemoryObservability,
  agentDriverContract,
  fakeAgentCapabilities,
  fakeProviderCapabilities,
  fakeNoSessionAgentCapabilities,
  fakeNoSessionProviderCapabilities,
  fakeRunnerCapabilities,
  fakeStaticAgentCapabilities,
  fakeStaticProviderCapabilities,
  fakeStoreCapabilities,
  makeFakeArtifact,
  makeFakeRuntimeDeps,
  providerSessionDriverContract,
  sessionStoreContract,
} from "../testing";

const fakeProviderManifest = {
  adapterId: "provider.fake",
  adapterKind: "combined-provider",
  packageName: "@vioxen/subscription-runtime-provider-fake",
  packageVersion: "0.0.0",
  protocolVersion: 1,
  capabilities: {
    session: fakeProviderCapabilities,
    agent: fakeAgentCapabilities,
  },
  experimental: false,
  minimumCoreVersion: "0.0.0",
} as const;

const fakeStoreManifest = {
  adapterId: "store.memory",
  adapterKind: "store",
  packageName: "@vioxen/subscription-runtime-store-memory",
  packageVersion: "0.0.0",
  protocolVersion: 1,
  capabilities: fakeStoreCapabilities,
  custody: "no-plaintext-backend",
  experimental: false,
  minimumCoreVersion: "0.0.0",
} as const;

const fakeRunnerManifest = {
  adapterId: "runner.memory",
  adapterKind: "runner",
  packageName: "@vioxen/subscription-runtime-runner-memory",
  packageVersion: "0.0.0",
  protocolVersion: 1,
  capabilities: fakeRunnerCapabilities,
  experimental: false,
  minimumCoreVersion: "0.0.0",
} as const;

describe("subscription runtime core policy", () => {
  it("accepts a no-custody provider/store/runner combination", () => {
    const decision = negotiateCapabilities({
      requested: makeFakeRuntimeDeps().policy,
      provider: fakeProviderCapabilities,
      agent: new FakeAgentDriver().capabilities,
      store: fakeStoreCapabilities,
      runner: fakeRunnerCapabilities,
    });

    expect(decision.status).toBe("accepted");
    if (decision.status === "accepted") {
      expect(decision.compiledPolicy.trustMode).toBe("no-plaintext-backend");
      expect(decision.executionPlan.kind).toBe("rotating-session");
    }
  });

  it("compiles refresh policy defaults and overrides", () => {
    const defaultDecision = negotiateCapabilities({
      requested: makeFakeRuntimeDeps().policy,
      provider: fakeProviderCapabilities,
      agent: new FakeAgentDriver().capabilities,
      store: fakeStoreCapabilities,
      runner: fakeRunnerCapabilities,
    });
    expect(defaultDecision.status).toBe("accepted");
    if (defaultDecision.status === "accepted") {
      expect(defaultDecision.compiledPolicy.refreshPolicy).toEqual({
        minFreshMs: 15 * 60 * 1000,
        refreshBeforeExpiryMs: 5 * 60 * 1000,
        maxSessionAgeMs: 24 * 60 * 60 * 1000,
      });
    }

    const overrideDecision = negotiateCapabilities({
      requested: {
        ...makeFakeRuntimeDeps().policy,
        refreshPolicy: {
          minFreshMs: 1_000,
          refreshBeforeExpiryMs: 2_000,
          maxSessionAgeMs: 3_000,
        },
      },
      provider: fakeProviderCapabilities,
      agent: new FakeAgentDriver().capabilities,
      store: fakeStoreCapabilities,
      runner: fakeRunnerCapabilities,
    });
    expect(overrideDecision.status).toBe("accepted");
    if (overrideDecision.status === "accepted") {
      expect(overrideDecision.compiledPolicy.refreshPolicy).toEqual({
        minFreshMs: 1_000,
        refreshBeforeExpiryMs: 2_000,
        maxSessionAgeMs: 3_000,
      });
    }
  });

  it("compiles a static session plan without durable writeback", () => {
    const decision = negotiateCapabilities({
      requested: {
        ...makeFakeRuntimeDeps({
          provider: new FakeStaticProviderSessionDriver(),
          agent: new FakeStaticAgentDriver(),
        }).policy,
        requireWritebackBeforeTask: false,
      },
      provider: fakeStaticProviderCapabilities,
      agent: fakeStaticAgentCapabilities,
      store: fakeStoreCapabilities,
      runner: fakeRunnerCapabilities,
    });

    expect(decision.status).toBe("accepted");
    if (decision.status === "accepted") {
      expect(decision.executionPlan).toMatchObject({
        kind: "static-session",
        refresh: "validate-only",
        writeback: "never",
      });
      expect(decision.compiledPolicy.requiresDurableWriteback).toBe(false);
      expect(decision.compiledPolicy.requiresLease).toBe(false);
    }
  });

  it("compiles a no-session plan without requiring a session store", () => {
    const decision = negotiateCapabilities({
      requested: makeFakeRuntimeDeps({
        provider: new FakeNoSessionDriver(),
        agent: new FakeNoSessionAgentDriver(),
      }).policy,
      provider: fakeNoSessionProviderCapabilities,
      agent: fakeNoSessionAgentCapabilities,
      runner: fakeRunnerCapabilities,
    });

    expect(decision.status).toBe("accepted");
    if (decision.status === "accepted") {
      expect(decision.executionPlan).toMatchObject({
        kind: "no-session",
        readSession: false,
        writeback: "never",
      });
      expect(decision.compiledPolicy.storeId).toBeNull();
      expect(decision.compiledPolicy.maxSessionBytes).toBe(0);
    }
  });

  it("rejects unsupported task and history modes before session storage checks", () => {
    const taskDecision = negotiateCapabilities({
      requested: {
        ...makeFakeRuntimeDeps().policy,
        requestedTaskMode: "health-check",
      },
      provider: fakeProviderCapabilities,
      agent: {
        ...fakeAgentCapabilities,
        taskModes: ["review"],
      },
      store: fakeStoreCapabilities,
      runner: fakeRunnerCapabilities,
    });
    expect(taskDecision).toMatchObject({
      status: "rejected",
      code: "task_mode_unsupported",
    });

    const historyDecision = negotiateCapabilities({
      requested: {
        ...makeFakeRuntimeDeps().policy,
        requestedHistoryMode: "provider-thread",
      },
      provider: fakeProviderCapabilities,
      agent: fakeAgentCapabilities,
      store: fakeStoreCapabilities,
      runner: fakeRunnerCapabilities,
    });
    expect(historyDecision).toMatchObject({
      status: "rejected",
      code: "history_mode_unsupported",
    });
  });

  it("rejects backend plaintext when policy requires no-custody", () => {
    const decision = negotiateCapabilities({
      requested: makeFakeRuntimeDeps().policy,
      provider: fakeProviderCapabilities,
      agent: new FakeAgentDriver().capabilities,
      store: {
        ...fakeStoreCapabilities,
        custody: "backend-custody",
        plaintextAvailableToBackend: true,
      },
      runner: fakeRunnerCapabilities,
    });

    expect(decision).toMatchObject({
      status: "rejected",
      code: "custody_mode_forbidden",
    });
  });

  it("rejects agent/provider mismatches before runtime construction", () => {
    const decision = negotiateCapabilities({
      requested: makeFakeRuntimeDeps().policy,
      provider: fakeProviderCapabilities,
      agent: {
        ...new FakeAgentDriver().capabilities,
        providerId: "other-provider",
      },
      store: fakeStoreCapabilities,
      runner: fakeRunnerCapabilities,
    });

    expect(decision).toMatchObject({
      status: "rejected",
      code: "provider_store_incompatible",
    });
  });
});

describe("subscription runtime adapter manifests", () => {
  it("accepts compatible no-custody manifests before runtime construction", () => {
    expect(() =>
      assertCompatibleRuntimeManifests({
        provider: fakeProviderManifest,
        store: fakeStoreManifest,
        runner: fakeRunnerManifest,
        policy: makeFakeRuntimeDeps().policy,
      }),
    ).not.toThrow();
  });

  it("rejects duplicate registry ids and incompatible manifests", () => {
    const registry = createAdapterRegistry([
      {
        manifest: fakeProviderManifest,
        create: () => new FakeProviderSessionDriver(),
      },
    ]);

    expect(registry.getManifest("provider.fake")).toMatchObject({
      adapterId: "provider.fake",
    });
    expect(() =>
      registry.register({
        manifest: fakeProviderManifest,
        create: () => new FakeProviderSessionDriver(),
      }),
    ).toThrow(RuntimeConfigurationError);

    expect(() =>
      assertCompatibleRuntimeManifests({
        provider: fakeProviderManifest,
        store: {
          ...fakeStoreManifest,
          capabilities: {
            ...fakeStoreCapabilities,
            custody: "backend-custody",
            plaintextAvailableToBackend: true,
          },
        },
        runner: fakeRunnerManifest,
        policy: makeFakeRuntimeDeps().policy,
      }),
    ).toThrow(RuntimeConfigurationError);
  });

  it("keeps runtime config declarative and rejects embedded session secrets", () => {
    expect(
      defineSubscriptionRuntimeConfig({
        custodyMode: "no-plaintext-backend",
        providers: ["provider.fake"],
      }),
    ).toMatchObject({ custodyMode: "no-plaintext-backend" });

    expect(() =>
      assertNoSessionBytesInConfig({
        provider: {
          refresh_token: "raw-refresh-token",
        },
      }),
    ).toThrow(RuntimeConfigurationError);
  });
});

describe("subscription runtime state machines", () => {
  it("allows valid session and lease transitions", () => {
    expect(() => assertSessionTransition("missing", "seeded")).not.toThrow();
    expect(() => assertLeaseTransition("requested", "granted")).not.toThrow();
  });

  it("rejects invalid session transitions", () => {
    expect(() => assertSessionTransition("active", "refreshing")).toThrow(
      "Invalid session transition",
    );
  });
});

describe("subscription runtime redaction", () => {
  it("redacts registered secrets and token-looking fields", () => {
    const redactor = new DefaultRedactor();
    redactor.registerSecret("secret-value", "unit");

    expect(redactor.redact("token=abc secret-value")).toBe(
      "token=[redacted:token-field] [redacted:unit]",
    );
    expect(() =>
      redactor.assertNoKnownSecret("leaked secret-value", "unit-test"),
    ).toThrow("Known secret leaked");
  });
});

describe("subscription runtime use cases", () => {
  it("refreshes a rotating session, writes back once, then runs the task", async () => {
    const store = new InMemorySessionStore();
    store.seed({
      providerInstanceId: "provider-instance-1",
      artifact: makeFakeArtifact("session-v1"),
    });
    const agent = new FakeAgentDriver();
    const runtime = createSubscriptionRuntime(
      makeFakeRuntimeDeps({ store, agent }),
    );
    let providerTaskStarted = false;

    const result = await runtime.refreshThenRunTask({
      providerInstanceId: "provider-instance-1",
      task: { kind: "review", prompt: "inspect diff" },
      runContext: {
        runId: "run-1",
        attempt: 1,
        abortSignal: new AbortController().signal,
        onProviderTaskStarted: () => {
          expect(agent.lastPrompt).toBeNull();
          providerTaskStarted = true;
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(providerTaskStarted).toBe(true);
    expect(agent.lastPrompt).toBe("inspect diff");
    const next = await store.read({
      providerInstanceId: "provider-instance-1",
      expectedProviderId: "fake",
      purpose: "health-check",
    });
    expect(next?.generation).toBe(2);
  });

  it("writes back a session update captured during task execution", async () => {
    const store = new InMemorySessionStore();
    store.seed({
      providerInstanceId: "provider-instance-1",
      artifact: makeFakeArtifact("session-v1"),
    });
    const observability = new MemoryObservability();
    const agent = new (class extends FakeAgentDriver {
      override async runTask(input: { readonly task: { readonly prompt: string } }) {
        const result = await super.runTask(input);
        if (result.status !== "completed") return result;
        return {
          ...result,
          sessionUpdate: makeFakeArtifact("session-v3"),
        };
      }
    })();
    const runtime = createSubscriptionRuntime(
      makeFakeRuntimeDeps({ store, agent, observability }),
    );

    const result = await runtime.refreshThenRunTask({
      providerInstanceId: "provider-instance-1",
      task: { kind: "review", prompt: "inspect diff" },
      runContext: {
        runId: "run-task-session-update",
        attempt: 1,
        abortSignal: new AbortController().signal,
      },
    });

    expect(result.status).toBe("completed");
    const next = await store.read({
      providerInstanceId: "provider-instance-1",
      expectedProviderId: "fake",
      purpose: "health-check",
    });
    expect(next?.generation).toBe(3);
    expect(new TextDecoder().decode(next?.artifact.bytes)).toBe("session-v3");
    expect(observability.events.map((event) => event.name)).toContain(
      "session.task_update.writeback.completed",
    );
  });

  it("emits structured observability events without session bytes", async () => {
    const store = new InMemorySessionStore();
    store.seed({
      providerInstanceId: "provider-instance-1",
      artifact: makeFakeArtifact("session-v1-secret"),
    });
    const observability = new MemoryObservability();
    const runtime = createSubscriptionRuntime(
      makeFakeRuntimeDeps({ store, observability }),
    );

    const result = await runtime.refreshThenRunTask({
      providerInstanceId: "provider-instance-1",
      task: { kind: "review", prompt: "inspect diff" },
      runContext: {
        runId: "run-observe",
        attempt: 1,
        abortSignal: new AbortController().signal,
      },
    });

    expect(result.status).toBe("completed");
    expect(observability.events.map((event) => event.name)).toEqual(
      expect.arrayContaining([
        "session.read.started",
        "session.read.completed",
        "lease.acquire.started",
        "lease.acquire.completed",
        "provider.refresh.started",
        "provider.refresh.completed",
        "session.writeback.started",
        "session.writeback.completed",
        "provider.task.started",
        "provider.task.completed",
      ]),
    );
    const serializedEvents = JSON.stringify(observability.events);
    expect(serializedEvents).not.toContain("session-v1-secret");
    expect(serializedEvents).not.toContain("session-v2");
    expect(observability.timings.map((entry) => entry.metric)).toContain(
      "subscription_runtime.provider_refresh_ms",
    );
    expect(observability.counts.map((entry) => entry.metric)).toContain(
      "subscription_runtime.refresh_success",
    );
  });

  it("blocks without reading task output when provider session is missing", async () => {
    const agent = new FakeAgentDriver();
    const runtime = createSubscriptionRuntime(makeFakeRuntimeDeps({ agent }));

    const result = await runtime.refreshThenRunTask({
      providerInstanceId: "missing-instance",
      task: { kind: "review", prompt: "inspect diff" },
      runContext: {
        runId: "run-1",
        attempt: 1,
        abortSignal: new AbortController().signal,
      },
    });

    expect(result).toMatchObject({
      status: "blocked",
      reason: "provider_reconnect_required",
    });
    expect(agent.lastPrompt).toBeNull();
  });

  it("rejects unsupported task mode before reading session storage", async () => {
    const agent = new FakeAgentDriver();
    const store = new (class extends InMemorySessionStore {
      override async read(): Promise<null> {
        throw new Error("task_mode_check_must_happen_before_session_read");
      }
    })();
    const runtime = createSubscriptionRuntime(
      makeFakeRuntimeDeps({
        agent: Object.assign(agent, {
          capabilities: {
            ...agent.capabilities,
            taskModes: ["review"],
          },
        }),
        store,
      }),
    );

    const result = await runtime.refreshThenRunTask({
      providerInstanceId: "provider-instance-1",
      task: { kind: "health-check", prompt: "ping" },
      runContext: {
        runId: "run-task-mode",
        attempt: 1,
        abortSignal: new AbortController().signal,
      },
    });

    expect(result).toMatchObject({
      status: "blocked",
      reason: "task_mode_unsupported",
    });
  });

  it("surfaces provider reconnect instead of retrying in a loop", async () => {
    const provider = new FakeProviderSessionDriver();
    provider.refreshedState = "needs-reconnect";
    const store = new InMemorySessionStore();
    store.seed({
      providerInstanceId: "provider-instance-1",
      artifact: makeFakeArtifact("session-v1"),
    });
    const runtime = createSubscriptionRuntime(
      makeFakeRuntimeDeps({ provider, store }),
    );

    const result = await runtime.refreshThenRunTask({
      providerInstanceId: "provider-instance-1",
      task: { kind: "review", prompt: "inspect diff" },
      runContext: {
        runId: "run-1",
        attempt: 1,
        abortSignal: new AbortController().signal,
      },
    });

    expect(result).toMatchObject({
      status: "blocked",
      reason: "provider_reconnect_required",
    });
  });

  it("blocks quota-limited refreshes before writeback or task execution", async () => {
    const provider = new FakeProviderSessionDriver();
    provider.refreshedState = "quota-limited";
    const agent = new FakeAgentDriver();
    const store = new InMemorySessionStore();
    store.seed({
      providerInstanceId: "provider-instance-1",
      artifact: makeFakeArtifact("session-v1"),
    });
    const runtime = createSubscriptionRuntime(
      makeFakeRuntimeDeps({ provider, agent, store }),
    );
    let providerTaskStarted = false;

    const result = await runtime.refreshThenRunTask({
      providerInstanceId: "provider-instance-1",
      task: { kind: "review", prompt: "inspect diff" },
      runContext: {
        runId: "run-quota",
        attempt: 1,
        abortSignal: new AbortController().signal,
        onProviderTaskStarted: () => {
          providerTaskStarted = true;
        },
      },
    });

    expect(result).toMatchObject({
      status: "blocked",
      reason: "quota_limited",
    });
    expect(agent.lastPrompt).toBeNull();
    expect(providerTaskStarted).toBe(false);
    const current = await store.read({
      providerInstanceId: "provider-instance-1",
      expectedProviderId: "fake",
      purpose: "health-check",
    });
    expect(current?.generation).toBe(1);
  });

  it("runs a static provider without refreshing, leasing, or writing back", async () => {
    const provider = new FakeStaticProviderSessionDriver();
    const agent = new FakeStaticAgentDriver();
    const store = new InMemorySessionStore();
    store.seed({
      providerInstanceId: "provider-instance-static",
      artifact: makeFakeArtifact("static-session-v1", "fake-static"),
    });
    const leaseStore = {
      leaseStoreId: "forbidden-lease-store",
      capabilities: {
        leaseStoreId: "forbidden-lease-store",
        supportsTtl: true,
        supportsFinalize: true,
        supportsWritebackCommit: true,
      },
      async acquire() {
        throw new Error("static_provider_must_not_acquire_lease");
      },
      async finalize() {
        throw new Error("static_provider_must_not_finalize_lease");
      },
      async markWritebackStarted() {
        throw new Error("static_provider_must_not_writeback");
      },
      async markWritebackCommitted() {
        throw new Error("static_provider_must_not_writeback");
      },
    };
    const runtime = createSubscriptionRuntime(
      makeFakeRuntimeDeps({ provider, agent, store, leaseStore }),
    );

    expect(runtime.executionPlan.kind).toBe("static-session");
    const result = await runtime.refreshThenRunTask({
      providerInstanceId: "provider-instance-static",
      task: { kind: "review", prompt: "inspect static" },
      runContext: {
        runId: "run-static",
        attempt: 1,
        abortSignal: new AbortController().signal,
      },
    });

    expect(result.status).toBe("completed");
    expect(agent.lastPrompt).toBe("inspect static");
    const current = await store.read({
      providerInstanceId: "provider-instance-static",
      expectedProviderId: "fake-static",
      purpose: "health-check",
    });
    expect(current?.generation).toBe(1);
  });

  it("runs a no-session provider without session store or lease store", async () => {
    const provider = new FakeNoSessionDriver();
    const agent = new FakeNoSessionAgentDriver();
    const runtime = createSubscriptionRuntime(
      makeFakeRuntimeDeps({ provider, agent }),
    );

    expect(runtime.executionPlan.kind).toBe("no-session");
    const result = await runtime.refreshThenRunTask({
      providerInstanceId: "provider-instance-none",
      task: { kind: "review", prompt: "compute without credentials" },
      runContext: {
        runId: "run-none",
        attempt: 1,
        abortSignal: new AbortController().signal,
      },
    });

    expect(result.status).toBe("completed");
    expect(agent.lastPrompt).toBe("compute without credentials");
    expect(agent.lastSessionWasNull).toBe(true);
  });

  it("skips refresh for fresh lazy rotating sessions", async () => {
    const store = new InMemorySessionStore();
    store.seed({
      providerInstanceId: "provider-instance-lazy",
      artifact: makeFakeArtifact("session-v1"),
    });
    const provider = new LazyFakeProviderSessionDriver({
      status: "fresh",
      reason: "recent_refresh",
      warnings: [],
    });
    const agent = new FakeAgentDriver();
    const runtime = createSubscriptionRuntime(
      makeFakeRuntimeDeps({ provider, agent, store }),
    );

    expect(runtime.executionPlan).toMatchObject({
      kind: "rotating-session",
      refresh: "lazy",
    });
    const result = await runtime.refreshThenRunTask({
      providerInstanceId: "provider-instance-lazy",
      task: { kind: "review", prompt: "inspect fresh" },
      runContext: {
        runId: "run-lazy-fresh",
        attempt: 1,
        abortSignal: new AbortController().signal,
      },
    });

    expect(result).toMatchObject({
      status: "completed",
      refresh: { status: "skipped", reason: "refresh_not_required" },
      task: { status: "completed", outputText: "review:inspect fresh" },
    });
    expect(provider.refreshCount).toBe(0);
  });

  it("refreshes stale lazy rotating sessions before running tasks", async () => {
    const store = new InMemorySessionStore();
    store.seed({
      providerInstanceId: "provider-instance-lazy-stale",
      artifact: makeFakeArtifact("session-v1"),
    });
    const provider = new LazyFakeProviderSessionDriver({
      status: "refresh_recommended",
      reason: "max_age_exceeded",
      warnings: [],
    });
    provider.refreshText = "session-v2";
    const runtime = createSubscriptionRuntime(
      makeFakeRuntimeDeps({ provider, store }),
    );

    const result = await runtime.refreshThenRunTask({
      providerInstanceId: "provider-instance-lazy-stale",
      task: { kind: "review", prompt: "inspect stale" },
      runContext: {
        runId: "run-lazy-stale",
        attempt: 1,
        abortSignal: new AbortController().signal,
      },
    });

    expect(result).toMatchObject({
      status: "completed",
      refresh: {
        status: "ready",
        writeback: { status: "accepted", generation: 2 },
      },
    });
    expect(provider.refreshCount).toBe(1);
  });

  it("does one guarded refresh and retry after lazy auth failure", async () => {
    const store = new InMemorySessionStore();
    store.seed({
      providerInstanceId: "provider-instance-lazy-guard",
      artifact: makeFakeArtifact("session-v1"),
    });
    const provider = new LazyFakeProviderSessionDriver({
      status: "fresh",
      reason: "recent_refresh",
      warnings: [],
    });
    provider.refreshText = "session-v2";
    const agent = new FailsAuthOnceAgentDriver();
    const runtime = createSubscriptionRuntime(
      makeFakeRuntimeDeps({ provider, agent, store }),
    );

    const result = await runtime.refreshThenRunTask({
      providerInstanceId: "provider-instance-lazy-guard",
      task: { kind: "review", prompt: "inspect guarded" },
      runContext: {
        runId: "run-lazy-guard",
        attempt: 1,
        abortSignal: new AbortController().signal,
      },
    });

    expect(result).toMatchObject({
      status: "completed",
      refresh: { status: "ready" },
      task: {
        status: "completed",
        outputText: "review:inspect guarded",
      },
    });
    expect(provider.refreshCount).toBe(1);
    expect(agent.runCount).toBe(2);
  });
});

class LazyFakeProviderSessionDriver extends FakeProviderSessionDriver {
  override readonly capabilities = {
    ...fakeProviderCapabilities,
    refreshMode: "lazy-refresh" as const,
  };

  constructor(private readonly freshness: SessionFreshnessAssessment) {
    super();
  }

  async inspectSessionFreshness() {
    return this.freshness;
  }
}

class FailsAuthOnceAgentDriver extends FakeAgentDriver {
  runCount = 0;

  override async runTask(input: Parameters<FakeAgentDriver["runTask"]>[0]) {
    this.runCount += 1;
    if (this.runCount === 1) {
      return {
        status: "failed" as const,
        failure: {
          code: "needs_reconnect" as const,
          retryable: false,
          reconnectRequired: true,
          safeMessage: "Session expired.",
          causeCategory: "needs_reconnect",
        },
        warnings: [],
      };
    }
    return super.runTask(input);
  }
}

providerSessionDriverContract("fake", () => ({
  driver: new FakeProviderSessionDriver(),
  goodSession: makeFakeArtifact("session-v1"),
  redactor: new DefaultRedactor(),
  reconnectError: new Error("refresh_token=raw-token"),
}));

agentDriverContract("fake", () => ({
  driver: new FakeAgentDriver(),
  goodSession: makeFakeArtifact("session-v1"),
  redactor: new DefaultRedactor(),
}));

sessionStoreContract("memory", () => {
  const providerInstanceId = "provider-instance-contract";
  const store = new InMemorySessionStore();
  return {
    store,
    providerInstanceId,
    currentArtifact: makeFakeArtifact("session-v1"),
    nextArtifact: makeFakeArtifact("session-v2"),
    seed: ({ generation }) => {
      store.seed({
        providerInstanceId,
        artifact: makeFakeArtifact(`session-v${generation}`),
        generation,
      });
    },
  };
});
