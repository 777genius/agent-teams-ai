import { AccessBoundary, } from "@vioxen/subscription-runtime/worker-core";
import { listCodexGoalJobs, readCodexGoalJob, } from "./codex-goal-jobs.js";
import { registryRootFromArgs, } from "./codex-goal-mcp-inputs.js";
import { buildCodexGoalOverviewItem } from "./codex-goal-mcp-overview-item.js";
import { createCodexProjectControlBroker, } from "./codex-goal-mcp-project-broker.js";
import { requiredRawString } from "./codex-goal-mcp-values.js";
export { loadJobLaunch, } from "./application/codex-goal-job-launch-loader.js";
export async function loadProjectControlController(args) {
    const registryRootDir = registryRootFromArgs(args);
    const controller = await readCodexGoalJob({
        registryRootDir,
        jobId: requiredRawString(args.controllerJobId, "controllerJobId"),
    });
    if (controller.accessBoundary !== AccessBoundary.ProjectScopedControl) {
        throw new Error("project_control_controller_boundary_required");
    }
    if (!controller.projectAccessScope) {
        throw new Error("project_control_controller_scope_required");
    }
    return {
        registryRootDir,
        controller,
        scope: controller.projectAccessScope,
    };
}
export const codexProjectAdmissionDeps = {
    listJobs: listCodexGoalJobs,
    buildOverviewItem: (input) => buildCodexGoalOverviewItem(input),
};
export function codexProjectControlBroker(input) {
    return createCodexProjectControlBroker({
        ...input,
        admissionDeps: codexProjectAdmissionDeps,
    });
}
//# sourceMappingURL=codex-goal-mcp-project-control-deps.js.map