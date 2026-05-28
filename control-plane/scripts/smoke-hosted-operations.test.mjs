/* global Response */

import { describe, expect, it, vi } from "vitest";

import {
  assertNoSecretLeak,
  runHostedOperationsSmoke,
  validateHostedSmokeConfig,
} from "./smoke-hosted-operations.mjs";

describe("smoke-hosted-operations", () => {
  it("refuses production-looking hosts by default", () => {
    expect(() =>
      validateHostedSmokeConfig({
        CONTROL_PLANE_HOSTED_SMOKE_BASE_URL: "https://control-plane.example.com",
      }),
    ).toThrow(/production-looking/);
  });

  it("requires https smoke targets", () => {
    expect(() =>
      validateHostedSmokeConfig({
        CONTROL_PLANE_HOSTED_SMOKE_BASE_URL: "http://staging-control-plane.example.test",
      }),
    ).toThrow(/must use https/);
  });

  it("verifies health, readiness, secret redaction, and revision parity", async () => {
    const payload = {
      configuration: {
        githubRestApiVersionConfigured: true,
        publicBaseUrlConfigured: true,
      },
      mode: "hosted-official-app",
      readiness: {
        database: {
          enabled: true,
          migrationStatus: "applied",
          status: "ready",
        },
        status: "ready",
      },
      service: {
        build: {
          createdAt: "2026-05-26T10:20:30.000Z",
          revision: "abc123",
        },
        name: "agent-teams-control-plane",
        version: "0.0.0",
      },
      status: "ok",
      uptimeSeconds: 12,
    };
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(payload), { status: 200 }),
    );

    await expect(
      runHostedOperationsSmoke({
        baseUrl: new URL("https://staging-control-plane.example.test"),
        expectedMode: "hosted-official-app",
        expectedRevision: "abc123",
        fetchImpl,
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({
      buildRevisionConfigured: true,
      mode: "hosted-official-app",
      ready: "ready",
      serviceName: "agent-teams-control-plane",
      serviceVersion: "0.0.0",
    });
  });

  it("fails when health or readiness payloads expose secret-looking values", () => {
    expect(() =>
      assertNoSecretLeak({
        service: {
          build: {},
          name: "agent-teams-control-plane",
          version: "private-key",
        },
      }),
    ).toThrow(/secret-looking/);
  });
});
