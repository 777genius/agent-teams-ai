import { collectCodexGoalStatus, resolveCodexGoalWorkerLiveness, } from "../codex-goal-ops.js";
import { codexGoalStatusInputFromLaunch as statusInput, } from "../codex-goal-mcp-status-input.js";
export async function codexGoalControlDeliveryDiagnostic(input) {
    const status = await collectCodexGoalStatus(statusInput(input.launch));
    return buildCodexGoalControlDeliveryDiagnostic({
        status,
        decision: input.decision,
        signal: input.signal,
        staleAfterMs: input.staleAfterMs ?? 10 * 60_000,
    });
}
export function buildCodexGoalControlDeliveryDiagnostic(input) {
    const progressStale = input.status.progressHeartbeatAgeMs !== undefined &&
        input.status.progressHeartbeatAgeMs > input.staleAfterMs;
    const workerLiveness = resolveCodexGoalWorkerLiveness({
        status: input.status,
        progressStale,
    });
    const pendingSignal = input.decision.pendingSignals.find((view) => view.signal.signalId === input.signal.signalId);
    const base = {
        workerAlive: workerLiveness.alive,
        workerSupervisorKind: workerLiveness.supervisorKind,
        workerAliveReason: workerLiveness.aliveReason,
        signalState: pendingSignal?.state ?? "unknown",
        deliveryMode: input.signal.deliveryMode,
        deliverable: pendingSignal?.deliverable ?? false,
    };
    if (workerLiveness.alive &&
        pendingSignal?.state === "pending" &&
        input.signal.deliveryMode === "next_safe_point") {
        return {
            ...base,
            reason: "pending_until_next_safe_point",
            recommendedTool: "codex_goal_send_guidance",
            safeMessage: "Worker appears alive and the signal is pending until the next safe continuation point. Use codex_goal_send_guidance when immediate guidance delivery is required.",
        };
    }
    return base;
}
//# sourceMappingURL=codex-goal-control-delivery-diagnostic.js.map