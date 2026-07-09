import { describe, expect, it } from "vitest";
import {
  CommandValidationDecisionReason,
  validateCommandAgainstPolicy,
} from "../index";

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
