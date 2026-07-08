import { codexGoalJobToArgs, readCodexGoalJob, } from "../codex-goal-jobs.js";
import { goalLaunchInput } from "./codex-goal-launch-input.js";
import { requiredRawString } from "./codex-goal-input-values.js";
import { registryRootFromInput, } from "./codex-goal-use-case-inputs.js";
export async function loadJobLaunch(args) {
    const registryRootDir = registryRootFromInput(args);
    const manifest = await readCodexGoalJob({
        registryRootDir,
        jobId: requiredRawString(args.jobId, "jobId"),
    });
    return {
        registryRootDir,
        manifest,
        launch: await goalLaunchInput(codexGoalJobToArgs(manifest)),
    };
}
//# sourceMappingURL=codex-goal-job-launch-loader.js.map