import { describe, expect, it } from "vitest";

import {
  ControlPlaneConfigError,
  getSafeConfigSummary,
  loadControlPlaneConfig,
} from "./control-plane-config.js";

describe("loadControlPlaneConfig", () => {
  it("loads local-disabled mode without hosted secrets", () => {
    const config = loadControlPlaneConfig({ NODE_ENV: "test" });

    expect(config.mode).toBe("local-disabled");
    expect(config.http).toEqual({ host: "127.0.0.1", port: 3030 });
    expect(config.build).toEqual({});
    expect(config.persistence.enabled).toBe(false);
    expect(config.database.url).toBeUndefined();
    expect(config.outbox.workerEnabled).toBe(false);
    expect(config.outbox.shutdownTimeoutMs).toBe(30_000);
    expect(config.github).toEqual({});
    expect(config.secrets).toEqual({});
  });

  it("parses bounded worker shutdown timeout", () => {
    const config = loadControlPlaneConfig({
      CONTROL_PLANE_WORKER_SHUTDOWN_TIMEOUT_MS: "1500",
      NODE_ENV: "test",
    });

    expect(config.outbox.shutdownTimeoutMs).toBe(1500);
  });

  it("fails closed when hosted mode is missing required GitHub settings", () => {
    expect(() =>
      loadControlPlaneConfig({
        CONTROL_PLANE_MODE: "hosted-official-app",
        NODE_ENV: "test",
      }),
    ).toThrow(ControlPlaneConfigError);
  });

  it("returns a safe summary without secret values", () => {
    const config = loadControlPlaneConfig({
      CONTROL_PLANE_BUILD_CREATED_AT: "2026-05-26T10:20:30.000Z",
      CONTROL_PLANE_BUILD_REVISION: "abc123",
      CONTROL_PLANE_DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      CONTROL_PLANE_ENCRYPTION_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      CONTROL_PLANE_GITHUB_APP_ID: "123",
      CONTROL_PLANE_GITHUB_APP_SLUG: "agent-teams",
      CONTROL_PLANE_GITHUB_OAUTH_CLIENT_ID: "client-id",
      CONTROL_PLANE_GITHUB_OAUTH_CLIENT_SECRET: "oauth-secret",
      CONTROL_PLANE_GITHUB_PRIVATE_KEY: "private-key",
      CONTROL_PLANE_GITHUB_REST_API_VERSION: "2099-01-01",
      CONTROL_PLANE_GITHUB_WEBHOOK_SECRET: "webhook-secret",
      CONTROL_PLANE_MODE: "hosted-official-app",
      CONTROL_PLANE_PUBLIC_BASE_URL: "https://control-plane.example.test",
      NODE_ENV: "test",
    });

    const summary = getSafeConfigSummary(config);

    expect(config.build).toEqual({
      createdAt: "2026-05-26T10:20:30.000Z",
      revision: "abc123",
    });
    expect(summary.build).toEqual({
      createdAtConfigured: true,
      revisionConfigured: true,
    });
    expect(summary.github.privateKeyConfigured).toBe(true);
    expect(summary.database.urlConfigured).toBe(true);
    expect(summary.github.encryptionMasterKeyConfigured).toBe(true);
    expect(JSON.stringify(summary)).not.toContain("private-key");
    expect(JSON.stringify(summary)).not.toContain("webhook-secret");
    expect(JSON.stringify(summary)).not.toContain("oauth-secret");
    expect(JSON.stringify(summary)).not.toContain("postgresql://user:pass");
    expect(JSON.stringify(summary)).not.toContain("abc123");
  });

  it("maps config validation failures to shared validation and safe error shapes", () => {
    try {
      loadControlPlaneConfig({
        CONTROL_PLANE_BUILD_CREATED_AT: "not-an-iso-timestamp",
        NODE_ENV: "test",
      });
      throw new Error("Expected config parsing to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(ControlPlaneConfigError);
      if (error instanceof ControlPlaneConfigError) {
        expect(error.validationIssues).toEqual([
          expect.objectContaining({
            path: ["CONTROL_PLANE_BUILD_CREATED_AT"],
          }),
        ]);
        expect(error.safeError).toMatchObject({
          category: "validation",
          code: "CONTROL_PLANE_CONFIG_INVALID",
          safeDetails: { issueCount: 1 },
        });
        expect(JSON.stringify(error.safeError)).not.toContain("not-an-iso-timestamp");
      }
    }
  });

  it("fails when persistence is enabled without database and encryption settings", () => {
    expect(() =>
      loadControlPlaneConfig({
        CONTROL_PLANE_PERSISTENCE_ENABLED: "true",
        NODE_ENV: "test",
      }),
    ).toThrow(ControlPlaneConfigError);
  });

  it("validates encryption master key length when persistence is enabled", () => {
    expect(() =>
      loadControlPlaneConfig({
        CONTROL_PLANE_DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        CONTROL_PLANE_ENCRYPTION_MASTER_KEY: Buffer.alloc(16, 7).toString("base64"),
        CONTROL_PLANE_PERSISTENCE_ENABLED: "true",
        NODE_ENV: "test",
      }),
    ).toThrow(ControlPlaneConfigError);
  });
});
