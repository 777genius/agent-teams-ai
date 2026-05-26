import { describe, expect, it } from "vitest";

import type { ControlPlaneConfigService } from "@agent-teams-control-plane/platform-config";
import type { ControlPlaneLogger } from "@agent-teams-control-plane/platform-logger";

import { WorkerRunner } from "./worker-runner.js";

describe("WorkerRunner", () => {
  it("boots in smoke mode without side effects", () => {
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
          privateKeyConfigured: false,
          restApiVersionConfigured: false,
          webhookSecretConfigured: false,
        },
        http: { host: "127.0.0.1", port: 3030 },
        mode: "local-disabled",
        publicBaseUrlConfigured: false,
      }),
    } satisfies Pick<ControlPlaneConfigService, "getSafeSummary">;

    const runner = new WorkerRunner(configService as ControlPlaneConfigService, logger);

    expect(runner.run("smoke")).toEqual({
      mode: "smoke",
      status: "idle",
    });
  });
});

function createSilentLogger(): ControlPlaneLogger {
  return {
    child: () => createSilentLogger(),
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  };
}
