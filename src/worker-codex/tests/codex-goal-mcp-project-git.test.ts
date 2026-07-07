import { describe, expect, it } from "vitest";
import {
  assertSafeGitCommitSha,
  assertSafeGitRefName,
  assertSafeGitRemoteName,
} from "../codex-goal-mcp-project-git";

describe("codex goal MCP project git safety", () => {
  it("accepts safe git refs, remotes and commit shas", () => {
    expect(() => assertSafeGitRefName("feature/slice-1", "branch")).not.toThrow();
    expect(() => assertSafeGitRemoteName("origin", "remote")).not.toThrow();
    expect(() => assertSafeGitRemoteName("upstream_2", "remote")).not.toThrow();
    expect(() => assertSafeGitCommitSha("abcdef1")).not.toThrow();
    expect(() => assertSafeGitCommitSha("0123456789abcdef0123456789abcdef01234567")).not.toThrow();
  });

  it("rejects unsafe branch and remote values before shelling out", () => {
    expect(() => assertSafeGitRefName("-bad", "branch")).toThrow(
      "project_control_branch_invalid",
    );
    expect(() => assertSafeGitRefName("feature/../main", "branch")).toThrow(
      "project_control_branch_invalid",
    );
    expect(() => assertSafeGitRefName("feature with space", "branch")).toThrow(
      "project_control_branch_invalid",
    );
    expect(() => assertSafeGitRemoteName("bad remote", "remote")).toThrow(
      "project_control_remote_invalid",
    );
    expect(() => assertSafeGitRemoteName("-origin", "remote")).toThrow(
      "project_control_remote_invalid",
    );
  });

  it("rejects non-hex or too-short commit identifiers", () => {
    expect(() => assertSafeGitCommitSha("abc123")).toThrow(
      "project_control_commit_sha_invalid",
    );
    expect(() => assertSafeGitCommitSha("zzzzzzz")).toThrow(
      "project_control_commit_sha_invalid",
    );
  });
});
