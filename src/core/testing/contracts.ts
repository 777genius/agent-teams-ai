import { describe, expect, it } from "vitest";
import type {
  AgentDriver,
  ProviderSessionDriver,
  RedactorPort,
  SessionStorePort,
} from "../ports";
import type { SessionArtifact } from "../domain/types";

export type ProviderDriverTestFixture = {
  readonly driver: ProviderSessionDriver;
  readonly goodSession: SessionArtifact;
  readonly redactor: RedactorPort;
  readonly reconnectError: unknown;
};

export function providerSessionDriverContract(
  name: string,
  factory: () => ProviderDriverTestFixture,
): void {
  describe(`${name} provider session driver contract`, () => {
    it("validates a good session without mutating it", async () => {
      const fixture = factory();
      const before = fixture.goodSession.bytes.slice();

      const result = await fixture.driver.validateSession({
        session: fixture.goodSession,
        redactor: fixture.redactor,
      });

      expect(result.status).toBe("valid");
      expect(fixture.goodSession.bytes).toEqual(before);
    });

    it("classifies failures without leaking token field names", () => {
      const fixture = factory();
      const failure = fixture.driver.classifySessionFailure(
        fixture.reconnectError,
      );

      expect(failure.safeMessage).not.toContain("refresh_token");
      expect(failure.safeMessage).not.toContain("access_token");
    });

    it("declares capabilities before runtime starts", () => {
      const fixture = factory();
      expect(fixture.driver.capabilities.providerId).toBeTruthy();
      expect(fixture.driver.capabilities.sessionRequirement.kind).toBe(
        "required",
      );
      if (fixture.driver.capabilities.sessionRequirement.kind === "required") {
        expect(
          fixture.driver.capabilities.sessionRequirement.artifactKinds.length,
        ).toBeGreaterThan(0);
      }
    });
  });
}

export type AgentDriverTestFixture = {
  readonly driver: AgentDriver;
  readonly goodSession: SessionArtifact;
  readonly redactor: RedactorPort;
};

export function agentDriverContract(
  name: string,
  factory: () => AgentDriverTestFixture,
): void {
  describe(`${name} agent driver contract`, () => {
    it("runs a basic task and returns a structured status", async () => {
      const fixture = factory();
      const result = await fixture.driver.runTask({
        session: fixture.goodSession,
        task: { kind: "structured-prompt", prompt: "hello" },
        workspace: { path: "/tmp/subscription-runtime-contract" },
        runner: {
          runnerId: "contract-runner",
          capabilities: {
            runnerId: "contract-runner",
            supportsEnvAllowlist: true,
            supportsWorkingDirectory: true,
            supportsTimeout: true,
            supportsAbortSignal: true,
            supportsOutputRedaction: true,
            supportsReadOnlySandbox: true,
            readOnlyFilesystem: false,
            platform: "node-process",
          },
          async run() {
            return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
          },
        },
        redactor: fixture.redactor,
        abortSignal: new AbortController().signal,
      });

      expect(["completed", "failed"]).toContain(result.status);
    });
  });
}

export type SessionStoreTestFixture = {
  readonly store: SessionStorePort;
  readonly providerInstanceId: string;
  readonly currentArtifact: SessionArtifact;
  readonly nextArtifact: SessionArtifact;
  seed(input: { readonly generation: number }): Promise<void> | void;
};

export function sessionStoreContract(
  name: string,
  factory: () => SessionStoreTestFixture,
): void {
  describe(`${name} session store contract`, () => {
    it("rejects stale generation writes", async () => {
      const fixture = factory();
      await fixture.seed({ generation: 2 });

      await expect(
        fixture.store.write({
          providerInstanceId: fixture.providerInstanceId,
          expectedGeneration: 1,
          nextArtifact: fixture.nextArtifact,
          idempotencyKey: "idem-1",
          leaseId: "lease-1",
        }),
      ).resolves.toMatchObject({ status: "stale_generation" });
    });

    it("handles idempotent replay without creating a new generation", async () => {
      const fixture = factory();
      await fixture.seed({ generation: 1 });

      const first = await fixture.store.write({
        providerInstanceId: fixture.providerInstanceId,
        expectedGeneration: 1,
        nextArtifact: fixture.nextArtifact,
        idempotencyKey: "idem-1",
        leaseId: "lease-1",
      });
      const second = await fixture.store.write({
        providerInstanceId: fixture.providerInstanceId,
        expectedGeneration: 1,
        nextArtifact: fixture.nextArtifact,
        idempotencyKey: "idem-1",
        leaseId: "lease-1",
      });

      expect(first.status).toBe("accepted");
      expect(second.status).toBe("idempotent_replay");
    });
  });
}
