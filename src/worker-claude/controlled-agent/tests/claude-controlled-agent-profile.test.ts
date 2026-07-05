import { describe, expect, it } from "vitest";
import {
  RunEventProviderKind,
  projectScopedControllerToolNames,
} from "@vioxen/subscription-runtime/worker-core";
import { buildClaudeControlledAgentProfile } from "../index";

describe("Claude controlled-agent profile", () => {
  it("exposes only strict broker MCP tools for a project-scoped controller", () => {
    const profile = buildClaudeControlledAgentProfile({
      stateDir: "/tmp/controller-state",
      mcpCommand: "subscription-runtime-codex-goal-mcp-test",
      mcpArgs: ["--stdio"],
      mcpCwd: "/tmp/runtime",
    });

    expect(profile.providerKind).toBe(RunEventProviderKind.Claude);
    expect(profile.configDir).toBe("/tmp/controller-state/claude-config");
    expect(profile.strictMcpConfig).toBe(true);
    expect(profile.allowedTools).toEqual(
      projectScopedControllerToolNames().map((toolName) =>
        `mcp__subscription_runtime_project_control__${toolName}`
      ),
    );
    expect(profile.allowedTools).not.toContain("Bash");
    expect(profile.allowedTools).not.toContain("Edit");
    expect(profile.allowedTools).not.toContain("Read");
    expect(profile.disallowedTools).toEqual(
      expect.arrayContaining(["Bash", "Edit", "Write", "Read", "Task"]),
    );
    expect(profile.appendSystemPrompt).toContain("Use only the configured MCP");
    expect(profile.enforcement).toMatchObject({
      providerKind: RunEventProviderKind.Claude,
      canRestrictToolSurface: true,
      canDisableRawShell: true,
    });

    const mcpConfig = JSON.parse(profile.mcpConfig) as {
      mcpServers: Record<string, {
        command: string;
        args: readonly string[];
        cwd?: string;
      }>;
    };
    expect(mcpConfig.mcpServers.subscription_runtime_project_control).toEqual({
      command: "subscription-runtime-codex-goal-mcp-test",
      args: ["--stdio"],
      cwd: "/tmp/runtime",
    });
  });

  it("rejects MCP server names that would produce ambiguous Claude tool names", () => {
    expect(() =>
      buildClaudeControlledAgentProfile({
        stateDir: "/tmp/controller-state",
        mcpServerName: "bad__server",
      }),
    ).toThrow("claude_controlled_agent_mcp_server_name_invalid");
  });
});
