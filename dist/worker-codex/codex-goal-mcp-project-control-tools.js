import { z } from "zod";
import { registerProjectIntegrationMcpTools, } from "./project-integration-mcp/index.js";
import { createLocalProjectIntegrationMcpToolHandlers, } from "./project-integration-mcp/adapters/local-project-integration-mcp-tool-handlers.js";
import { jobIdInputSchema, jobRegistryInputSchema, } from "./codex-goal-mcp-inputs.js";
import { goalInputSchema, } from "./codex-goal-mcp-input-schemas.js";
import { mcpJson, withMcpErrors, } from "./codex-goal-mcp-response.js";
import { projectControlAdmissionSnapshotView, projectControlRepairJobManifestView, projectControlUpdateControllerScopeView, } from "./codex-goal-mcp-project-control-admin.js";
import { projectControlCreateWorktreeView, projectControlIntegrateCommitView, projectControlMarkReviewedView, projectControlPushBranchView, projectControlStartStoredJobView, projectControlStopStoredJobView, } from "./codex-goal-mcp-project-control-actions.js";
import { projectControlCreateCodexGoalJobView, projectControlOperationStatusView, projectControlRefillWorkerView, } from "./codex-goal-mcp-project-control-jobs.js";
import { projectControllerConsumeGuidanceView, projectControllerLaunchPlanView, projectControllerReconcileView, projectControllerStartView, projectControllerStatusView, projectControllerStopView, } from "./codex-goal-mcp-project-controller.js";
import { codexProjectAdmissionDeps, codexProjectControlBroker, loadJobLaunch, loadProjectControlController, } from "./codex-goal-mcp-project-control-deps.js";
import { projectControlPathArg, } from "./codex-goal-mcp-project-scope.js";
import { projectIntegrationPushApprovedCommitWithConsumedLedger, } from "./codex-goal-mcp-project-integration-ledger.js";
const serverVersion = process.env.npm_package_version ?? "0.0.0";
const projectAdmissionWorkerRoleSchemaValues = [
    "producer",
    "fastgate",
    "reviewer",
    "integration",
    "adoption",
    "read_only",
];
const projectAdmissionRefillWorkerRoleSchemaValues = [
    "producer",
    "fastgate",
    "reviewer",
];
const projectAdmissionOperationSchemaValues = [
    "create_job",
    "start_worker",
    "create_worktree",
];
const controllerProviderKindSchemaValues = [
    "codex",
    "claude",
];
export function registerCodexGoalProjectControlTools(server) {
    server.registerTool("codex_goal_project_create_job", {
        title: "Project Control Create Codex Goal Job",
        description: "Create a child Codex goal job through a ProjectScopedControl controller manifest and broker policy.",
        inputSchema: {
            ...goalInputSchema(),
            ...jobRegistryInputSchema(),
            controllerJobId: z.string().optional(),
            description: z.string().optional(),
            tags: z.union([z.string(), z.array(z.string())]).optional(),
            workerRole: z.enum(projectAdmissionWorkerRoleSchemaValues).optional(),
            overwrite: z.boolean().optional(),
            confirmCreate: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControlCreateCodexGoalJob(args)));
    server.registerTool("codex_goal_project_refill_worker", {
        title: "Project Control Refill Worker",
        description: "Create a scoped worktree, write a prompt, create a child job and optionally start it through one ProjectScopedControl broker flow.",
        inputSchema: {
            ...goalInputSchema(),
            ...jobRegistryInputSchema(),
            controllerJobId: z.string().optional(),
            sourceWorkspacePath: z.string().optional(),
            baseBranch: z.string().optional(),
            promptBody: z.string().optional(),
            workerRole: z.enum(projectAdmissionRefillWorkerRoleSchemaValues).optional(),
            description: z.string().optional(),
            tags: z.union([z.string(), z.array(z.string())]).optional(),
            overwrite: z.boolean().optional(),
            skipDoctor: z.boolean().optional(),
            startWorker: z.boolean().optional(),
            dependencyBootstrap: z.enum(["off", "preflight", "install"]).optional(),
            confirmDependencyBootstrap: z.boolean().optional(),
            executionMode: z.enum(["sync", "bounded", "async"]).optional(),
            confirmRefill: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControlRefillWorker(args)));
    server.registerTool("codex_goal_project_operation_status", {
        title: "Project Control Operation Status",
        description: "Read a durable async ProjectScopedControl operation status handle created by bounded project-control tools.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            controllerJobId: z.string().optional(),
            operationId: z.string(),
            includeResult: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControlOperationStatus(args)));
    server.registerTool("codex_goal_project_admission_snapshot", {
        title: "Project Admission Snapshot",
        description: "Read project output debt used by the ProjectScopedControl admission gate. This is read-only.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            controllerJobId: z.string().optional(),
            operation: z.enum(projectAdmissionOperationSchemaValues).optional(),
            workerRole: z.enum(projectAdmissionWorkerRoleSchemaValues).optional(),
            includeDetails: z.boolean().optional(),
            maxDebtItems: z.number().int().min(0).optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControlAdmissionSnapshot(args)));
    server.registerTool("codex_goal_project_update_controller_scope", {
        title: "Project Control Update Controller Scope",
        description: "Safely repair limited ProjectScopedControl controller scope fields through a brokered manifest update path.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            controllerJobId: z.string().optional(),
            projectAccessScope: z.record(z.string(), z.unknown()).optional(),
            confirmUpdate: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControlUpdateControllerScope(args)));
    server.registerTool("brokered_project_manifest_repair", {
        title: "Brokered Project Manifest Repair",
        description: "Safely repair limited project-owned child job manifest fields through a ProjectScopedControl controller.",
        inputSchema: {
            ...jobIdInputSchema(),
            controllerJobId: z.string().optional(),
            accounts: z.union([z.string(), z.array(z.string())]).optional(),
            description: z.string().optional(),
            tags: z.union([z.string(), z.array(z.string())]).optional(),
            confirmRepair: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControlRepairJobManifest(args)));
    server.registerTool("codex_goal_project_controller_launch_plan", {
        title: "Project Controller Controlled-Agent Launch Plan",
        description: "Build a fail-closed broker-only LLM controller launch plan for a ProjectScopedControl controller manifest. Does not start an LLM.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            controllerJobId: z.string().optional(),
            providerKind: z.enum(controllerProviderKindSchemaValues).optional(),
            stateDir: z.string().optional(),
            sessionArtifactPath: z.string().optional(),
            claudePath: z.string().optional(),
            mcpServerName: z.string().optional(),
            mcpCommand: z.string().optional(),
            mcpArgs: z.union([z.string(), z.array(z.string())]).optional(),
            mcpCwd: z.string().optional(),
            rawShellMode: z.enum([
                "disabled-by-provider",
                "sandboxed-deny-rules-only",
            ]).optional(),
            maxGoalTurns: z.number().int().positive().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControllerLaunchPlan(args)));
    server.registerTool("codex_goal_project_controller_start", {
        title: "Project Controller Controlled-Agent Start",
        description: "Start a broker-only LLM controller when the provider adapter can enforce the controlled-agent launch plan. Fails closed when no safe provider runner is available.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            controllerJobId: z.string().optional(),
            providerKind: z.enum(controllerProviderKindSchemaValues).optional(),
            stateDir: z.string().optional(),
            sessionArtifactPath: z.string().optional(),
            claudePath: z.string().optional(),
            mcpServerName: z.string().optional(),
            mcpCommand: z.string().optional(),
            mcpArgs: z.union([z.string(), z.array(z.string())]).optional(),
            mcpCwd: z.string().optional(),
            rawShellMode: z.enum([
                "disabled-by-provider",
                "sandboxed-deny-rules-only",
            ]).optional(),
            maxGoalTurns: z.number().int().positive().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControllerStart(args)));
    server.registerTool("codex_goal_project_controller_status", {
        title: "Project Controller Controlled-Agent Status",
        description: "Read the persisted controlled-agent controller session/run state for a ProjectScopedControl manifest.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            controllerJobId: z.string().optional(),
            providerKind: z.enum(controllerProviderKindSchemaValues).optional(),
            stateDir: z.string().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControllerStatus(args)));
    server.registerTool("codex_goal_project_controller_consume_guidance", {
        title: "Project Controller Consume Guidance",
        description: "Consume pending control guidance for the ProjectScopedControl controller's own inbox and record delivery receipts. Does not consume child-worker inboxes.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            controllerJobId: z.string().optional(),
            deliveryAttemptId: z.string().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControllerConsumeGuidance(args)));
    server.registerTool("codex_goal_project_controller_stop", {
        title: "Project Controller Controlled-Agent Stop",
        description: "Stop a broker-only LLM controller through its provider adapter. Fails closed while no safe provider runner is connected.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            controllerJobId: z.string().optional(),
            providerKind: z.enum(controllerProviderKindSchemaValues).optional(),
            stateDir: z.string().optional(),
            reason: z.string().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControllerStop(args)));
    server.registerTool("codex_goal_project_controller_reconcile", {
        title: "Project Controller Controlled-Agent Reconcile",
        description: "Reconcile a broker-only LLM controller run through its provider adapter. Fails closed while no safe provider runner is connected.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            controllerJobId: z.string().optional(),
            providerKind: z.enum(controllerProviderKindSchemaValues).optional(),
            stateDir: z.string().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControllerReconcile(args)));
    server.registerTool("codex_goal_project_start", {
        title: "Project Control Start Codex Goal Worker",
        description: "Start a stored Codex goal worker through a ProjectScopedControl controller manifest and broker policy.",
        inputSchema: {
            ...jobIdInputSchema(),
            controllerJobId: z.string().optional(),
            confirmStart: z.boolean().optional(),
            forceStart: z.boolean().optional(),
            skipDoctor: z.boolean().optional(),
            dependencyBootstrap: z.enum(["off", "preflight", "install"]).optional(),
            confirmDependencyBootstrap: z.boolean().optional(),
            staleAfterMs: z.number().int().positive().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControlStartStoredJob(args)));
    server.registerTool("codex_goal_project_create_worktree", {
        title: "Project Control Create Git Worktree",
        description: "Create a project git worktree through a ProjectScopedControl controller manifest and broker policy.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            controllerJobId: z.string().optional(),
            sourceWorkspacePath: z.string().optional(),
            path: z.string().optional(),
            baseBranch: z.string().optional(),
            sourceRef: z.string().optional(),
            newBranch: z.string().optional(),
            workerRole: z.enum(projectAdmissionWorkerRoleSchemaValues).optional(),
            dependencyBootstrap: z.enum(["off", "preflight", "install"]).optional(),
            confirmDependencyBootstrap: z.boolean().optional(),
            confirmCreateWorktree: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControlCreateWorktree(args)));
    server.registerTool("codex_goal_project_integrate_commit", {
        title: "Project Control Integrate Git Commit",
        description: "Cherry-pick a reviewed commit into a scoped project worktree through broker policy.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            controllerJobId: z.string().optional(),
            workspacePath: z.string().optional(),
            branch: z.string().optional(),
            commitSha: z.string().optional(),
            confirmIntegrate: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControlIntegrateCommit(args)));
    server.registerTool("codex_goal_project_push_branch", {
        title: "Project Control Push Git Branch",
        description: "Push an allowed project branch through broker policy. Force uses --force-with-lease and must be allowed by scope.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            controllerJobId: z.string().optional(),
            workspacePath: z.string().optional(),
            branch: z.string().optional(),
            remote: z.string().optional(),
            force: z.boolean().optional(),
            confirmPush: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControlPushBranch(args)));
    const projectIntegrationHandlers = createLocalProjectIntegrationMcpToolHandlers({
        loadController: loadProjectControlController,
        resolvePathArg: projectControlPathArg,
    });
    registerProjectIntegrationMcpTools(server, {
        openAttempt: (args) => withMcpErrors(async () => projectIntegrationHandlers.openAttempt(args)),
        applyWorkerOutput: (args) => withMcpErrors(async () => projectIntegrationHandlers.applyWorkerOutput(args)),
        runRequiredChecks: (args) => withMcpErrors(async () => projectIntegrationHandlers.runRequiredChecks(args)),
        commitApprovedChanges: (args) => withMcpErrors(async () => projectIntegrationHandlers.commitApprovedChanges(args)),
        pushApprovedCommit: (args) => withMcpErrors(async () => projectIntegrationPushApprovedCommitWithConsumedLedger({
            args,
            loadController: loadProjectControlController,
            pushApprovedCommitHandler: projectIntegrationHandlers.pushApprovedCommit,
        })),
        rejectAttempt: (args) => withMcpErrors(async () => projectIntegrationHandlers.rejectAttempt(args)),
    });
    server.registerTool("codex_goal_project_stop", {
        title: "Project Control Stop Codex Goal Worker",
        description: "Stop a stored Codex goal worker through a ProjectScopedControl controller manifest and broker policy.",
        inputSchema: {
            ...jobIdInputSchema(),
            controllerJobId: z.string().optional(),
            confirmStop: z.boolean().optional(),
            forceStop: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControlStopStoredJob(args)));
    server.registerTool("codex_goal_project_mark_reviewed", {
        title: "Project Control Mark Codex Goal Reviewed",
        description: "Write a review marker for a stored job through a ProjectScopedControl controller manifest and broker policy.",
        inputSchema: {
            ...jobIdInputSchema(),
            controllerJobId: z.string().optional(),
            note: z.string().optional(),
        },
    }, async (args) => withMcpErrors(async () => projectControlMarkReviewed(args)));
}
function projectControlAdminDeps() {
    return {
        loadProjectControlController,
        admissionDeps: codexProjectAdmissionDeps,
    };
}
async function projectControlAdmissionSnapshot(args) {
    return mcpJson(await projectControlAdmissionSnapshotView(args, projectControlAdminDeps()));
}
async function projectControlUpdateControllerScope(args) {
    return mcpJson(await projectControlUpdateControllerScopeView(args, projectControlAdminDeps()));
}
async function projectControlRepairJobManifest(args) {
    return mcpJson(await projectControlRepairJobManifestView(args, projectControlAdminDeps()));
}
function projectControllerDeps() {
    return {
        loadProjectControlController,
        runtimeVersion: serverVersion,
    };
}
async function projectControllerLaunchPlan(args) {
    return mcpJson(await projectControllerLaunchPlanView(args, projectControllerDeps()));
}
async function projectControllerStart(args) {
    return mcpJson(await projectControllerStartView(args, projectControllerDeps()));
}
async function projectControllerStatus(args) {
    return mcpJson(await projectControllerStatusView(args, projectControllerDeps()));
}
async function projectControllerConsumeGuidance(args) {
    return mcpJson(await projectControllerConsumeGuidanceView(args, projectControllerDeps()));
}
async function projectControllerStop(args) {
    return mcpJson(await projectControllerStopView(args, projectControllerDeps()));
}
async function projectControllerReconcile(args) {
    return mcpJson(await projectControllerReconcileView(args, projectControllerDeps()));
}
function projectControlJobsDeps() {
    return {
        loadProjectControlController,
        codexProjectControlBroker,
    };
}
async function projectControlCreateCodexGoalJob(args) {
    return mcpJson(await projectControlCreateCodexGoalJobView(args, projectControlJobsDeps()));
}
async function projectControlRefillWorker(args) {
    return mcpJson(await projectControlRefillWorkerView(args, projectControlJobsDeps()));
}
async function projectControlOperationStatus(args) {
    return mcpJson(await projectControlOperationStatusView(args, projectControlJobsDeps()));
}
function projectControlActionDeps() {
    return {
        loadProjectControlController,
        loadJobLaunch,
        codexProjectControlBroker,
    };
}
async function projectControlStartStoredJob(args) {
    return mcpJson(await projectControlStartStoredJobView(args, projectControlActionDeps()));
}
async function projectControlCreateWorktree(args) {
    return mcpJson(await projectControlCreateWorktreeView(args, projectControlActionDeps()));
}
async function projectControlIntegrateCommit(args) {
    return mcpJson(await projectControlIntegrateCommitView(args, projectControlActionDeps()));
}
async function projectControlPushBranch(args) {
    return mcpJson(await projectControlPushBranchView(args, projectControlActionDeps()));
}
async function projectControlStopStoredJob(args) {
    return mcpJson(await projectControlStopStoredJobView(args, projectControlActionDeps()));
}
async function projectControlMarkReviewed(args) {
    return mcpJson(await projectControlMarkReviewedView(args, projectControlActionDeps()));
}
//# sourceMappingURL=codex-goal-mcp-project-control-tools.js.map