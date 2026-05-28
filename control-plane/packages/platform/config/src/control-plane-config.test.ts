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
    expect(config.featureGates).toEqual({
      desktopBootstrapEnabled: false,
      desktopPairingEnabled: false,
      githubActionsEnabled: false,
      githubClaimOAuthEnabled: false,
      githubSetupEnabled: false,
      githubTokenBrokerEnabled: false,
      githubUnclaimedCallbackRecordingEnabled: false,
      integrationTargetsEnabled: false,
    });
    expect(config.integrationTargets).toEqual({
      repositoryAvailabilityMaxAgeHours: 24,
    });
    expect(config.githubActions).toEqual({
      agentAvatarAllowedOrigins: [],
    });
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
      CONTROL_PLANE_GITHUB_APP_CLIENT_ID: "app-client-id",
      CONTROL_PLANE_GITHUB_APP_SLUG: "agent-teams",
      CONTROL_PLANE_AGENT_AVATAR_ALLOWED_ORIGINS: "https://cdn.example.test",
      CONTROL_PLANE_DEFAULT_AGENT_AVATAR_URL:
        "https://cdn.example.test/agent-teams/default-avatar.png",
      CONTROL_PLANE_GITHUB_OAUTH_CLIENT_ID: "client-id",
      CONTROL_PLANE_GITHUB_OAUTH_CLIENT_SECRET: "oauth-secret",
      CONTROL_PLANE_GITHUB_PRIVATE_KEY: "private-key",
      CONTROL_PLANE_GITHUB_REST_API_VERSION: "2099-01-01",
      CONTROL_PLANE_GITHUB_SETUP_ENABLED: "true",
      CONTROL_PLANE_GITHUB_ACTIONS_ENABLED: "true",
      CONTROL_PLANE_GITHUB_TOKEN_BROKER_ENABLED: "true",
      CONTROL_PLANE_GITHUB_WEBHOOK_SECRET: "webhook-secret",
      CONTROL_PLANE_INTEGRATION_TARGETS_ENABLED: "true",
      CONTROL_PLANE_MODE: "hosted-official-app",
      CONTROL_PLANE_OUTBOX_WORKER_ENABLED: "true",
      CONTROL_PLANE_PUBLIC_BASE_URL: "https://control-plane.example.test",
      CONTROL_PLANE_REPOSITORY_AVAILABILITY_MAX_AGE_HOURS: "48",
      CONTROL_PLANE_EXTERNAL_CONTENT_RETENTION_DAYS: "7",
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
    expect(summary.github.appClientIdConfigured).toBe(true);
    expect(summary.database.urlConfigured).toBe(true);
    expect(summary.github.encryptionMasterKeyConfigured).toBe(true);
    expect(summary.featureGates.githubSetupEnabled).toBe(true);
    expect(summary.featureGates.githubActionsEnabled).toBe(true);
    expect(summary.featureGates.githubTokenBrokerEnabled).toBe(true);
    expect(summary.githubActions).toEqual({
      allowedOriginCount: 1,
      defaultAgentAvatarConfigured: true,
    });
    expect(summary.featureGates.integrationTargetsEnabled).toBe(true);
    expect(summary.integrationTargets.repositoryAvailabilityMaxAgeHours).toBe(48);
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

  it("fails fast when phase 5 feature gates are enabled without persistence", () => {
    expect(() =>
      loadControlPlaneConfig({
        CONTROL_PLANE_DESKTOP_BOOTSTRAP_ENABLED: "true",
        NODE_ENV: "test",
      }),
    ).toThrow(ControlPlaneConfigError);
  });

  it("requires GitHub setup when GitHub claim OAuth is enabled", () => {
    expect(() =>
      loadControlPlaneConfig({
        CONTROL_PLANE_DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        CONTROL_PLANE_ENCRYPTION_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
        CONTROL_PLANE_GITHUB_CLAIM_OAUTH_ENABLED: "true",
        CONTROL_PLANE_PERSISTENCE_ENABLED: "true",
        NODE_ENV: "test",
      }),
    ).toThrow(ControlPlaneConfigError);
  });

  it("fails fast when integration targets are enabled without persistence", () => {
    expect(() =>
      loadControlPlaneConfig({
        CONTROL_PLANE_INTEGRATION_TARGETS_ENABLED: "true",
        NODE_ENV: "test",
      }),
    ).toThrow(ControlPlaneConfigError);
  });

  it("fails fast when GitHub token broker is enabled without integration targets", () => {
    expect(() =>
      loadControlPlaneConfig({
        CONTROL_PLANE_DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        CONTROL_PLANE_ENCRYPTION_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
        CONTROL_PLANE_GITHUB_APP_ID: "123",
        CONTROL_PLANE_GITHUB_APP_PRIVATE_KEY: "private-key",
        CONTROL_PLANE_GITHUB_APP_SLUG: "agent-teams",
        CONTROL_PLANE_GITHUB_OAUTH_CLIENT_ID: "client-id",
        CONTROL_PLANE_GITHUB_OAUTH_CLIENT_SECRET: "oauth-secret",
        CONTROL_PLANE_GITHUB_REST_API_VERSION: "2099-01-01",
        CONTROL_PLANE_GITHUB_TOKEN_BROKER_ENABLED: "true",
        CONTROL_PLANE_GITHUB_WEBHOOK_SECRET: "webhook-secret",
        CONTROL_PLANE_MODE: "hosted-official-app",
        CONTROL_PLANE_PUBLIC_BASE_URL: "https://control-plane.example.test",
        NODE_ENV: "test",
      }),
    ).toThrow(ControlPlaneConfigError);
  });

  it("fails fast when GitHub actions are enabled without avatar and retention settings", () => {
    expect(() =>
      loadControlPlaneConfig({
        CONTROL_PLANE_DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        CONTROL_PLANE_ENCRYPTION_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
        CONTROL_PLANE_GITHUB_APP_ID: "123",
        CONTROL_PLANE_GITHUB_APP_PRIVATE_KEY: "private-key",
        CONTROL_PLANE_GITHUB_APP_SLUG: "agent-teams",
        CONTROL_PLANE_GITHUB_OAUTH_CLIENT_ID: "client-id",
        CONTROL_PLANE_GITHUB_OAUTH_CLIENT_SECRET: "oauth-secret",
        CONTROL_PLANE_GITHUB_REST_API_VERSION: "2099-01-01",
        CONTROL_PLANE_GITHUB_ACTIONS_ENABLED: "true",
        CONTROL_PLANE_GITHUB_TOKEN_BROKER_ENABLED: "true",
        CONTROL_PLANE_GITHUB_WEBHOOK_SECRET: "webhook-secret",
        CONTROL_PLANE_INTEGRATION_TARGETS_ENABLED: "true",
        CONTROL_PLANE_MODE: "hosted-official-app",
        CONTROL_PLANE_OUTBOX_WORKER_ENABLED: "true",
        CONTROL_PLANE_PUBLIC_BASE_URL: "https://control-plane.example.test",
        NODE_ENV: "test",
      }),
    ).toThrow(ControlPlaneConfigError);
  });

  it("loads GitHub actions only with safe avatar origins and retention", () => {
    const config = loadControlPlaneConfig({
      CONTROL_PLANE_AGENT_AVATAR_ALLOWED_ORIGINS:
        "https://cdn.example.test, https://avatars.example.test",
      CONTROL_PLANE_DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      CONTROL_PLANE_DEFAULT_AGENT_AVATAR_URL:
        "https://cdn.example.test/agent-teams/default-avatar.png",
      CONTROL_PLANE_ENCRYPTION_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      CONTROL_PLANE_EXTERNAL_CONTENT_RETENTION_DAYS: "3",
      CONTROL_PLANE_GITHUB_APP_ID: "123",
      CONTROL_PLANE_GITHUB_APP_PRIVATE_KEY: "private-key",
      CONTROL_PLANE_GITHUB_APP_SLUG: "agent-teams",
      CONTROL_PLANE_GITHUB_OAUTH_CLIENT_ID: "client-id",
      CONTROL_PLANE_GITHUB_OAUTH_CLIENT_SECRET: "oauth-secret",
      CONTROL_PLANE_GITHUB_REST_API_VERSION: "2099-01-01",
      CONTROL_PLANE_GITHUB_ACTIONS_ENABLED: "true",
      CONTROL_PLANE_GITHUB_TOKEN_BROKER_ENABLED: "true",
      CONTROL_PLANE_GITHUB_WEBHOOK_SECRET: "webhook-secret",
      CONTROL_PLANE_INTEGRATION_TARGETS_ENABLED: "true",
      CONTROL_PLANE_MODE: "hosted-official-app",
      CONTROL_PLANE_OUTBOX_WORKER_ENABLED: "true",
      CONTROL_PLANE_PUBLIC_BASE_URL: "https://control-plane.example.test",
      NODE_ENV: "test",
    });

    expect(config.featureGates.githubActionsEnabled).toBe(true);
    expect(config.githubActions).toEqual({
      agentAvatarAllowedOrigins: [
        "https://avatars.example.test",
        "https://cdn.example.test",
      ],
      defaultAgentAvatarUrl: "https://cdn.example.test/agent-teams/default-avatar.png",
    });
  });

  it("rejects overlong GitHub action default avatar URLs", () => {
    expect(() =>
      loadControlPlaneConfig({
        CONTROL_PLANE_AGENT_AVATAR_ALLOWED_ORIGINS: "https://cdn.example.test",
        CONTROL_PLANE_DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        CONTROL_PLANE_DEFAULT_AGENT_AVATAR_URL: `https://cdn.example.test/${"a".repeat(2_100)}.png`,
        CONTROL_PLANE_ENCRYPTION_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
        CONTROL_PLANE_EXTERNAL_CONTENT_RETENTION_DAYS: "3",
        CONTROL_PLANE_GITHUB_APP_ID: "123",
        CONTROL_PLANE_GITHUB_APP_PRIVATE_KEY: "private-key",
        CONTROL_PLANE_GITHUB_APP_SLUG: "agent-teams",
        CONTROL_PLANE_GITHUB_OAUTH_CLIENT_ID: "client-id",
        CONTROL_PLANE_GITHUB_OAUTH_CLIENT_SECRET: "oauth-secret",
        CONTROL_PLANE_GITHUB_REST_API_VERSION: "2099-01-01",
        CONTROL_PLANE_GITHUB_ACTIONS_ENABLED: "true",
        CONTROL_PLANE_GITHUB_TOKEN_BROKER_ENABLED: "true",
        CONTROL_PLANE_GITHUB_WEBHOOK_SECRET: "webhook-secret",
        CONTROL_PLANE_INTEGRATION_TARGETS_ENABLED: "true",
        CONTROL_PLANE_MODE: "hosted-official-app",
        CONTROL_PLANE_OUTBOX_WORKER_ENABLED: "true",
        CONTROL_PLANE_PUBLIC_BASE_URL: "https://control-plane.example.test",
        NODE_ENV: "test",
      }),
    ).toThrow(ControlPlaneConfigError);
  });

  it("accepts the token broker private key alias in hosted mode", () => {
    const config = loadControlPlaneConfig({
      CONTROL_PLANE_DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      CONTROL_PLANE_ENCRYPTION_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      CONTROL_PLANE_GITHUB_APP_CLIENT_ID: "app-client-id",
      CONTROL_PLANE_GITHUB_APP_ID: "123",
      CONTROL_PLANE_GITHUB_APP_PRIVATE_KEY: "private-key",
      CONTROL_PLANE_GITHUB_APP_SLUG: "agent-teams",
      CONTROL_PLANE_GITHUB_OAUTH_CLIENT_ID: "client-id",
      CONTROL_PLANE_GITHUB_OAUTH_CLIENT_SECRET: "oauth-secret",
      CONTROL_PLANE_GITHUB_REST_API_VERSION: "2099-01-01",
      CONTROL_PLANE_GITHUB_TOKEN_BROKER_ENABLED: "true",
      CONTROL_PLANE_GITHUB_WEBHOOK_SECRET: "webhook-secret",
      CONTROL_PLANE_INTEGRATION_TARGETS_ENABLED: "true",
      CONTROL_PLANE_MODE: "hosted-official-app",
      CONTROL_PLANE_PUBLIC_BASE_URL: "https://control-plane.example.test",
      NODE_ENV: "test",
    });

    expect(config.secrets.githubPrivateKey).toBe("private-key");
    expect(config.github.appClientId).toBe("app-client-id");
    expect(config.featureGates.githubTokenBrokerEnabled).toBe(true);
  });

  it("classifies the documented hosted startup matrix profiles", () => {
    const setupOnly = getSafeConfigSummary(
      loadControlPlaneConfig({
        ...hostedBaseEnv(),
        CONTROL_PLANE_DESKTOP_BOOTSTRAP_ENABLED: "true",
        CONTROL_PLANE_DESKTOP_PAIRING_ENABLED: "true",
        CONTROL_PLANE_GITHUB_CLAIM_OAUTH_ENABLED: "true",
        CONTROL_PLANE_GITHUB_SETUP_ENABLED: "true",
        CONTROL_PLANE_OUTBOX_WORKER_ENABLED: "false",
      }),
    );

    const targetManagement = getSafeConfigSummary(
      loadControlPlaneConfig({
        ...hostedBaseEnv(),
        CONTROL_PLANE_DESKTOP_BOOTSTRAP_ENABLED: "true",
        CONTROL_PLANE_DESKTOP_PAIRING_ENABLED: "true",
        CONTROL_PLANE_GITHUB_CLAIM_OAUTH_ENABLED: "true",
        CONTROL_PLANE_GITHUB_SETUP_ENABLED: "true",
        CONTROL_PLANE_INTEGRATION_TARGETS_ENABLED: "true",
        CONTROL_PLANE_OUTBOX_WORKER_ENABLED: "false",
      }),
    );

    const actions = getSafeConfigSummary(
      loadControlPlaneConfig({
        ...hostedBaseEnv(),
        ...hostedActionEnv(),
      }),
    );

    expect(setupOnly.hostedProfile).toBe("setup-only");
    expect(targetManagement.hostedProfile).toBe("target-management");
    expect(actions.hostedProfile).toBe("actions");
  });

  it("fails fast for actions mode when dispatch prerequisites are disabled", () => {
    expect(() =>
      loadControlPlaneConfig({
        ...hostedBaseEnv(),
        ...hostedActionEnv(),
        CONTROL_PLANE_OUTBOX_WORKER_ENABLED: "false",
      }),
    ).toThrow(ControlPlaneConfigError);
  });

  it("validates repository availability max age bounds", () => {
    expect(() =>
      loadControlPlaneConfig({
        CONTROL_PLANE_REPOSITORY_AVAILABILITY_MAX_AGE_HOURS: "0",
        NODE_ENV: "test",
      }),
    ).toThrow(ControlPlaneConfigError);
  });

  it("requires https public base URL in production hosted modes", () => {
    expect(() =>
      loadControlPlaneConfig({
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
        CONTROL_PLANE_PUBLIC_BASE_URL: "http://control-plane.example.test",
        NODE_ENV: "production",
      }),
    ).toThrow(ControlPlaneConfigError);
  });
});

function hostedBaseEnv(): NodeJS.ProcessEnv {
  return {
    CONTROL_PLANE_DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
    CONTROL_PLANE_ENCRYPTION_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    CONTROL_PLANE_GITHUB_APP_ID: "123",
    CONTROL_PLANE_GITHUB_APP_PRIVATE_KEY: "private-key",
    CONTROL_PLANE_GITHUB_APP_SLUG: "agent-teams",
    CONTROL_PLANE_GITHUB_OAUTH_CLIENT_ID: "client-id",
    CONTROL_PLANE_GITHUB_OAUTH_CLIENT_SECRET: "oauth-secret",
    CONTROL_PLANE_GITHUB_REST_API_VERSION: "2099-01-01",
    CONTROL_PLANE_GITHUB_WEBHOOK_SECRET: "webhook-secret",
    CONTROL_PLANE_MODE: "hosted-official-app",
    CONTROL_PLANE_PUBLIC_BASE_URL: "https://control-plane.example.test",
    NODE_ENV: "test",
  };
}

function hostedActionEnv(): NodeJS.ProcessEnv {
  return {
    CONTROL_PLANE_AGENT_AVATAR_ALLOWED_ORIGINS: "https://cdn.example.test",
    CONTROL_PLANE_DEFAULT_AGENT_AVATAR_URL:
      "https://cdn.example.test/agent-teams/default-avatar.png",
    CONTROL_PLANE_DESKTOP_BOOTSTRAP_ENABLED: "true",
    CONTROL_PLANE_DESKTOP_PAIRING_ENABLED: "true",
    CONTROL_PLANE_EXTERNAL_CONTENT_RETENTION_DAYS: "3",
    CONTROL_PLANE_GITHUB_ACTIONS_ENABLED: "true",
    CONTROL_PLANE_GITHUB_CLAIM_OAUTH_ENABLED: "true",
    CONTROL_PLANE_GITHUB_SETUP_ENABLED: "true",
    CONTROL_PLANE_GITHUB_TOKEN_BROKER_ENABLED: "true",
    CONTROL_PLANE_INTEGRATION_TARGETS_ENABLED: "true",
    CONTROL_PLANE_OUTBOX_WORKER_ENABLED: "true",
  };
}
