/// <reference types="node" />
import { type ControlledAgentProviderPort, type ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest } from "./codex-goal-jobs.js";
import type { CodexGoalLaunchInput } from "./codex-goal-ops.js";
import type { ProjectControllerLaunchPlanMcpArgs } from "./codex-goal-mcp-inputs.js";
import { type ProjectControllerProfile } from "./codex-goal-mcp-project-controller-profile.js";
type JsonObject = Readonly<Record<string, unknown>>;
export declare function projectControllerProvider(input: {
    readonly args: ProjectControllerLaunchPlanMcpArgs;
    readonly controller: {
        readonly controller: CodexGoalJobManifest;
        readonly registryRootDir: string;
        readonly scope: ProjectAccessScope;
    };
    readonly launch: CodexGoalLaunchInput;
    readonly profile: ProjectControllerProfile;
    readonly state: {
        readonly cwd: string;
    };
}): Promise<{
    readonly provider: ControlledAgentProviderPort;
    readonly account?: JsonObject;
    readonly sessionArtifact?: JsonObject;
    readonly safeMessage: string;
}>;
export declare function projectControllerPendingGuidancePromptContext(input: {
    readonly pendingCount: number;
    readonly deliverableSignals: readonly {
        readonly signal: {
            readonly createdAt: Date;
            readonly createdBy: string;
            readonly priority: string;
            readonly body: string;
        };
    }[];
}): string | undefined;
export {};
//# sourceMappingURL=codex-goal-mcp-project-controller-provider.d.ts.map