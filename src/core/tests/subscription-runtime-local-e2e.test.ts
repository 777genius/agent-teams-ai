import { describe, expect, it } from "vitest";
import {
  createSubscriptionRuntime,
  type AgentDriver,
  type ProviderTaskResult,
  type SessionArtifact,
  type SessionEnvelope,
  type SessionStorePort,
  type SessionWriteResult,
} from "../index";
import {
  fakeAgentCapabilities,
  fakeStoreCapabilities,
  FakeProviderSessionDriver,
  makeFakeArtifact,
  makeFakeRuntimeDeps,
} from "../testing";
import { computeSessionGenerationHash } from "../domain/generation-hash";

describe("subscription runtime local no-custody E2E", () => {
  it("runs the task with the refreshed artifact even when the store read remains stale during the same job", async () => {
    const provider = new FakeProviderSessionDriver();
    provider.refreshText = "session-v2";
    const store = new WritebackOnlyNoCustodyStore(
      makeFakeArtifact("session-v1"),
    );
    const agent = new RecordingAgentDriver();
    const runtime = createSubscriptionRuntime(
      makeFakeRuntimeDeps({ provider, agent, store }),
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

    expect(result.status).toBe("completed");
    expect(store.writeCount).toBe(1);
    expect(store.lastWrittenText).toBe("session-v2");
    expect(agent.lastSessionText).toBe("session-v2");
  });
});

class WritebackOnlyNoCustodyStore implements SessionStorePort {
  readonly storeId = fakeStoreCapabilities.storeId;
  readonly custody = fakeStoreCapabilities.custody;
  readonly capabilities = fakeStoreCapabilities;
  writeCount = 0;
  lastWrittenText: string | null = null;
  private readonly initialEnvelope: SessionEnvelope;

  constructor(initialArtifact: SessionArtifact) {
    this.initialEnvelope = {
      providerInstanceId: "provider-instance-1",
      providerId: initialArtifact.providerId,
      artifact: initialArtifact,
      generation: 1,
      generationHash: computeSessionGenerationHash({
        artifact: initialArtifact,
      }),
      storageVersion: "writeback-only-no-custody-v1",
      custody: this.custody,
      metadata: {},
    };
  }

  async read(): Promise<SessionEnvelope | null> {
    return this.initialEnvelope;
  }

  async write(input: {
    readonly nextArtifact: SessionArtifact;
  }): Promise<SessionWriteResult> {
    this.writeCount += 1;
    this.lastWrittenText = new TextDecoder().decode(input.nextArtifact.bytes);
    return {
      status: "accepted",
      generation: 2,
      generationHash: computeSessionGenerationHash({
        artifact: input.nextArtifact,
      }),
    };
  }
}

class RecordingAgentDriver implements AgentDriver {
  readonly agentId = fakeAgentCapabilities.agentId;
  readonly providerId = fakeAgentCapabilities.providerId;
  readonly capabilities = fakeAgentCapabilities;
  lastSessionText: string | null = null;

  async runTask(input: {
    readonly session: SessionArtifact | null;
  }): Promise<ProviderTaskResult> {
    if (!input.session) {
      throw new Error("recording_agent_requires_session");
    }
    this.lastSessionText = new TextDecoder().decode(input.session.bytes);
    return {
      status: "completed",
      outputText: "review complete",
      warnings: [],
    };
  }

  classifyRunFailure() {
    return {
      code: "unknown_runtime_failure" as const,
      retryable: false,
      reconnectRequired: false,
      safeMessage: "Fake agent failure.",
    };
  }
}
