import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostExecutableNotFoundMessage } from "@vioxen/subscription-runtime/worker-core";
import { resolveHostExecutable } from "../host-command";

describe("resolveHostExecutable", () => {
  it("finds binaries through explicit env fallbacks before PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-host-command-"));
    const binary = join(root, "tool");
    await writeFile(binary, "#!/bin/sh\nexit 0\n");
    await chmod(binary, 0o700);

    const resolution = await resolveHostExecutable({
      name: "tool",
      env: {
        TOOL_PATH: binary,
        PATH: "",
      },
      envNames: ["TOOL_PATH"],
    });

    expect(resolution).toMatchObject({
      executable: binary,
      found: true,
      source: "env",
      sourceName: "TOOL_PATH",
    });
  });

  it("reports checked candidates when a binary is missing", async () => {
    const resolution = await resolveHostExecutable({
      name: "missing-tool",
      env: {
        PATH: "/no/such/bin",
      },
      additionalCandidates: ["/also/missing/missing-tool"],
    });

    expect(resolution.found).toBe(false);
    expect(hostExecutableNotFoundMessage(resolution)).toContain(
      "missing-tool executable was not found.",
    );
    expect(hostExecutableNotFoundMessage(resolution)).toContain("/no/such/bin");
    expect(hostExecutableNotFoundMessage(resolution)).toContain("/also/missing");
  });
});
