import {
  LaunchPlanStatus,
  buildControlledAgentLiveControllerState,
  type ControlledAgentProcessOwner,
  type ControlledAgentProviderStatusResult,
  type GetControlledAgentStatusResult,
  type ReconcileControlledAgentRunResult,
  type StartControlledAgentRunResult,
  type StopControlledAgentRunResult,
} from "@vioxen/subscription-runtime/worker-core";
import type { ProjectControllerProviderKind } from "./codex-goal-project-controller-options";
import {
  projectControllerAllowedTools,
  projectControllerProfileReadyJson,
  type ProjectControllerProfile,
  type projectControllerLaunchInput,
} from "./codex-goal-project-controller-profile";

type JsonObject = Readonly<Record<string, unknown>>;
type ProjectControllerLaunchPlan = ReturnType<typeof projectControllerLaunchInput>;
type ReadyProjectControllerLaunchPlan = Extract<
  ProjectControllerLaunchPlan,
  { readonly status: LaunchPlanStatus.Ready }
>;
type BlockedProjectControllerLaunchPlan = Extract<
  ProjectControllerLaunchPlan,
  { readonly status: LaunchPlanStatus.Blocked }
>;
type StartReadyResult = Extract<
  StartControlledAgentRunResult,
  { readonly ok: true }
>;
type StartExistingRunResult = Extract<
  StartControlledAgentRunResult,
  { readonly ok: false; readonly reason: string }
>;
type StartUseCaseBlockedResult = Extract<
  StartControlledAgentRunResult,
  { readonly ok: false; readonly plan: BlockedProjectControllerLaunchPlan }
>;
type PersistedControllerStatusResult = Extract<
  GetControlledAgentStatusResult,
  { readonly ok: true }
>;

export type ProjectControllerViewBase = {
  readonly controllerJobId: string;
  readonly providerKind: ProjectControllerProviderKind;
  readonly registryRootDir: string;
  readonly stateDir: string;
  readonly sessionId: string;
};

export function projectControllerViewBase(
  input: ProjectControllerViewBase,
): ProjectControllerViewBase {
  return input;
}

export function projectControllerLaunchPlanViewJson(input: {
  readonly base: ProjectControllerViewBase;
  readonly rawShellMode?: string | undefined;
  readonly profile: ProjectControllerProfile;
  readonly plan: ProjectControllerLaunchPlan;
}): JsonObject {
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
          safeMessage:
            "Controlled LLM controller launch is blocked until the provider can enforce broker-only tools without raw shell.",
        }),
  };
}

export function projectControllerStartLaunchBlockedViewJson(input: {
  readonly base: ProjectControllerViewBase;
  readonly plan: BlockedProjectControllerLaunchPlan;
}): JsonObject {
  return {
    ok: false,
    mode: "project_controller_start",
    ...input.base,
    status: input.plan.status,
    reason: input.plan.reason,
    accessReason: input.plan.accessReason,
    evidence: input.plan.evidence,
    safeMessage:
      "Controlled LLM controller start is blocked by the fail-closed launch plan.",
  };
}

export function projectControllerStartExistingRunViewJson(input: {
  readonly base: ProjectControllerViewBase;
  readonly result: StartExistingRunResult;
}): JsonObject {
  return {
    ok: false,
    mode: "project_controller_start",
    ...input.base,
    reason: input.result.reason,
    session: input.result.session,
    run: input.result.run,
    safeMessage:
      "Controlled LLM controller already has an active run. Use status, stop or reconcile before starting another run.",
  };
}

export function projectControllerStartUseCaseBlockedViewJson(input: {
  readonly base: ProjectControllerViewBase;
  readonly result: StartUseCaseBlockedResult;
}): JsonObject {
  return {
    ok: false,
    mode: "project_controller_start",
    ...input.base,
    status: input.result.plan.status,
    reason: input.result.plan.reason,
    evidence: input.result.plan.evidence,
    safeMessage:
      "Controlled LLM controller start was blocked by the controlled-agent use case.",
  };
}

export function projectControllerStartReadyViewJson(input: {
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
}): JsonObject {
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

export function projectControllerStatusViewJson(input: {
  readonly base: ProjectControllerViewBase;
  readonly result: GetControlledAgentStatusResult;
  readonly providerAttached: boolean;
  readonly observed?: ControlledAgentProviderStatusResult | undefined;
  readonly providerStatusError?: string | undefined;
  readonly owner: ControlledAgentProcessOwner;
}): JsonObject {
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

export function projectControllerStopProviderResultViewJson(input: {
  readonly base: ProjectControllerViewBase;
  readonly statusResult: PersistedControllerStatusResult;
  readonly stopped: StopControlledAgentRunResult;
  readonly owner: ControlledAgentProcessOwner;
}): JsonObject {
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

export function projectControllerStopDisconnectedViewJson(input: {
  readonly base: ProjectControllerViewBase;
  readonly result: GetControlledAgentStatusResult;
  readonly owner: ControlledAgentProcessOwner;
}): JsonObject {
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

export function projectControllerReconcileProviderResultViewJson(input: {
  readonly base: ProjectControllerViewBase;
  readonly reconciled: ReconcileControlledAgentRunResult;
  readonly owner: ControlledAgentProcessOwner;
}): JsonObject {
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

export function projectControllerReconcileDisconnectedViewJson(input: {
  readonly base: ProjectControllerViewBase;
  readonly result: GetControlledAgentStatusResult;
  readonly owner: ControlledAgentProcessOwner;
}): JsonObject {
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
