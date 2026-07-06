import { randomUUID } from "node:crypto";

import { LaunchPlanStatus } from "../../access-control";
import {
  ControlledAgentEventType,
  ControlledAgentRunStatus,
} from "../domain/controlled-agent";
import type {
  ControlledAgentLaunchPlan,
  ControlledAgentLaunchPlanInput,
  ControlledAgentProcessOwner,
  ControlledAgentRun,
  ControlledAgentSession,
} from "../domain/controlled-agent";
import type { WorkerRuntimeDemand } from "../../account-capacity";
import type {
  ControlledAgentEventPort,
  ControlledAgentProviderPort,
  ControlledAgentProviderStartResult,
  ControllerStateStorePort,
} from "../ports";
import { buildControlledAgentLaunchPlan } from "./build-controlled-agent-launch-plan";
import { controlledAgentControllerSystemPrompt } from "./controller-system-prompt";

export type StartControlledAgentRunDeps = {
  readonly provider: ControlledAgentProviderPort;
  readonly stateStore?: ControllerStateStorePort;
  readonly events?: ControlledAgentEventPort;
  readonly owner?: ControlledAgentProcessOwner;
  readonly ownerLiveness?: {
    isLive(owner: ControlledAgentProcessOwner): boolean | Promise<boolean>;
  };
  readonly recoverOwnerlessActiveRunAfterMs?: number;
  readonly capacity?: {
    readonly accountId: string;
    readonly demand?: WorkerRuntimeDemand;
  };
  readonly clock?: { now(): Date };
  readonly idGenerator?: { randomId(): string };
};

export type StartControlledAgentRunResult =
  | {
      readonly ok: true;
      readonly plan: Extract<
        ControlledAgentLaunchPlan,
        { readonly status: LaunchPlanStatus.Ready }
      >;
      readonly session: ControlledAgentSession;
      readonly run: ControlledAgentRun;
      readonly provider: ControlledAgentProviderStartResult;
    }
  | {
      readonly ok: false;
      readonly reason:
        | StartControlledAgentRunBlockReason.ExistingActiveRun
        | StartControlledAgentRunBlockReason.ExistingActiveRunCleanupFailed;
      readonly session: ControlledAgentSession;
      readonly run: ControlledAgentRun;
      readonly safeMessage?: string;
    }
  | {
      readonly ok: false;
      readonly plan: Extract<
        ControlledAgentLaunchPlan,
        { readonly status: LaunchPlanStatus.Blocked }
      >;
    };

export enum StartControlledAgentRunBlockReason {
  ExistingActiveRun = "existing_active_run",
  ExistingActiveRunCleanupFailed = "existing_active_run_cleanup_failed",
}

export class StartControlledAgentRunUseCase {
  constructor(private readonly deps: StartControlledAgentRunDeps) {}

  async start(input: ControlledAgentLaunchPlanInput): Promise<StartControlledAgentRunResult> {
    const plan = buildControlledAgentLaunchPlan(input);
    if (plan.status === LaunchPlanStatus.Blocked) {
      return { ok: false, plan };
    }
    const existingSession = await this.deps.stateStore?.readSession(plan.session.sessionId);
    const existingRun = existingSession?.activeRunId
      ? await this.deps.stateStore?.readRun(existingSession.activeRunId)
      : null;
    if (
      existingSession &&
      existingRun &&
      existingRun.status === ControlledAgentRunStatus.Running
    ) {
      if (await this.existingRunOwnerIsLive(existingRun)) {
        return {
          ok: false,
          reason: StartControlledAgentRunBlockReason.ExistingActiveRun,
          session: existingSession,
          run: existingRun,
        };
      }
      const staleSafeMessage = existingRun.owner === undefined
        ? "Controlled-agent active run has no owner metadata and exceeded the ownerless recovery threshold."
        : "Controlled-agent owner process is no longer live.";
      const now = (this.deps.clock?.now() ?? new Date()).toISOString();
      try {
        await this.deps.provider.stop({
          session: existingSession,
          run: existingRun,
          reason: staleSafeMessage,
        });
      } catch (error) {
        return {
          ok: false,
          reason: StartControlledAgentRunBlockReason.ExistingActiveRunCleanupFailed,
          session: existingSession,
          run: existingRun,
          safeMessage: error instanceof Error ? error.message : String(error),
        };
      }
      await this.deps.stateStore?.saveRun({
        ...existingRun,
        status: ControlledAgentRunStatus.Failed,
        safeMessage: staleSafeMessage,
        stoppedAt: now,
        updatedAt: now,
      });
      await this.deps.stateStore?.saveSession({
        ...existingSession,
        status: ControlledAgentRunStatus.Failed,
        updatedAt: now,
      });
    }
    const now = (this.deps.clock?.now() ?? new Date()).toISOString();
    const runId = this.deps.idGenerator?.randomId() ?? randomUUID();
    const provider = await this.deps.provider.start({
      session: plan.session,
      systemPrompt: controlledAgentControllerSystemPrompt(),
    });
    const run: ControlledAgentRun = {
      schemaVersion: 1,
      runId,
      sessionId: plan.session.sessionId,
      controllerJobId: plan.session.identity.controllerJobId,
      providerKind: plan.session.identity.providerKind,
      status: ControlledAgentRunStatus.Running,
      ...(provider.providerRunId === undefined ? {} : {
        providerRunId: provider.providerRunId,
      }),
      ...(this.deps.owner === undefined ? {} : { owner: this.deps.owner }),
      ...(this.deps.capacity === undefined ? {} : {
        capacityAccountId: this.deps.capacity.accountId,
        ...(this.deps.capacity.demand === undefined
          ? {}
          : { capacityDemand: this.deps.capacity.demand }),
      }),
      ...(provider.safeMessage === undefined ? {} : {
        safeMessage: provider.safeMessage,
      }),
      startedAt: now,
      updatedAt: now,
    };
    const runningSession: ControlledAgentSession = {
      ...plan.session,
      status: ControlledAgentRunStatus.Running,
      activeRunId: run.runId,
      ...(this.deps.owner === undefined ? {} : { owner: this.deps.owner }),
      updatedAt: now,
    };
    await this.deps.stateStore?.saveSession(runningSession);
    await this.deps.stateStore?.saveRun(run);
    await this.deps.events?.append({
      schemaVersion: 1,
      eventId: this.deps.idGenerator?.randomId() ?? randomUUID(),
      sessionId: runningSession.sessionId,
      runId: run.runId,
      controllerJobId: runningSession.identity.controllerJobId,
      type: ControlledAgentEventType.RunStarted,
      occurredAt: now,
      payload: {
        providerKind: runningSession.identity.providerKind,
        providerRunId: provider.providerRunId ?? null,
        ownerId: this.deps.owner?.ownerId ?? null,
        ownerKind: this.deps.owner?.kind ?? null,
      },
    });
    return {
      ok: true,
      plan,
      session: runningSession,
      run,
      provider,
    };
  }

  private async existingRunOwnerIsLive(run: ControlledAgentRun): Promise<boolean> {
    if (run.owner === undefined) {
      const thresholdMs = this.deps.recoverOwnerlessActiveRunAfterMs;
      if (thresholdMs === undefined) {
        return true;
      }
      const referenceTime = Date.parse(run.updatedAt ?? run.startedAt);
      if (!Number.isFinite(referenceTime)) {
        return true;
      }
      const now = this.deps.clock?.now() ?? new Date();
      return now.getTime() - referenceTime < thresholdMs;
    }
    if (this.deps.ownerLiveness === undefined) {
      return true;
    }
    return await this.deps.ownerLiveness.isLive(run.owner);
  }
}

export async function startControlledAgentRun(
  input: ControlledAgentLaunchPlanInput,
  deps: StartControlledAgentRunDeps,
): Promise<StartControlledAgentRunResult> {
  return new StartControlledAgentRunUseCase(deps).start(input);
}
