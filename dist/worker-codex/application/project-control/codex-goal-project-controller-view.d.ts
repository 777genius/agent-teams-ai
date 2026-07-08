/// <reference types="node" />
import { LaunchPlanStatus, type ControlledAgentProcessOwner, type ControlledAgentProviderStatusResult, type GetControlledAgentStatusResult, type ReconcileControlledAgentRunResult, type StartControlledAgentRunResult, type StopControlledAgentRunResult } from "@vioxen/subscription-runtime/worker-core";
import type { ProjectControllerProviderKind } from "./codex-goal-project-controller-options.js";
import { type ProjectControllerProfile, type projectControllerLaunchInput } from "./codex-goal-project-controller-profile.js";
type JsonObject = Readonly<Record<string, unknown>>;
type ProjectControllerLaunchPlan = ReturnType<typeof projectControllerLaunchInput>;
type ReadyProjectControllerLaunchPlan = Extract<ProjectControllerLaunchPlan, {
    readonly status: LaunchPlanStatus.Ready;
}>;
type BlockedProjectControllerLaunchPlan = Extract<ProjectControllerLaunchPlan, {
    readonly status: LaunchPlanStatus.Blocked;
}>;
type StartReadyResult = Extract<StartControlledAgentRunResult, {
    readonly ok: true;
}>;
type StartExistingRunResult = Extract<StartControlledAgentRunResult, {
    readonly ok: false;
    readonly reason: string;
}>;
type StartUseCaseBlockedResult = Extract<StartControlledAgentRunResult, {
    readonly ok: false;
    readonly plan: BlockedProjectControllerLaunchPlan;
}>;
type PersistedControllerStatusResult = Extract<GetControlledAgentStatusResult, {
    readonly ok: true;
}>;
export type ProjectControllerViewBase = {
    readonly controllerJobId: string;
    readonly providerKind: ProjectControllerProviderKind;
    readonly registryRootDir: string;
    readonly stateDir: string;
    readonly sessionId: string;
};
export declare function projectControllerViewBase(input: ProjectControllerViewBase): ProjectControllerViewBase;
export declare function projectControllerLaunchPlanViewJson(input: {
    readonly base: ProjectControllerViewBase;
    readonly rawShellMode?: string | undefined;
    readonly profile: ProjectControllerProfile;
    readonly plan: ProjectControllerLaunchPlan;
}): JsonObject;
export declare function projectControllerStartLaunchBlockedViewJson(input: {
    readonly base: ProjectControllerViewBase;
    readonly plan: BlockedProjectControllerLaunchPlan;
}): JsonObject;
export declare function projectControllerStartExistingRunViewJson(input: {
    readonly base: ProjectControllerViewBase;
    readonly result: StartExistingRunResult;
}): JsonObject;
export declare function projectControllerStartUseCaseBlockedViewJson(input: {
    readonly base: ProjectControllerViewBase;
    readonly result: StartUseCaseBlockedResult;
}): JsonObject;
export declare function projectControllerStartReadyViewJson(input: {
    readonly base: ProjectControllerViewBase;
    readonly profile: ProjectControllerProfile;
    readonly plan: ReadyProjectControllerLaunchPlan;
    readonly result: StartReadyResult;
    readonly owner: ControlledAgentProcessOwner;
    readonly providerEvidence: {
        readonly account?: JsonObject | undefined;
        readonly sessionArtifact?: JsonObject | undefined;
        readonly safeMessage: string;
    };
}): JsonObject;
export declare function projectControllerStatusViewJson(input: {
    readonly base: ProjectControllerViewBase;
    readonly result: GetControlledAgentStatusResult;
    readonly providerAttached: boolean;
    readonly observed?: ControlledAgentProviderStatusResult | undefined;
    readonly providerStatusError?: string | undefined;
    readonly owner: ControlledAgentProcessOwner;
}): JsonObject;
export declare function projectControllerStopProviderResultViewJson(input: {
    readonly base: ProjectControllerViewBase;
    readonly statusResult: PersistedControllerStatusResult;
    readonly stopped: StopControlledAgentRunResult;
    readonly owner: ControlledAgentProcessOwner;
}): JsonObject;
export declare function projectControllerStopDisconnectedViewJson(input: {
    readonly base: ProjectControllerViewBase;
    readonly result: GetControlledAgentStatusResult;
    readonly owner: ControlledAgentProcessOwner;
}): JsonObject;
export declare function projectControllerReconcileProviderResultViewJson(input: {
    readonly base: ProjectControllerViewBase;
    readonly reconciled: ReconcileControlledAgentRunResult;
    readonly owner: ControlledAgentProcessOwner;
}): JsonObject;
export declare function projectControllerReconcileDisconnectedViewJson(input: {
    readonly base: ProjectControllerViewBase;
    readonly result: GetControlledAgentStatusResult;
    readonly owner: ControlledAgentProcessOwner;
}): JsonObject;
export {};
//# sourceMappingURL=codex-goal-project-controller-view.d.ts.map