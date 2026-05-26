import { describe, expect, it } from "vitest";

import { createControlPlaneServiceInfo } from "./service-info.js";

describe("service info", () => {
  it("creates stable service info with optional build metadata", () => {
    expect(
      createControlPlaneServiceInfo({
        createdAt: "2026-05-26T10:20:30.000Z",
        revision: "abc123",
      }),
    ).toEqual({
      build: {
        createdAt: "2026-05-26T10:20:30.000Z",
        revision: "abc123",
      },
      name: "agent-teams-control-plane",
      version: "0.0.0",
    });
  });

  it("keeps the build shape stable when metadata is absent", () => {
    expect(createControlPlaneServiceInfo()).toEqual({
      build: {},
      name: "agent-teams-control-plane",
      version: "0.0.0",
    });
  });
});
