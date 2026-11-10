import { captureClaudeExtraArgs } from "@agent-teams/provider-implementations/claude";
import { captureCodexExtraArgs } from "@agent-teams/provider-implementations/codex";
import { captureOpenCodeExtraArgs } from "@agent-teams/provider-implementations/opencode";
import { parseCliArgs } from "../team-launch/cliArgs.js";
import { TeamLaunchError } from "../team-launch/contracts.js";
import type { RuntimeMemberProfile } from "./runtimeProfile.js";

/** Saved app intent is tokenized once; D independently protects each selected native launch. */
export function captureRuntimeExtraArgs(
  recipes: readonly RuntimeMemberProfile[],
  raw: string | undefined,
): RuntimeMemberProfile[] {
  const tokens = parseCliArgs(raw);
  try {
    return recipes.map((recipe) => {
      const selected = [...(recipe.extraArgs ?? []), ...tokens];
      const captured =
        recipe.provider === "claude"
          ? captureClaudeExtraArgs(selected)
          : recipe.provider === "codex"
            ? captureCodexExtraArgs(selected)
            : captureOpenCodeExtraArgs(selected);
      const { extraArgs: _prior, ...base } = recipe;
      return {
        ...base,
        ...(captured.length ? { extraArgs: [...captured] } : {}),
      };
    });
  } catch {
    throw new TeamLaunchError("invalid", "runtime-extra-args-invalid");
  }
}
