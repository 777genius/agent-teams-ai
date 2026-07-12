import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import {
  AccessBoundary,
  NetworkAccessMode,
  getControlledAgentStatus,
  reconcileControlledAgentRun,
  startControlledAgentRun,
  stopControlledAgentRun,
  type ControlledAgentEventPort,
  type ControlledAgentProviderPort,
  type ControlledAgentProviderStatusResult,
  type ControllerStateStorePort,
  type GetControlledAgentStatusResult,
  type ProjectAccessScope,
  type ReconcileControlledAgentRunResult,
  type StartControlledAgentRunResult,
  type StopControlledAgentRunResult,
} from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalLaunchInput } from "../../codex-goal-ops";
import {
  projectControllerCapacityDemand,
  recordProjectControllerCapacitySignal,
} from "../../project-controller-capacity";
import type { ProjectControllerProfile } from "./codex-goal-project-controller-profile";
import {
  projectControllerOwnerIsLive,
  projectControllerProcessOwner,
  type ProjectControllerProviderRegistry,
} from "./codex-goal-project-controller-runtime";

type JsonObject = Readonly<Record<string, unknown>>;

export type ProjectControllerRunState = {
  readonly stateDir: string;
  readonly sessionId: string;
  readonly store: ControllerStateStorePort & ControlledAgentEventPort;
};

export type ProjectControllerRunDeps = {
  readonly runtimeVersion: string;
  readonly providerRegistry: ProjectControllerProviderRegistry;
};

export type ProjectControllerProviderStartInput = {
  readonly provider: ControlledAgentProviderPort;
  readonly account?: JsonObject;
  readonly sessionArtifact?: JsonObject;
  readonly safeMessage: string;
};

export async function startProjectControllerControlledRun(input: {
  readonly controllerJobId: string;
  readonly scope: ProjectAccessScope;
  readonly profile: ProjectControllerProfile;
  readonly state: ProjectControllerRunState;
  readonly launch: CodexGoalLaunchInput;
  readonly providerInput: ProjectControllerProviderStartInput;
  readonly deps: ProjectControllerRunDeps;
}): Promise<{
  readonly result: StartControlledAgentRunResult;
  readonly owner: ReturnType<typeof projectControllerProcessOwner>;
  readonly providerEvidence: {
    readonly account?: JsonObject;
    readonly sessionArtifact?: JsonObject;
    readonly safeMessage: string;
  };
}> {
  const capacityAccountId = stringValue(input.providerInput.account?.name);
  const owner = projectControllerProcessOwner(input.deps.runtimeVersion);
  const result = await startControlledAgentRun({
    controllerJobId: input.controllerJobId,
    sessionId: input.state.sessionId,
    stateDir: input.state.stateDir,
    boundary: AccessBoundary.ProjectScopedControl,
    projectAccessScope: input.scope,
    provider: input.profile.enforcement,
    networkAccess: NetworkAccessMode.Restricted,
  }, {
    provider: input.providerInput.provider,
    stateStore: input.state.store,
    events: input.state.store,
    owner,
    ownerLiveness: { isLive: projectControllerOwnerIsLive },
    recoverOwnerlessActiveRunAfterMs: 10 * 60 * 1000,
    ...(capacityAccountId === undefined ? {} : {
      capacity: {
        accountId: capacityAccountId,
        demand: projectControllerCapacityDemand(input.launch.config),
      },
    }),
  });
  if (result.ok) {
    input.deps.providerRegistry.set(
      input.state.sessionId,
      input.providerInput.provider,
    );
  }
  return {
    result,
    owner,
    providerEvidence: {
      ...(input.providerInput.account === undefined
        ? {}
        : { account: input.providerInput.account }),
      ...(input.providerInput.sessionArtifact === undefined
        ? {}
        : { sessionArtifact: input.providerInput.sessionArtifact }),
      safeMessage: input.providerInput.safeMessage,
    },
  };
}

export async function observeProjectControllerControlledRun(input: {
  readonly state: ProjectControllerRunState;
  readonly deps: ProjectControllerRunDeps;
}): Promise<{
  readonly result: GetControlledAgentStatusResult;
  readonly providerAttached: boolean;
  readonly observed?: ControlledAgentProviderStatusResult;
  readonly providerStatusError?: string;
  readonly owner: ReturnType<typeof projectControllerProcessOwner>;
}> {
  const result = await getControlledAgentStatus(input.state.sessionId, {
    stateStore: input.state.store,
  });
  const provider = input.deps.providerRegistry.get(input.state.sessionId);
  let observed: ControlledAgentProviderStatusResult | undefined;
  let providerStatusError: string | undefined;
  if (result.ok && provider) {
    try {
      observed = await provider.status({ session: result.session, run: result.run });
    } catch (error) {
      providerStatusError = safeProjectControllerErrorMessage(error);
    }
  }
  return {
    result,
    providerAttached: provider !== undefined,
    ...(observed === undefined ? {} : { observed }),
    ...(providerStatusError === undefined ? {} : { providerStatusError }),
    owner: projectControllerProcessOwner(input.deps.runtimeVersion),
  };
}

export async function stopProjectControllerControlledRun(input: {
  readonly state: ProjectControllerRunState;
  readonly reason: string;
  readonly deps: ProjectControllerRunDeps;
}): Promise<
  | {
      readonly statusResult: Extract<
        GetControlledAgentStatusResult,
        { readonly ok: true }
      >;
      readonly stopped: StopControlledAgentRunResult;
      readonly owner: ReturnType<typeof projectControllerProcessOwner>;
    }
  | {
      readonly result: GetControlledAgentStatusResult;
      readonly owner: ReturnType<typeof projectControllerProcessOwner>;
      readonly stopped?: undefined;
    }
> {
  const result = await getControlledAgentStatus(input.state.sessionId, {
    stateStore: input.state.store,
  });
  const provider = input.deps.providerRegistry.get(input.state.sessionId);
  const owner = projectControllerProcessOwner(input.deps.runtimeVersion);
  if (result.ok && provider) {
    const stopped = await stopControlledAgentRun({
      sessionId: input.state.sessionId,
      reason: input.reason,
    }, {
      stateStore: input.state.store,
      provider,
      events: input.state.store,
    });
    if (stopped.ok) input.deps.providerRegistry.delete(input.state.sessionId);
    return { statusResult: result, stopped, owner };
  }
  return { result, owner };
}

export async function reconcileProjectControllerControlledRun(input: {
  readonly controllerJobId: string;
  readonly state: ProjectControllerRunState;
  readonly loadLaunch: () => Promise<CodexGoalLaunchInput>;
  readonly deps: ProjectControllerRunDeps;
}): Promise<{
  readonly result: GetControlledAgentStatusResult;
  readonly owner: ReturnType<typeof projectControllerProcessOwner>;
  readonly reconciled?: ReconcileControlledAgentRunResult;
}> {
  const result = await getControlledAgentStatus(input.state.sessionId, {
    stateStore: input.state.store,
  });
  const provider = input.deps.providerRegistry.get(input.state.sessionId);
  const owner = projectControllerProcessOwner(input.deps.runtimeVersion);
  if (result.ok && provider) {
    const reconciled = await reconcileControlledAgentRun(input.state.sessionId, {
      stateStore: input.state.store,
      provider,
      events: input.state.store,
    });
    if (reconciled.ok) {
      const launch = await input.loadLaunch();
      recordProjectControllerCapacitySignal({
        authRootDir: launch.config.authRootDir,
        controllerJobId: input.controllerJobId,
        config: launch.config,
        run: reconciled.run,
      });
    }
    return { result, reconciled, owner };
  }
  return { result, owner };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeProjectControllerErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return new DefaultRedactor().redact(message);
}
