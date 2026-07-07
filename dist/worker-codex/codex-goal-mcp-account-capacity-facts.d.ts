/// <reference types="node" />
import type { CodexGoalJobManifest } from "./codex-goal-jobs.js";
import type { CodexGoalLaunchInput } from "./codex-goal-ops.js";
type JsonObject = Readonly<Record<string, unknown>>;
export declare function codexGoalAccountCapacityFacts(input: {
    readonly manifest: CodexGoalJobManifest;
    readonly loadLaunch: (manifest: CodexGoalJobManifest) => Promise<CodexGoalLaunchInput>;
}): Promise<JsonObject>;
export {};
//# sourceMappingURL=codex-goal-mcp-account-capacity-facts.d.ts.map