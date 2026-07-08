import { AccessBoundary, evaluateProjectAdmission, } from "@vioxen/subscription-runtime/worker-core";
import { readCodexGoalJob, summarizeCodexGoalJob, updateCodexGoalJob, } from "./codex-goal-jobs.js";
import { parseCodexGoalProjectAccessScope, } from "./codex-goal-access-plan.js";
import { accountNames, booleanValue, requiredRawString, stringValue, tagValues, } from "./codex-goal-mcp-values.js";
import { projectControlAuditPath, } from "./codex-goal-mcp-project-broker.js";
import { buildCodexProjectAdmissionSnapshot, projectAdmissionDetailView, projectAdmissionOperation, projectAdmissionWorkerRoleArg, } from "./application/project-control/codex-goal-project-admission.js";
import { assertProjectControlScopeRepairAllowed, projectScopeFieldFingerprint, } from "./codex-goal-mcp-project-scope.js";
import { projectControlDefaultAccountNames, } from "./codex-goal-mcp-project-accounts.js";
import { matchesProjectControlPrefix, pathInsideAnyProjectRoot, } from "./codex-goal-mcp-project-utils.js";
export async function projectControlAdmissionSnapshotView(args, deps) {
    const controller = await deps.loadProjectControlController(args);
    const snapshot = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: controller.registryRootDir,
        scope: controller.scope,
        deps: deps.admissionDeps,
    });
    const operation = projectAdmissionOperation(args.operation);
    const workerRole = projectAdmissionWorkerRoleArg(args.workerRole);
    const decision = operation
        ? evaluateProjectAdmission({
            request: {
                operation,
                projectId: controller.scope.projectId,
                ...(workerRole ? { workerRole } : {}),
            },
            snapshot,
        })
        : undefined;
    const detailView = projectAdmissionDetailView({
        snapshot,
        ...(decision ? { decision } : {}),
        includeDetails: args.includeDetails === true,
        ...(args.maxDebtItems === undefined ? {} : { maxDebtItems: args.maxDebtItems }),
    });
    return {
        ok: true,
        mode: "project_admission_snapshot",
        controllerJobId: controller.controller.jobId,
        registryRootDir: controller.registryRootDir,
        snapshot: detailView.snapshot,
        ...(detailView.decision ? { decision: detailView.decision } : {}),
    };
}
export async function projectControlUpdateControllerScopeView(args, deps) {
    const controller = await deps.loadProjectControlController(args);
    const proposedScope = parseCodexGoalProjectAccessScope(args.projectAccessScope, "projectAccessScope");
    if (!proposedScope) {
        throw new Error("project_control_project_access_scope_required");
    }
    assertProjectControlScopeRepairAllowed({
        existing: controller.scope,
        proposed: proposedScope,
    });
    if (booleanValue(args.confirmUpdate) !== true) {
        return {
            ok: false,
            reason: "confirm_update_required",
            mode: "project_control_update_controller_scope",
            controllerJobId: controller.controller.jobId,
            registryRootDir: controller.registryRootDir,
            auditPath: projectControlAuditPath(controller.controller),
            currentConsumedOutputLedgerRoots: controller.scope.consumedOutputLedgerRoots ?? [],
            proposedConsumedOutputLedgerRoots: proposedScope.consumedOutputLedgerRoots ?? [],
        };
    }
    const manifest = await updateCodexGoalJob({
        registryRootDir: controller.registryRootDir,
        jobId: controller.controller.jobId,
        patch: { projectAccessScope: proposedScope },
    });
    return {
        ok: true,
        mode: "project_control_update_controller_scope",
        controllerJobId: controller.controller.jobId,
        registryRootDir: controller.registryRootDir,
        auditPath: projectControlAuditPath(controller.controller),
        manifest,
        summary: summarizeCodexGoalJob(manifest, controller.registryRootDir),
    };
}
export async function projectControlRepairJobManifestView(args, deps) {
    const controller = await deps.loadProjectControlController(args);
    const jobId = requiredRawString(args.jobId, "jobId");
    if (jobId === controller.controller.jobId) {
        return {
            ok: false,
            error: "project_control_controller_manifest_repair_unsupported",
            requiredTool: "codex_goal_project_update_controller_scope",
            safeMessage: "Controller manifests use codex_goal_project_update_controller_scope for scoped repairs.",
        };
    }
    const existing = await readCodexGoalJob({
        registryRootDir: controller.registryRootDir,
        jobId,
    });
    assertProjectControlRepairJobOwned({
        controllerScope: controller.scope,
        job: existing,
    });
    const patch = {};
    if (args.accounts !== undefined) {
        const requestedAccounts = accountNames(args.accounts);
        if (requestedAccounts.length === 0) {
            throw new Error("project_control_repair_accounts_required");
        }
        assertProjectControlRepairAccountsAllowed({
            accounts: requestedAccounts,
            allowedAccountIds: controller.scope.allowedAccountIds ?? [],
        });
        patch.accounts = requestedAccounts;
    }
    else {
        const repairedAccounts = await projectControlDefaultAccountNames({
            ...(existing.authRootDir ? { authRootDir: existing.authRootDir } : {}),
            requestedAccounts: existing.accounts,
            allowedAccountIds: controller.scope.allowedAccountIds ?? [],
        });
        if (projectScopeFieldFingerprint(existing.accounts) !==
            projectScopeFieldFingerprint(repairedAccounts)) {
            patch.accounts = repairedAccounts;
        }
    }
    if (args.description !== undefined) {
        patch.description = stringValue(args.description) ?? "";
    }
    if (args.tags !== undefined) {
        patch.tags = tagValues(args.tags);
    }
    if (Object.keys(patch).length === 0) {
        return {
            ok: true,
            mode: "brokered_project_manifest_repair",
            reason: "no_repair_needed",
            controllerJobId: controller.controller.jobId,
            registryRootDir: controller.registryRootDir,
            manifest: existing,
            summary: summarizeCodexGoalJob(existing, controller.registryRootDir),
        };
    }
    if (booleanValue(args.confirmRepair) !== true) {
        return {
            ok: false,
            reason: "confirm_repair_required",
            mode: "brokered_project_manifest_repair",
            controllerJobId: controller.controller.jobId,
            registryRootDir: controller.registryRootDir,
            jobId: existing.jobId,
            auditPath: projectControlAuditPath(controller.controller),
            proposedPatch: patch,
        };
    }
    const manifest = await updateCodexGoalJob({
        registryRootDir: controller.registryRootDir,
        jobId: existing.jobId,
        patch: patch,
    });
    return {
        ok: true,
        mode: "brokered_project_manifest_repair",
        controllerJobId: controller.controller.jobId,
        registryRootDir: controller.registryRootDir,
        auditPath: projectControlAuditPath(controller.controller),
        manifest,
        summary: summarizeCodexGoalJob(manifest, controller.registryRootDir),
    };
}
function assertProjectControlRepairJobOwned(input) {
    if (input.job.accessBoundary === AccessBoundary.ProjectScopedControl) {
        throw new Error("project_control_repair_child_job_required");
    }
    if (input.job.projectAccessScope?.projectId !== input.controllerScope.projectId) {
        throw new Error("project_control_repair_project_scope_mismatch");
    }
    const jobMatches = matchesProjectControlPrefix(input.job.jobId, input.controllerScope.jobIdPrefixes ?? []);
    const workspaceMatches = pathInsideAnyProjectRoot(input.job.workspacePath, [
        ...(input.controllerScope.workspaceRoots ?? []),
        ...(input.controllerScope.worktreeRoots ?? []),
        ...(input.controllerScope.isolatedWorkspaceRoot
            ? [input.controllerScope.isolatedWorkspaceRoot]
            : []),
    ]);
    if (!jobMatches && !workspaceMatches) {
        throw new Error("project_control_repair_job_scope_mismatch");
    }
}
function assertProjectControlRepairAccountsAllowed(input) {
    const allowed = new Set(input.allowedAccountIds);
    if (allowed.size === 0)
        return;
    const denied = input.accounts.filter((account) => !allowed.has(account));
    if (denied.length > 0) {
        throw new Error("project_control_repair_account_outside_scope");
    }
}
//# sourceMappingURL=codex-goal-mcp-project-control-admin.js.map