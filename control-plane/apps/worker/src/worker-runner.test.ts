import { describe, expect, it } from "vitest";

import type { ControlPlaneConfigService } from "@agent-teams-control-plane/platform-config";
import type { ControlPlaneLogger } from "@agent-teams-control-plane/platform-logger";
import type { OutboxWorkerService } from "@agent-teams-control-plane/features-outbox/interface/nest";

import { WorkerRunner } from "./worker-runner.js";

describe("WorkerRunner", () => {
  it("boots in smoke mode without side effects", async () => {
    const logger = createSilentLogger();
    const configService = {
      getSafeSummary: () => ({
        build: {
          createdAtConfigured: false,
          revisionConfigured: false,
        },
        environment: "test",
        featureGates: disabledFeatureGates(),
        github: {
          appIdConfigured: false,
          appSlugConfigured: false,
          oauthClientIdConfigured: false,
          oauthClientSecretConfigured: false,
          encryptionMasterKeyConfigured: false,
          privateKeyConfigured: false,
          restApiVersionConfigured: false,
          webhookSecretConfigured: false,
        },
        http: { host: "127.0.0.1", port: 3030 },
        integrationTargets: {
          repositoryAvailabilityMaxAgeHours: 24,
        },
        mode: "local-disabled",
        database: {
          poolMax: 5,
          sslMode: "disable",
          urlConfigured: false,
        },
        outbox: {
          batchSize: 10,
          leaseSeconds: 300,
          maxAttempts: 10,
          pollIntervalMs: 1000,
          shutdownTimeoutMs: 30_000,
          workerEnabled: false,
        },
        persistence: { enabled: false },
        publicBaseUrlConfigured: false,
        retention: {
          completedOutboxConfigured: false,
          deadLetterConfigured: false,
          externalContentConfigured: false,
        },
      }),
    } satisfies Pick<ControlPlaneConfigService, "getSafeSummary">;
    const outboxWorker = {
      runOnce: async () => ({
        claimed: 0,
        completed: 0,
        deadLettered: 0,
        retried: 0,
        skipped: true,
        staleClaims: 0,
      }),
    } satisfies Pick<OutboxWorkerService, "runOnce">;

    const runner = new WorkerRunner(
      configService as ControlPlaneConfigService,
      outboxWorker as OutboxWorkerService,
      logger,
    );

    await expect(runner.run("smoke")).resolves.toEqual({
      mode: "smoke",
      outboxSkipped: true,
      status: "idle",
    });
  });

  it("polls in serve mode until stop is requested", async () => {
    const logger = createSilentLogger();
    const controls: { requestStop?: () => void } = {};
    let calls = 0;
    const outboxWorker = {
      runOnce: async () => {
        calls += 1;
        if (calls === 2) {
          controls.requestStop?.();
        }
        return {
          claimed: calls === 1 ? 1 : 0,
          completed: calls === 1 ? 1 : 0,
          deadLettered: 0,
          retried: 0,
          skipped: false,
          staleClaims: 0,
        };
      },
    } satisfies Pick<OutboxWorkerService, "runOnce">;

    const runner = new WorkerRunner(
      createConfigService({ pollIntervalMs: 1 }) as ControlPlaneConfigService,
      outboxWorker as OutboxWorkerService,
      logger,
    );
    controls.requestStop = () => runner.requestStop();

    await expect(runner.run("serve")).resolves.toEqual({
      mode: "serve",
      outboxSkipped: false,
      status: "processed-once",
    });
    expect(calls).toBe(2);
  });

  it("bounds shutdown wait when in-flight work does not finish", async () => {
    const logs: Array<{ level: string; message: string }> = [];
    const outboxWorker = {
      runOnce: async () => new Promise<never>(() => undefined),
    } satisfies Pick<OutboxWorkerService, "runOnce">;
    const runner = new WorkerRunner(
      createConfigService({
        pollIntervalMs: 1,
        shutdownTimeoutMs: 1,
      }) as ControlPlaneConfigService,
      outboxWorker as unknown as OutboxWorkerService,
      createSilentLogger(logs),
    );

    const runPromise = runner.run("serve");

    await expect(runner.stop(runPromise)).resolves.toBeUndefined();
    expect(logs).toContainEqual({
      level: "warn",
      message: "Worker shutdown timeout elapsed",
    });
  });
});

function createConfigService(input: {
  pollIntervalMs: number;
  shutdownTimeoutMs?: number;
}) {
  return {
    getSafeSummary: () => ({
      build: {
        createdAtConfigured: false,
        revisionConfigured: false,
      },
      database: {
        poolMax: 5,
        sslMode: "disable",
        urlConfigured: false,
      },
      environment: "test",
      featureGates: disabledFeatureGates(),
      github: {
        appIdConfigured: false,
        appSlugConfigured: false,
        encryptionMasterKeyConfigured: false,
        oauthClientIdConfigured: false,
        oauthClientSecretConfigured: false,
        privateKeyConfigured: false,
        restApiVersionConfigured: false,
        webhookSecretConfigured: false,
      },
      http: { host: "127.0.0.1", port: 3030 },
      integrationTargets: {
        repositoryAvailabilityMaxAgeHours: 24,
      },
      mode: "local-disabled",
      outbox: {
        batchSize: 10,
        leaseSeconds: 300,
        maxAttempts: 10,
        pollIntervalMs: input.pollIntervalMs,
        shutdownTimeoutMs: input.shutdownTimeoutMs ?? 30_000,
        workerEnabled: false,
      },
      persistence: { enabled: false },
      publicBaseUrlConfigured: false,
      retention: {
        completedOutboxConfigured: false,
        deadLetterConfigured: false,
        externalContentConfigured: false,
      },
    }),
  } satisfies Pick<ControlPlaneConfigService, "getSafeSummary">;
}

function disabledFeatureGates() {
  return {
    desktopBootstrapEnabled: false,
    desktopPairingEnabled: false,
    githubClaimOAuthEnabled: false,
    githubSetupEnabled: false,
    githubUnclaimedCallbackRecordingEnabled: false,
    integrationTargetsEnabled: false,
  };
}

function createSilentLogger(
  logs: Array<{ level: string; message: string }> = [],
): ControlPlaneLogger {
  return {
    child: () => createSilentLogger(logs),
    debug: (message) => logs.push({ level: "debug", message }),
    error: (message) => logs.push({ level: "error", message }),
    info: (message) => logs.push({ level: "info", message }),
    warn: (message) => logs.push({ level: "warn", message }),
  };
}
