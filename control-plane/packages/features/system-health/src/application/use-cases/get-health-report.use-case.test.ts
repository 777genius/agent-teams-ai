import { describe, expect, it } from "vitest";

import { GetHealthReportUseCase } from "./get-health-report.use-case.js";

describe("GetHealthReportUseCase", () => {
  it("builds a health report without NestJS runtime", () => {
    const useCase = new GetHealthReportUseCase({
      read: () => ({
        build: {
          createdAt: "2026-05-26T10:20:30.000Z",
          revision: "abc123",
        },
        githubRestApiVersionConfigured: false,
        mode: "local-disabled",
        publicBaseUrlConfigured: false,
        uptimeSeconds: 12,
      }),
    });

    expect(useCase.execute()).toEqual({
      configuration: {
        githubRestApiVersionConfigured: false,
        publicBaseUrlConfigured: false,
      },
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
      uptimeSeconds: 12,
    });
  });
});
