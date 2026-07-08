import { hostname } from "node:os";
import {
  AccessBoundary,
  LaunchPlanStatus,
  NetworkAccessMode,
  buildControlledAgentLiveControllerState,
  buildControlledAgentProcessOwner,
  getControlledAgentStatus,
  reconcileControlledAgentRun,
  startControlledAgentRun,
  stopControlledAgentRun,
  type ControlledAgentProcessOwner,
  type ControlledAgentProviderPort,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import {
  projectControllerCapacityDemand,
  recordProjectControllerCapacitySignal,
} from "./project-controller-capacity";
import {
  codexGoalJobToArgs,
  type CodexGoalJobManifest,
} from "./codex-goal-jobs";
import type { CodexGoalLaunchInput } from "./codex-goal-ops";
import {
  goalLaunchInput,
} from "./codex-goal-mcp-launch-input";
import {
  safeObservationErrorMessage,
} from "./codex-goal-mcp-observation-projection";
import {
  projectControllerAllowedTools,
  projectControllerLaunchInput,
  projectControllerProfile,
  projectControllerProfileReadyJson,
  projectControllerProviderKind,
  projectControllerState,
} from "./codex-goal-mcp-project-controller-profile";
import {
  projectControllerProvider,
} from "./codex-goal-mcp-project-controller-provider";
import type { ProjectControllerLaunchPlanMcpArgs } from "./codex-goal-mcp-inputs";
import {
  stringValue,
} from "./codex-goal-mcp-values";
import {
  workerControlDecisionJson,
} from "./codex-goal-mcp-worker-control-view";
import {
  codexGoalStateRootDir,
  codexGoalWorkerControlService,
  codexGoalWorkerControlTarget,
} from "./codex-goal-mcp-worker-control";

type JsonObject = Readonly<Record<string, unknown>>;

type LoadedProjectControlController = {
  readonly registryRootDir: string;
  readonly controller: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
};

export type CodexGoalMcpProjectControllerDeps = {
  readonly loadProjectControlController: (
    args: ProjectControllerLaunchPlanMcpArgs,
  ) => Promise<LoadedProjectControlController>;
  readonly runtimeVersion: string;
};

const controlledAgentProviders = new Map<string, ControlledAgentProviderPort>();

export async function projectControllerLaunchPlanView(
  args: ProjectControllerLaunchPlanMcpArgs,
  deps: CodexGoalMcpProjectControllerDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const state = projectControllerState(args, controller);
  const profile = projectControllerProfile(args, state);
  const plan = projectControllerLaunchInput(controller, state, profile);
  const ready = plan.status === LaunchPlanStatus.Ready;
  return {
    ok: ready,
    mode: "project_controller_launch_plan",
    controllerJobId: controller.controller.jobId,
    providerKind: profile.providerKind,
    registryRootDir: controller.registryRootDir,
    stateDir: state.stateDir,
    sessionId: state.sessionId,
    rawShellMode: args.rawShellMode ?? "disabled-by-provider",
    status: plan.status,
    ...(ready
      ? {
          session: plan.session,
          ...projectControllerProfileReadyJson(profile),
          evidence: plan.evidence,
        }
      : {
          reason: plan.reason,
          accessReason: plan.accessReason,
          evidence: plan.evidence,
          allowedTools: projectControllerAllowedTools(profile),
          safeMessage:
            "Controlled LLM controller launch is blocked until the provider can enforce broker-only tools without raw shell.",
        }),
  };
}

export async function projectControllerStartView(
  args: ProjectControllerLaunchPlanMcpArgs,
  deps: CodexGoalMcpProjectControllerDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const state = projectControllerState(args, controller);
  const profile = projectControllerProfile(args, state);
  const plan = projectControllerLaunchInput(controller, state, profile);
  if (plan.status === LaunchPlanStatus.Blocked) {
    return {
      ok: false,
      mode: "project_controller_start",
      controllerJobId: controller.controller.jobId,
      providerKind: profile.providerKind,
      registryRootDir: controller.registryRootDir,
      stateDir: state.stateDir,
      sessionId: state.sessionId,
      status: plan.status,
      reason: plan.reason,
      accessReason: plan.accessReason,
      evidence: plan.evidence,
      safeMessage:
        "Controlled LLM controller start is blocked by the fail-closed launch plan.",
    };
  }
  const launch = await goalLaunchInput(codexGoalJobToArgs(controller.controller));
  const providerInput = await projectControllerProvider({
    args,
    controller,
    launch,
    profile,
    state,
  });
  const capacityAccountId = stringValue(providerInput.account?.name);
  const owner = controlledAgentProcessOwner(deps.runtimeVersion);
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
    ownerLiveness: { isLive: controlledAgentOwnerIsLive },
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
      return {
        ok: false,
        mode: "project_controller_start",
        controllerJobId: controller.controller.jobId,
        providerKind: profile.providerKind,
        registryRootDir: controller.registryRootDir,
        stateDir: state.stateDir,
        sessionId: state.sessionId,
        reason: result.reason,
        session: result.session,
        run: result.run,
        safeMessage:
          "Controlled LLM controller already has an active run. Use status, stop or reconcile before starting another run.",
      };
    }
    return {
      ok: false,
      mode: "project_controller_start",
      controllerJobId: controller.controller.jobId,
      providerKind: profile.providerKind,
      registryRootDir: controller.registryRootDir,
      stateDir: state.stateDir,
      sessionId: state.sessionId,
      status: result.plan.status,
      reason: result.plan.reason,
      evidence: result.plan.evidence,
      safeMessage:
        "Controlled LLM controller start was blocked by the controlled-agent use case.",
    };
  }
  controlledAgentProviders.set(state.sessionId, providerInput.provider);
  return {
    ok: true,
    mode: "project_controller_start",
    controllerJobId: controller.controller.jobId,
    providerKind: profile.providerKind,
    registryRootDir: controller.registryRootDir,
    stateDir: state.stateDir,
    sessionId: state.sessionId,
    status: result.run.status,
    run: result.run,
    provider: result.provider,
    liveController: buildControlledAgentLiveControllerState({
      session: result.session,
      providerAttached: true,
      currentOwner: owner,
    }),
    ...(providerInput.account === undefined ? {} : { account: providerInput.account }),
    ...(providerInput.sessionArtifact === undefined
      ? {}
      : { sessionArtifact: providerInput.sessionArtifact }),
    allowedTools: projectControllerAllowedTools(profile),
    safeMessage: providerInput.safeMessage,
    evidence: plan.evidence,
  };
}

export async function projectControllerStatusView(
  args: ProjectControllerLaunchPlanMcpArgs,
  deps: CodexGoalMcpProjectControllerDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const state = projectControllerState(args, controller);
  const result = await getControlledAgentStatus(state.sessionId, {
    stateStore: state.store,
  });
  const provider = controlledAgentProviders.get(state.sessionId);
  let observed: Awaited<ReturnType<ControlledAgentProviderPort["status"]>> | undefined;
  let providerStatusError: string | undefined;
  if (result.ok && provider) {
    try {
      observed = await provider.status({ session: result.session, run: result.run });
    } catch (error) {
      providerStatusError = safeObservationErrorMessage(error);
    }
  }
  const owner = controlledAgentProcessOwner(deps.runtimeVersion);
  const liveController = result.ok
    ? buildControlledAgentLiveControllerState({
        session: result.session,
        providerAttached: provider !== undefined,
        currentOwner: owner,
        providerObservedStatus: observed?.status,
        providerStatusFailed: providerStatusError !== undefined,
      })
    : buildControlledAgentLiveControllerState({
      providerAttached: false,
      currentOwner: owner,
    });
  return {
    ok: result.ok,
    mode: "project_controller_status",
    controllerJobId: controller.controller.jobId,
    providerKind: projectControllerProviderKind(args),
    registryRootDir: controller.registryRootDir,
    stateDir: state.stateDir,
    sessionId: state.sessionId,
    reason: providerStatusError === undefined ? result.reason : "provider_status_failed",
    ...(result.session === undefined ? {} : { session: result.session }),
    ...(result.ok && "run" in result ? { run: result.run } : {}),
    ...(observed === undefined ? {} : { providerObserved: observed }),
    ...(providerStatusError === undefined
      ? {}
      : { providerObservedError: { safeMessage: providerStatusError } }),
    liveController,
    safeMessage: providerStatusError !== undefined
      ? "Controller state is persisted, but provider status failed in this MCP process."
      : result.ok
      ? provider
        ? "Controller state is persisted and provider liveness was observed in this MCP process."
        : "Controller state is persisted, but provider liveness is unavailable in this MCP process."
      : "No persisted controlled-agent session/run exists for this controller.",
  };
}

export async function projectControllerConsumeGuidanceView(
  args: ProjectControllerLaunchPlanMcpArgs,
  deps: CodexGoalMcpProjectControllerDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const launch = await goalLaunchInput(codexGoalJobToArgs(controller.controller));
  const control = codexGoalWorkerControlService(launch);
  const target = codexGoalWorkerControlTarget({
    manifest: controller.controller,
    launch,
  });
  const deliveryAttemptId = stringValue(args.deliveryAttemptId) ??
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

export async function projectControllerStopView(
  args: ProjectControllerLaunchPlanMcpArgs,
  deps: CodexGoalMcpProjectControllerDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const state = projectControllerState(args, controller);
  const result = await getControlledAgentStatus(state.sessionId, {
    stateStore: state.store,
  });
  const provider = controlledAgentProviders.get(state.sessionId);
  const owner = controlledAgentProcessOwner(deps.runtimeVersion);
  if (result.ok && provider) {
    const stopped = await stopControlledAgentRun({
      sessionId: state.sessionId,
      reason: stringValue(args.reason) ?? "project_controller_stop",
    }, {
      stateStore: state.store,
      provider,
      events: state.store,
    });
    if (stopped.ok) controlledAgentProviders.delete(state.sessionId);
    return {
      ok: stopped.ok,
      mode: "project_controller_stop",
      controllerJobId: controller.controller.jobId,
      providerKind: projectControllerProviderKind(args),
      registryRootDir: controller.registryRootDir,
      stateDir: state.stateDir,
      sessionId: state.sessionId,
      reason: stopped.reason,
      ...(stopped.ok ? { session: stopped.session, run: stopped.run } : {}),
      liveController: buildControlledAgentLiveControllerState({
        session: stopped.ok ? stopped.session : result.session,
        providerAttached: false,
        currentOwner: owner,
      }),
      safeMessage: stopped.ok
        ? "Controlled-agent provider stopped through the safe provider adapter."
        : "Controlled-agent stop failed before reaching provider stop.",
    };
  }
  return {
    ok: false,
    mode: "project_controller_stop",
    controllerJobId: controller.controller.jobId,
    providerKind: projectControllerProviderKind(args),
    registryRootDir: controller.registryRootDir,
    stateDir: state.stateDir,
    sessionId: state.sessionId,
    reason: result.ok
      ? "controlled_agent_provider_runner_not_connected"
      : result.reason,
    ...(result.ok ? { session: result.session, run: result.run } : {}),
    liveController: buildControlledAgentLiveControllerState({
      session: result.ok ? result.session : undefined,
      providerAttached: false,
      currentOwner: owner,
    }),
    safeMessage: result.ok
      ? "A safe provider runner is required to stop a live controlled-agent controller. Do not kill unrelated processes or use danger_full_access from this tool."
      : "No persisted controlled-agent run exists to stop.",
  };
}

export async function projectControllerReconcileView(
  args: ProjectControllerLaunchPlanMcpArgs,
  deps: CodexGoalMcpProjectControllerDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const state = projectControllerState(args, controller);
  const result = await getControlledAgentStatus(state.sessionId, {
    stateStore: state.store,
  });
  const provider = controlledAgentProviders.get(state.sessionId);
  const owner = controlledAgentProcessOwner(deps.runtimeVersion);
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
    return {
      ok: reconciled.ok,
      mode: "project_controller_reconcile",
      controllerJobId: controller.controller.jobId,
      providerKind: projectControllerProviderKind(args),
      registryRootDir: controller.registryRootDir,
      stateDir: state.stateDir,
      sessionId: state.sessionId,
      reason: reconciled.reason,
      ...(reconciled.session === undefined ? {} : { session: reconciled.session }),
      ...(reconciled.run === undefined ? {} : { run: reconciled.run }),
      liveController: buildControlledAgentLiveControllerState({
        session: reconciled.session,
        providerAttached: true,
        currentOwner: owner,
      }),
      ...(reconciled.ok || reconciled.safeMessage === undefined ? {} : {
        safeMessage: reconciled.safeMessage,
      }),
    };
  }
  return {
    ok: false,
    mode: "project_controller_reconcile",
    controllerJobId: controller.controller.jobId,
    providerKind: projectControllerProviderKind(args),
    registryRootDir: controller.registryRootDir,
    stateDir: state.stateDir,
    sessionId: state.sessionId,
    reason: result.ok
      ? "controlled_agent_provider_runner_not_connected"
      : result.reason,
    ...(result.ok ? { session: result.session, run: result.run } : {}),
    liveController: buildControlledAgentLiveControllerState({
      session: result.ok ? result.session : undefined,
      providerAttached: false,
      currentOwner: owner,
    }),
    safeMessage: result.ok
      ? "A safe provider runner is required to reconcile provider liveness. Persisted state is available, but runtime liveness cannot be asserted."
      : "No persisted controlled-agent run exists to reconcile.",
  };
}

function controlledAgentProcessOwner(runtimeVersion: string): ControlledAgentProcessOwner {
  return buildControlledAgentProcessOwner({
    runtimeVersion,
    ...(process.env.SUBSCRIPTION_RUNTIME_RELEASE_SHA === undefined
      ? {}
      : { runtimeSha: process.env.SUBSCRIPTION_RUNTIME_RELEASE_SHA }),
    pid: process.pid,
  });
}

function controlledAgentOwnerIsLive(owner: ControlledAgentProcessOwner): boolean {
  if (owner.hostname !== undefined && owner.hostname !== hostname()) return true;
  if (owner.pid === undefined) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function recordControllerCapacitySignal(input: {
  readonly launch: CodexGoalLaunchInput;
  readonly controllerJobId: string;
  readonly run: Parameters<typeof recordProjectControllerCapacitySignal>[0]["run"];
}): void {
  recordProjectControllerCapacitySignal({
    stateRootDir: codexGoalStateRootDir(input.launch),
    controllerJobId: input.controllerJobId,
    config: input.launch.config,
    run: input.run,
  });
}
