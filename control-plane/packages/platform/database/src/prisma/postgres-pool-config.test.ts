import { describe, expect, it } from "vitest";

import { buildPostgresPoolConfig } from "./postgres-pool-config.js";

describe("buildPostgresPoolConfig", () => {
  it("applies configured pool size and ssl mode", () => {
    const config = buildPostgresPoolConfig({
      poolMax: 17,
      sslMode: "require",
      url: "postgresql://user:pass@example.test:5432/control_plane",
    });

    expect(config.max).toBe(17);
    expect(config.connectionString).toContain("sslmode=require");
    expect(config.connectionString).toContain("uselibpqcompat=true");
  });

  it("preserves explicit sslmode from the database url", () => {
    const config = buildPostgresPoolConfig({
      poolMax: 5,
      sslMode: "require",
      url: "postgresql://example.test/control_plane?sslmode=disable",
    });

    expect(config.connectionString).toContain("sslmode=disable");
    expect(config.connectionString).not.toContain("uselibpqcompat=true");
  });
});
