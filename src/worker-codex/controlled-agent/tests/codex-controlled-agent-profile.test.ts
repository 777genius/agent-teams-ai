import { describe, expect, it } from "vitest";
import {
  RunEventProviderKind,
  projectScopedControllerToolNames,
} from "@vioxen/subscription-runtime/worker-core";

import { buildCodexControlledAgentProfile } from "../index";

describe("buildCodexControlledAgentProfile", () => {
  it("generates a Codex profile with only broker/status MCP tools enabled", () => {
    const profile = buildCodexControlledAgentProfile({
      stateDir: "/tmp/controller-state",
      mcpCommand: "subscription-runtime-codex-goal-mcp",
      mcpArgs: ["--stdio"],
      rawShellMode: "disabled-by-provider",
    });

    expect(profile.providerKind).toBe(RunEventProviderKind.Codex);
    expect(profile.codexHome).toBe("/tmp/controller-state/codex-home");
    expect(profile.enabledTools).toEqual(projectScopedControllerToolNames());
    expect(profile.configToml).toContain(
      '[mcp_servers.subscription_runtime_project_control]',
    );
    expect(profile.configToml).toContain(
      `enabled_tools = ${JSON.stringify(projectScopedControllerToolNames()).replaceAll(",", ", ")}`,
    );
    expect(profile.configToml).toContain('sandbox_mode = "read-only"');
    expect(profile.configToml).toContain('approval_policy = "never"');
    expect(profile.configToml).toContain('web_search = "disabled"');
    expect(profile.configToml).toContain('cli_auth_credentials_store = "file"');
    expect(profile.configToml).toContain("disable_response_storage = true");
    expect(profile.configToml).toContain("[features]");
    expect(profile.configToml).toContain("multi_agent = false");
    expect(profile.configToml).toContain("[history]");
    expect(profile.configToml).toContain('persistence = "none"');
    expect(profile.configToml).toContain("[otel]");
    expect(profile.configToml).toContain('exporter = "none"');
    expect(profile.configToml).toContain("[shell_environment_policy]");
    expect(profile.configToml).toContain('inherit = "none"');
    expect(profile.configToml).not.toContain("danger-full-access");
    expect(profile.enforcement).toMatchObject({
      providerKind: RunEventProviderKind.Codex,
      canRestrictToolSurface: true,
      canDisableRawShell: true,
    });
  });

  it("marks deny-rules-only raw shell handling as insufficient for live controller launch", () => {
    const profile = buildCodexControlledAgentProfile({
      stateDir: "/tmp/controller-state",
      rawShellMode: "sandboxed-deny-rules-only",
    });

    expect(profile.enforcement.canDisableRawShell).toBe(false);
    expect(profile.rulesText).toContain('pattern = ["git"]');
    expect(profile.rulesText).toContain('pattern = ["tmux"]');
    expect(profile.rulesText).toContain('pattern = ["bash", "-lc"]');
  });
});
