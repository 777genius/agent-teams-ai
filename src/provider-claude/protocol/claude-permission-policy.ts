import type { ProviderTaskControls } from "@vioxen/subscription-runtime/core";

export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "dontAsk";

export function mapClaudePermissionMode(
  editMode: ProviderTaskControls["editMode"] | undefined,
  providerSandboxMode:
    | ProviderTaskControls["providerSandboxMode"]
    | undefined,
): ClaudePermissionMode {
  assertClaudeProviderSandboxModeAllowed(editMode, providerSandboxMode);
  if (providerSandboxMode === "danger-full-access") return "bypassPermissions";
  if (editMode === "allow-edits") return "acceptEdits";
  if (editMode === "read-only") return "dontAsk";
  return "default";
}

export function assertClaudeReadOnlyToolPolicy(
  editMode: ProviderTaskControls["editMode"] | undefined,
  allowedTools: readonly string[] | undefined,
): void {
  if (editMode !== "read-only" || allowedTools === undefined) return;
  const unsafe = allowedTools.filter((tool) => !isReadOnlyClaudeTool(tool));
  if (unsafe.length === 0) return;
  throw new Error(
    `claude_read_only_allowed_tools_unsafe:${unsafe.join(",")}`,
  );
}

export function assertClaudeProviderSandboxModeAllowed(
  editMode: ProviderTaskControls["editMode"] | undefined,
  providerSandboxMode:
    | ProviderTaskControls["providerSandboxMode"]
    | undefined,
): void {
  if (providerSandboxMode === undefined || editMode === "allow-edits") return;
  throw new Error("claude_provider_sandbox_mode_requires_allow_edits");
}

const readOnlyClaudeTools = new Set([
  "Glob",
  "Grep",
  "LS",
  "Read",
  "TodoRead",
  "WebFetch",
]);

function isReadOnlyClaudeTool(tool: string): boolean {
  const name = tool.split("(", 1)[0]?.trim();
  return name !== undefined && readOnlyClaudeTools.has(name);
}
