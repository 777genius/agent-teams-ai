import { join } from "node:path";
import { LocalFileWorkerControlInboxStore } from "@vioxen/subscription-runtime/store-local-file";
import { WorkerControlService, } from "@vioxen/subscription-runtime/worker-core";
import { codexAccountStatusPayload } from "./codex-goal-accounts.js";
export function codexGoalWorkerControlService(launch) {
    return new WorkerControlService({
        store: new LocalFileWorkerControlInboxStore({
            rootDir: codexGoalStateRootDir(launch),
        }),
    });
}
export function codexGoalWorkerControlTarget(input) {
    return {
        jobId: input.manifest.jobId,
        taskId: input.launch.config.taskId,
        workspaceId: input.launch.config.workspacePath,
    };
}
export function codexGoalStateRootDir(launch) {
    return launch.config.stateRootDir ?? join(launch.config.jobRootDir, "state");
}
export async function codexGoalAccountStatusPayload(launch, options = {}) {
    return codexAccountStatusPayload({
        authRootDir: launch.config.authRootDir,
        stateRootDir: codexGoalStateRootDir(launch),
        accounts: launch.config.accounts.map((account) => account.name),
        ...options,
    });
}
//# sourceMappingURL=codex-goal-worker-control.js.map