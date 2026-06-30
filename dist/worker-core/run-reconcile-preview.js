export async function reconcileRunPreview(input) {
    const policy = input.policy ?? {};
    const now = policy.now ?? new Date();
    const maxContinues = policy.maxContinuesPerRun ?? 1;
    const runIds = input.runIds ?? await input.backend.listRunIds();
    const inspected = await Promise.all(runIds.map(async (runId) => {
        try {
            return { ok: true, status: await input.backend.inspectRun(runId) };
        }
        catch (error) {
            return {
                ok: false,
                runId,
                reason: error instanceof Error ? error.message : "inspect_failed",
            };
        }
    }));
    const conflicts = workspaceConflictRunIds(inspected
        .filter((item) => item.ok)
        .map((item) => item.status));
    const decisions = [];
    let continued = 0;
    for (const item of inspected) {
        if (!item.ok) {
            decisions.push({
                runId: item.runId,
                action: "inspect_failed",
                reason: item.reason,
            });
            continue;
        }
        const status = item.status;
        const decision = await decideRunReconcilePreview({
            backend: input.backend,
            status,
            conflicts,
            now,
            continueSafeRuns: policy.continueSafeRuns === true,
            continueBudgetRemaining: Math.max(0, maxContinues - continued),
        });
        decisions.push(decision);
        if (decision.action === "continued")
            continued += 1;
    }
    return {
        ok: decisions.every((decision) => decision.action !== "inspect_failed" &&
            decision.action !== "blocked"),
        checked: decisions.length,
        continued,
        decisions,
    };
}
async function decideRunReconcilePreview(input) {
    const status = input.status;
    if (status.workerAlive) {
        return {
            runId: status.runId,
            action: "wait",
            reason: "worker_alive",
            status,
        };
    }
    if (status.requiresManualReview) {
        return {
            runId: status.runId,
            action: "manual_review",
            reason: status.manualReviewReason ?? "manual_review_required",
            status,
        };
    }
    if (status.workspaceDirty) {
        return {
            runId: status.runId,
            action: "manual_review",
            reason: "workspace_dirty",
            status,
        };
    }
    if (input.conflicts.has(status.runId)) {
        return {
            runId: status.runId,
            action: "blocked",
            reason: "single_writer_workspace_conflict",
            status,
        };
    }
    if (!status.safeToContinue) {
        return {
            runId: status.runId,
            action: "skipped",
            reason: "not_safe_to_continue",
            status,
        };
    }
    if (status.continueAfter && status.continueAfter.getTime() > input.now.getTime()) {
        return {
            runId: status.runId,
            action: "skipped",
            reason: "continue_cooldown",
            status,
        };
    }
    if (!input.continueSafeRuns) {
        return {
            runId: status.runId,
            action: "would_continue",
            reason: "dry_run",
            status,
        };
    }
    if (input.continueBudgetRemaining <= 0) {
        return {
            runId: status.runId,
            action: "skipped",
            reason: "max_continues_reached",
            status,
        };
    }
    return {
        runId: status.runId,
        action: "continued",
        reason: "safe_to_continue",
        status,
        result: await input.backend.continueRun(status.runId),
    };
}
function workspaceConflictRunIds(statuses) {
    const groups = new Map();
    for (const status of statuses) {
        if (!status.workspaceKey)
            continue;
        if (!status.workerAlive && !status.safeToContinue)
            continue;
        groups.set(status.workspaceKey, [
            ...(groups.get(status.workspaceKey) ?? []),
            status,
        ]);
    }
    const conflicts = new Set();
    for (const group of groups.values()) {
        if (group.length <= 1)
            continue;
        for (const status of group)
            conflicts.add(status.runId);
    }
    return conflicts;
}
//# sourceMappingURL=run-reconcile-preview.js.map