/// <reference types="node" />
import { type CodexGoalJobManifest } from "../codex-goal-jobs.js";
import type { CodexGoalLaunchInput } from "../codex-goal-ops.js";
import { type CodexGoalJobIdInput } from "./codex-goal-use-case-inputs.js";
export type LoadedCodexGoalJobLaunch = {
    readonly registryRootDir: string;
    readonly manifest: CodexGoalJobManifest;
    readonly launch: CodexGoalLaunchInput;
};
export declare function loadJobLaunch(args: CodexGoalJobIdInput): Promise<LoadedCodexGoalJobLaunch>;
//# sourceMappingURL=codex-goal-job-launch-loader.d.ts.map