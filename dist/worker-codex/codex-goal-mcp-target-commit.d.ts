/// <reference types="node" />
import type { JobBriefMcpArgs } from "./codex-goal-mcp-inputs.js";
export declare function targetCommitFromArgs(args: Pick<JobBriefMcpArgs, "cwd" | "targetCommit" | "targetWorkspacePath">): Promise<string | undefined>;
export declare function optionalTargetCommit(targetCommit: string | undefined): {
    readonly targetCommit?: string;
};
//# sourceMappingURL=codex-goal-mcp-target-commit.d.ts.map