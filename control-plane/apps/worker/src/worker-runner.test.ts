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
});

function createConfigService(input: { pollIntervalMs: number }) {
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
      mode: "local-disabled",
      outbox: {
        batchSize: 10,
        leaseSeconds: 300,
        maxAttempts: 10,
        pollIntervalMs: input.pollIntervalMs,
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

function createSilentLogger(): ControlPlaneLogger {
  return {
    child: () => createSilentLogger(),
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  };
}
