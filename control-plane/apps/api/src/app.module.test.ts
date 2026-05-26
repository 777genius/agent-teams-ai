import "reflect-metadata";

import { Controller, Get } from "@nestjs/common";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";

import { createSafeError } from "@agent-teams-control-plane/shared";
import {
  CONTROL_PLANE_LOGGER,
  type ControlPlaneLogger,
} from "@agent-teams-control-plane/platform-logger";

import { ApiAppModule } from "./app.module.js";

type InjectCapableFastify = Readonly<{
  ready(): PromiseLike<unknown>;
  inject(
    input: Readonly<{
      headers?: Record<string, string>;
      method: string;
      url: string;
    }>,
  ): Promise<{
    headers: Record<string, string | string[] | undefined>;
    statusCode: number;
    json(): unknown;
  }>;
}>;

@Controller("test-errors")
class TestErrorsController {
  @Get("safe")
  public safeError(): never {
    throw createSafeError({
      category: "validation",
      code: "CONTROL_PLANE_TEST_VALIDATION",
      message: "Validation failed.",
      safeDetails: { field: "workspaceId" },
    });
  }

  @Get("unknown")
  public unknownError(): never {
    throw new Error("private-key-secret");
  }
}

describe("ApiAppModule", () => {
  it("serves GET /health", async () => {
    const restoreEnv = setApiTestEnv();
    let app: NestFastifyApplication | undefined;

    try {
      const testApp = await createTestApp();
      app = testApp.app;
      const response = await testApp.fastify.inject({
        headers: { "x-correlation-id": "incoming-correlation-1" },
        method: "GET",
        url: "/health",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-correlation-id"]).toBe("incoming-correlation-1");
      expect(response.headers["x-request-id"]).toEqual(expect.any(String));
      const body = response.json();
      expect(body).toMatchObject({
        mode: "local-disabled",
        service: {
          build: {
            createdAt: "2026-05-26T10:20:30.000Z",
            revision: "abc123",
          },
          name: "agent-teams-control-plane",
          version: "0.0.0",
        },
        status: "ok",
      });
      expect(JSON.stringify(body)).not.toContain("private-key-secret");
    } finally {
      restoreEnv();
      await app?.close();
    }
  });

  it("serializes SafeError values through the public error contract", async () => {
    const restoreEnv = setApiTestEnv();
    let app: NestFastifyApplication | undefined;

    try {
      const testApp = await createTestApp();
      app = testApp.app;
      const response = await testApp.fastify.inject({
        headers: { "x-correlation-id": "incoming-correlation-2" },
        method: "GET",
        url: "/test-errors/safe",
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers["x-correlation-id"]).toBe("incoming-correlation-2");
      expect(response.json()).toEqual({
        error: {
          category: "validation",
          code: "CONTROL_PLANE_TEST_VALIDATION",
          correlationId: "incoming-correlation-2",
          message: "Validation failed.",
          retryable: false,
          safeDetails: { field: "workspaceId" },
        },
      });
    } finally {
      restoreEnv();
      await app?.close();
    }
  });

  it("converts unknown exceptions to non-leaky internal errors", async () => {
    const restoreEnv = setApiTestEnv();
    let app: NestFastifyApplication | undefined;

    try {
      const testApp = await createTestApp();
      app = testApp.app;
      const response = await testApp.fastify.inject({
        headers: { "x-correlation-id": "incoming-correlation-3" },
        method: "GET",
        url: "/test-errors/unknown",
      });

      expect(response.statusCode).toBe(500);
      expect(response.headers["x-correlation-id"]).toBe("incoming-correlation-3");
      expect(response.json()).toEqual({
        error: {
          category: "internal",
          code: "CONTROL_PLANE_INTERNAL_ERROR",
          correlationId: "incoming-correlation-3",
          message: "Internal control-plane error.",
          retryable: false,
        },
      });
      expect(JSON.stringify(response.json())).not.toContain("private-key-secret");
    } finally {
      restoreEnv();
      await app?.close();
    }
  });
});

async function createTestApp(): Promise<{
  app: NestFastifyApplication;
  fastify: InjectCapableFastify;
}> {
  const moduleRef = await Test.createTestingModule({
    controllers: [TestErrorsController],
    imports: [ApiAppModule],
  })
    .overrideProvider(CONTROL_PLANE_LOGGER)
    .useValue(createSilentLogger())
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ logger: false }),
  );

  await app.init();

  const fastify = app.getHttpAdapter().getInstance() as unknown as InjectCapableFastify;
  await fastify.ready();

  return { app, fastify };
}

function setApiTestEnv(): () => void {
  const previousBuildCreatedAt = process.env.CONTROL_PLANE_BUILD_CREATED_AT;
  const previousBuildRevision = process.env.CONTROL_PLANE_BUILD_REVISION;
  const previousMode = process.env.CONTROL_PLANE_MODE;
  const previousPrivateKey = process.env.CONTROL_PLANE_GITHUB_PRIVATE_KEY;
  process.env.CONTROL_PLANE_BUILD_CREATED_AT = "2026-05-26T10:20:30.000Z";
  process.env.CONTROL_PLANE_BUILD_REVISION = "abc123";
  process.env.CONTROL_PLANE_GITHUB_PRIVATE_KEY = "private-key-secret";
  process.env.CONTROL_PLANE_MODE = "local-disabled";

  return () => {
    if (previousBuildCreatedAt === undefined) {
      delete process.env.CONTROL_PLANE_BUILD_CREATED_AT;
    } else {
      process.env.CONTROL_PLANE_BUILD_CREATED_AT = previousBuildCreatedAt;
    }
    if (previousBuildRevision === undefined) {
      delete process.env.CONTROL_PLANE_BUILD_REVISION;
    } else {
      process.env.CONTROL_PLANE_BUILD_REVISION = previousBuildRevision;
    }
    if (previousMode === undefined) {
      delete process.env.CONTROL_PLANE_MODE;
    } else {
      process.env.CONTROL_PLANE_MODE = previousMode;
    }
    if (previousPrivateKey === undefined) {
      delete process.env.CONTROL_PLANE_GITHUB_PRIVATE_KEY;
    } else {
      process.env.CONTROL_PLANE_GITHUB_PRIVATE_KEY = previousPrivateKey;
    }
  };
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
