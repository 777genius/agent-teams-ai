import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CommandValidationDecisionReason,
  hostExecutableNotFoundMessage,
  resolveHostExecutable,
  validateCommandAgainstPolicy,
} from "../index";

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

describe("validateCommandAgainstPolicy", () => {
  it("keeps command validation available from the host-command seam", () => {
    const policy = {
      validateCommands: true,
      deniedExecutableNames: ["tmux"],
      deniedGitSubcommands: ["push"],
      deniedPathPrefixes: ["/var/data/worker-jobs/registry"],
      deniedInlineCodeExecutables: ["python3", "node"],
      deniedScriptExecutables: ["sh", "bash"],
    };

    expect(validateCommandAgainstPolicy({
      command: ["git", "status"],
      policy,
    })).toMatchObject({
      allowed: true,
      reason: CommandValidationDecisionReason.Allowed,
    });
    expect(validateCommandAgainstPolicy({
      command: ["/usr/bin/git", "push", "origin", "main"],
      policy,
    })).toMatchObject({
      allowed: false,
      reason: CommandValidationDecisionReason.DeniedGitSubcommand,
    });
    expect(validateCommandAgainstPolicy({
      command: "python3 -c print(1)",
      policy,
    })).toMatchObject({
      allowed: false,
      reason: CommandValidationDecisionReason.InlineCodeDenied,
    });
  });
});
