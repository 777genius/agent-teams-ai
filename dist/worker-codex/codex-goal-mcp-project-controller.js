import { AccessBoundary, LaunchPlanStatus, NetworkAccessMode, getControlledAgentStatus, reconcileControlledAgentRun, startControlledAgentRun, stopControlledAgentRun, } from "@vioxen/subscription-runtime/worker-core";
import { projectControllerCapacityDemand, recordProjectControllerCapacitySignal, } from "./project-controller-capacity.js";
import { codexGoalJobToArgs, } from "./codex-goal-jobs.js";
import { goalLaunchInput, } from "./codex-goal-mcp-launch-input.js";
import { safeObservationErrorMessage, } from "./codex-goal-mcp-observation-projection.js";
import { projectControllerOptionsFromMcpArgs, } from "./codex-goal-mcp-project-controller-profile.js";
import { projectControllerLaunchInput, projectControllerProfile, projectControllerState, } from "./application/project-control/codex-goal-project-controller-profile.js";
import { projectControllerProviderKind, } from "./application/project-control/codex-goal-project-controller-options.js";
import { projectControllerProvider, } from "./codex-goal-mcp-project-controller-provider.js";
import { projectControllerOwnerIsLive, projectControllerProcessOwner, } from "./application/project-control/codex-goal-project-controller-runtime.js";
import { projectControllerLaunchPlanViewJson, projectControllerReconcileDisconnectedViewJson, projectControllerReconcileProviderResultViewJson, projectControllerStartExistingRunViewJson, projectControllerStartLaunchBlockedViewJson, projectControllerStartReadyViewJson, projectControllerStartUseCaseBlockedViewJson, projectControllerStatusViewJson, projectControllerStopDisconnectedViewJson, projectControllerStopProviderResultViewJson, projectControllerViewBase, } from "./application/project-control/codex-goal-project-controller-view.js";
import { stringValue, } from "./codex-goal-mcp-values.js";
import { workerControlDecisionJson, } from "./codex-goal-mcp-worker-control-view.js";
import { codexGoalStateRootDir, codexGoalWorkerControlService, codexGoalWorkerControlTarget, } from "./codex-goal-mcp-worker-control.js";
export async function projectControllerLaunchPlanView(args, deps) {
    const controller = await deps.loadProjectControlController(args);
    const options = projectControllerOptionsFromMcpArgs(args);
    const state = projectControllerState(options, controller);
    const profile = projectControllerProfile(options, state);
    const plan = projectControllerLaunchInput(controller, state, profile);
    return projectControllerLaunchPlanViewJson({
        base: controllerViewBase(controller, state, profile.providerKind),
        rawShellMode: options.rawShellMode,
        profile,
        plan,
    });
}
export async function projectControllerStartView(args, deps) {
    const controller = await deps.loadProjectControlController(args);
    const options = projectControllerOptionsFromMcpArgs(args);
    const state = projectControllerState(options, controller);
    const profile = projectControllerProfile(options, state);
    const base = controllerViewBase(controller, state, profile.providerKind);
    const plan = projectControllerLaunchInput(controller, state, profile);
    if (plan.status === LaunchPlanStatus.Blocked) {
        return projectControllerStartLaunchBlockedViewJson({ base, plan });
    }
    const launch = await goalLaunchInput(codexGoalJobToArgs(controller.controller));
    const providerInput = await projectControllerProvider({
        options,
        controller,
        launch,
        profile,
        state,
    });
    const capacityAccountId = stringValue(providerInput.account?.name);
    const owner = projectControllerProcessOwner(deps.runtimeVersion);
    const result = await startControlledAgentRun({
        controllerJobId: controller.controller.jobId,
        sessionId: state.sessionId,
        stateDir: state.stateDir,
        boundary: AccessBoundary.ProjectScopedControl,
        projectAccessScope: controller.scope,
        provider: profile.enforcement,
        networkAccess: NetworkAccessMode.Restricted,
    }, {
        provider: providerInput.provider,
        stateStore: state.store,
        events: state.store,
        owner,
        ownerLiveness: { isLive: projectControllerOwnerIsLive },
        recoverOwnerlessActiveRunAfterMs: 10 * 60 * 1000,
        ...(capacityAccountId === undefined ? {} : {
            capacity: {
                accountId: capacityAccountId,
                demand: projectControllerCapacityDemand(launch.config),
            },
        }),
    });
    if (!result.ok) {
        if ("reason" in result) {
            return projectControllerStartExistingRunViewJson({ base, result });
        }
        return projectControllerStartUseCaseBlockedViewJson({ base, result });
    }
    deps.providerRegistry.set(state.sessionId, providerInput.provider);
    return projectControllerStartReadyViewJson({
        base,
        profile,
        plan,
        result,
        owner,
        providerEvidence: {
            account: providerInput.account,
            sessionArtifact: providerInput.sessionArtifact,
            safeMessage: providerInput.safeMessage,
        },
    });
}
export async function projectControllerStatusView(args, deps) {
    const controller = await deps.loadProjectControlController(args);
    const options = projectControllerOptionsFromMcpArgs(args);
    const state = projectControllerState(options, controller);
    const result = await getControlledAgentStatus(state.sessionId, {
        stateStore: state.store,
    });
    const provider = deps.providerRegistry.get(state.sessionId);
    let observed;
    let providerStatusError;
    if (result.ok && provider) {
        try {
            observed = await provider.status({ session: result.session, run: result.run });
        }
        catch (error) {
            providerStatusError = safeObservationErrorMessage(error);
        }
    }
    return projectControllerStatusViewJson({
        base: controllerViewBase(controller, state, projectControllerProviderKind(options)),
        result,
        providerAttached: provider !== undefined,
        observed,
        providerStatusError,
        owner: projectControllerProcessOwner(deps.runtimeVersion),
    });
}
export async function projectControllerConsumeGuidanceView(args, deps) {
    const controller = await deps.loadProjectControlController(args);
    const options = projectControllerOptionsFromMcpArgs(args);
    const launch = await goalLaunchInput(codexGoalJobToArgs(controller.controller));
    const control = codexGoalWorkerControlService(launch);
    const target = codexGoalWorkerControlTarget({
        manifest: controller.controller,
        launch,
    });
    const deliveryAttemptId = options.deliveryAttemptId ??
        `${controller.controller.jobId}:controller-guidance:${new Date().toISOString()}`;
    const batch = await control.consumeForContinuation({
        target,
        deliveryAttemptId,
    });
    const decision = await control.getDecision({ target });
    return {
        ok: true,
        mode: "project_controller_consume_guidance",
        controllerJobId: controller.controller.jobId,
        registryRootDir: controller.registryRootDir,
        deliveryAttemptId: batch.deliveryAttemptId,
        consumedCount: batch.signalIds.length,
        signalIds: batch.signalIds,
        ...(batch.message === undefined ? {} : { message: batch.message }),
        decision: workerControlDecisionJson(decision, false),
    };
}
export async function projectControllerStopView(args, deps) {
    const controller = await deps.loadProjectControlController(args);
    const options = projectControllerOptionsFromMcpArgs(args);
    const state = projectControllerState(options, controller);
    const result = await getControlledAgentStatus(state.sessionId, {
        stateStore: state.store,
    });
    const base = controllerViewBase(controller, state, projectControllerProviderKind(options));
    const provider = deps.providerRegistry.get(state.sessionId);
    const owner = projectControllerProcessOwner(deps.runtimeVersion);
    if (result.ok && provider) {
        const stopped = await stopControlledAgentRun({
            sessionId: state.sessionId,
            reason: options.reason ?? "project_controller_stop",
        }, {
            stateStore: state.store,
            provider,
            events: state.store,
        });
        if (stopped.ok)
            deps.providerRegistry.delete(state.sessionId);
        return projectControllerStopProviderResultViewJson({
            base,
            statusResult: result,
            stopped,
            owner,
        });
    }
    return projectControllerStopDisconnectedViewJson({ base, result, owner });
}
export async function projectControllerReconcileView(args, deps) {
    const controller = await deps.loadProjectControlController(args);
    const options = projectControllerOptionsFromMcpArgs(args);
    const state = projectControllerState(options, controller);
    const result = await getControlledAgentStatus(state.sessionId, {
        stateStore: state.store,
    });
    const base = controllerViewBase(controller, state, projectControllerProviderKind(options));
    const provider = deps.providerRegistry.get(state.sessionId);
    const owner = projectControllerProcessOwner(deps.runtimeVersion);
    if (result.ok && provider) {
        const reconciled = await reconcileControlledAgentRun(state.sessionId, {
            stateStore: state.store,
            provider,
            events: state.store,
        });
        if (reconciled.ok) {
            const launch = await goalLaunchInput(codexGoalJobToArgs(controller.controller));
            recordControllerCapacitySignal({
                launch,
                controllerJobId: controller.controller.jobId,
                run: reconciled.run,
            });
        }
        return projectControllerReconcileProviderResultViewJson({
            base,
            reconciled,
            owner,
        });
    }
    return projectControllerReconcileDisconnectedViewJson({ base, result, owner });
}
function controllerViewBase(controller, state, providerKind) {
    return projectControllerViewBase({
        controllerJobId: controller.controller.jobId,
        providerKind,
        registryRootDir: controller.registryRootDir,
        stateDir: state.stateDir,
        sessionId: state.sessionId,
    });
}
function recordControllerCapacitySignal(input) {
    recordProjectControllerCapacitySignal({
        stateRootDir: codexGoalStateRootDir(input.launch),
        controllerJobId: input.controllerJobId,
        config: input.launch.config,
        run: input.run,
    });
}
//# sourceMappingURL=codex-goal-mcp-project-controller.js.map