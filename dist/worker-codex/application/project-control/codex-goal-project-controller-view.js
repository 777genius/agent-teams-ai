import { LaunchPlanStatus, buildControlledAgentLiveControllerState, } from "@vioxen/subscription-runtime/worker-core";
import { projectControllerAllowedTools, projectControllerProfileReadyJson, } from "./codex-goal-project-controller-profile.js";
export function projectControllerViewBase(input) {
    return input;
}
export function projectControllerLaunchPlanViewJson(input) {
    const ready = input.plan.status === LaunchPlanStatus.Ready;
    return {
        ok: ready,
        mode: "project_controller_launch_plan",
        ...input.base,
        rawShellMode: input.rawShellMode ?? "disabled-by-provider",
        status: input.plan.status,
        ...(ready
            ? {
                session: input.plan.session,
                ...projectControllerProfileReadyJson(input.profile),
                evidence: input.plan.evidence,
            }
            : {
                reason: input.plan.reason,
                accessReason: input.plan.accessReason,
                evidence: input.plan.evidence,
                allowedTools: projectControllerAllowedTools(input.profile),
                safeMessage: "Controlled LLM controller launch is blocked until the provider can enforce broker-only tools without raw shell.",
            }),
    };
}
export function projectControllerStartLaunchBlockedViewJson(input) {
    return {
        ok: false,
        mode: "project_controller_start",
        ...input.base,
        status: input.plan.status,
        reason: input.plan.reason,
        accessReason: input.plan.accessReason,
        evidence: input.plan.evidence,
        safeMessage: "Controlled LLM controller start is blocked by the fail-closed launch plan.",
    };
}
export function projectControllerStartExistingRunViewJson(input) {
    return {
        ok: false,
        mode: "project_controller_start",
        ...input.base,
        reason: input.result.reason,
        session: input.result.session,
        run: input.result.run,
        safeMessage: "Controlled LLM controller already has an active run. Use status, stop or reconcile before starting another run.",
    };
}
export function projectControllerStartUseCaseBlockedViewJson(input) {
    return {
        ok: false,
        mode: "project_controller_start",
        ...input.base,
        status: input.result.plan.status,
        reason: input.result.plan.reason,
        evidence: input.result.plan.evidence,
        safeMessage: "Controlled LLM controller start was blocked by the controlled-agent use case.",
    };
}
export function projectControllerStartReadyViewJson(input) {
    return {
        ok: true,
        mode: "project_controller_start",
        ...input.base,
        status: input.result.run.status,
        run: input.result.run,
        provider: input.result.provider,
        liveController: buildControlledAgentLiveControllerState({
            session: input.result.session,
            providerAttached: true,
            currentOwner: input.owner,
        }),
        ...(input.providerEvidence.account === undefined
            ? {}
            : { account: input.providerEvidence.account }),
        ...(input.providerEvidence.sessionArtifact === undefined
            ? {}
            : { sessionArtifact: input.providerEvidence.sessionArtifact }),
        allowedTools: projectControllerAllowedTools(input.profile),
        safeMessage: input.providerEvidence.safeMessage,
        evidence: input.plan.evidence,
    };
}
export function projectControllerStatusViewJson(input) {
    const liveController = input.result.ok
        ? buildControlledAgentLiveControllerState({
            session: input.result.session,
            providerAttached: input.providerAttached,
            currentOwner: input.owner,
            providerObservedStatus: input.observed?.status,
            providerStatusFailed: input.providerStatusError !== undefined,
        })
        : buildControlledAgentLiveControllerState({
            providerAttached: false,
            currentOwner: input.owner,
        });
    return {
        ok: input.result.ok,
        mode: "project_controller_status",
        ...input.base,
        reason: input.providerStatusError === undefined
            ? input.result.reason
            : "provider_status_failed",
        ...(input.result.session === undefined ? {} : { session: input.result.session }),
        ...(input.result.ok && "run" in input.result ? { run: input.result.run } : {}),
        ...(input.observed === undefined ? {} : { providerObserved: input.observed }),
        ...(input.providerStatusError === undefined
            ? {}
            : { providerObservedError: { safeMessage: input.providerStatusError } }),
        liveController,
        safeMessage: input.providerStatusError !== undefined
            ? "Controller state is persisted, but provider status failed in this MCP process."
            : input.result.ok
                ? input.providerAttached
                    ? "Controller state is persisted and provider liveness was observed in this MCP process."
                    : "Controller state is persisted, but provider liveness is unavailable in this MCP process."
                : "No persisted controlled-agent session/run exists for this controller.",
    };
}
export function projectControllerStopProviderResultViewJson(input) {
    return {
        ok: input.stopped.ok,
        mode: "project_controller_stop",
        ...input.base,
        reason: input.stopped.reason,
        ...(input.stopped.ok
            ? { session: input.stopped.session, run: input.stopped.run }
            : {}),
        liveController: buildControlledAgentLiveControllerState({
            session: input.stopped.ok ? input.stopped.session : input.statusResult.session,
            providerAttached: false,
            currentOwner: input.owner,
        }),
        safeMessage: input.stopped.ok
            ? "Controlled-agent provider stopped through the safe provider adapter."
            : "Controlled-agent stop failed before reaching provider stop.",
    };
}
export function projectControllerStopDisconnectedViewJson(input) {
    return {
        ok: false,
        mode: "project_controller_stop",
        ...input.base,
        reason: input.result.ok
            ? "controlled_agent_provider_runner_not_connected"
            : input.result.reason,
        ...(input.result.ok ? { session: input.result.session, run: input.result.run } : {}),
        liveController: buildControlledAgentLiveControllerState({
            session: input.result.ok ? input.result.session : undefined,
            providerAttached: false,
            currentOwner: input.owner,
        }),
        safeMessage: input.result.ok
            ? "A safe provider runner is required to stop a live controlled-agent controller. Do not kill unrelated processes or use danger_full_access from this tool."
            : "No persisted controlled-agent run exists to stop.",
    };
}
export function projectControllerReconcileProviderResultViewJson(input) {
    return {
        ok: input.reconciled.ok,
        mode: "project_controller_reconcile",
        ...input.base,
        reason: input.reconciled.reason,
        ...(input.reconciled.session === undefined
            ? {}
            : { session: input.reconciled.session }),
        ...(input.reconciled.run === undefined ? {} : { run: input.reconciled.run }),
        liveController: buildControlledAgentLiveControllerState({
            session: input.reconciled.session,
            providerAttached: true,
            currentOwner: input.owner,
        }),
        ...(input.reconciled.ok || input.reconciled.safeMessage === undefined
            ? {}
            : { safeMessage: input.reconciled.safeMessage }),
    };
}
export function projectControllerReconcileDisconnectedViewJson(input) {
    return {
        ok: false,
        mode: "project_controller_reconcile",
        ...input.base,
        reason: input.result.ok
            ? "controlled_agent_provider_runner_not_connected"
            : input.result.reason,
        ...(input.result.ok ? { session: input.result.session, run: input.result.run } : {}),
        liveController: buildControlledAgentLiveControllerState({
            session: input.result.ok ? input.result.session : undefined,
            providerAttached: false,
            currentOwner: input.owner,
        }),
        safeMessage: input.result.ok
            ? "A safe provider runner is required to reconcile provider liveness. Persisted state is available, but runtime liveness cannot be asserted."
            : "No persisted controlled-agent run exists to reconcile.",
    };
}
//# sourceMappingURL=codex-goal-project-controller-view.js.map