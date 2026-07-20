import { readFile } from "node:fs/promises";
import {
  type ProjectAccessScope,
  type ProjectControlBroker,
} from "@vioxen/subscription-runtime/worker-core";
import {
  codexGoalWorkerControlService,
  codexGoalWorkerControlTarget,
} from "./application/codex-goal-worker-control";
import { assertControlledRuntimeInterruptionSignal } from "./application/project-control/codex-goal-project-controlled-runtime-interruption-continuation";
import { assertReadablePrompt } from "./application/project-control/codex-goal-project-refill";
import {
  projectPreStartContinuationDecision,
  type ProjectPreStartContinuationDecision,
} from "./application/project-control/codex-goal-project-pre-start-continuation";
import {
  codexGoalJobToArgs,
  type CodexGoalJobManifest,
} from "./codex-goal-jobs";
import { goalLaunchInput } from "./codex-goal-mcp-launch-input";
import type { CodexProjectControlBrokerInput } from "./codex-goal-mcp-project-broker";
import {
  collectCodexGoalStatus,
  resolveCodexGoalWorkerLiveness,
  type CodexGoalLaunchInput,
  type CodexGoalStatus,
} from "./codex-goal-ops";
import type { ProjectControlWorkspaceLease } from "./codex-goal-project-workspace-lock";
import { readControlledRuntimeInterruptionEvidence } from "./codex-goal-runtime-control-evidence";
import { codexGoalStatusInputFromLaunch } from "./codex-goal-mcp-status-input";

const MAX_RECOVERABLE_RESULT_BYTES = 256 * 1024;
const APP_SERVER_RECONNECT_TIMEOUT_PREFIX =
  "codex_app_server_reconnect_timeout:";
const PREWARM_FAILED_REASON = "prewarm_failed";
const PREWARM_FAILED_ERROR_CODE = "subscription_worker_prewarm_failed";
const PREWARM_BEFORE_ATTEMPT_EVIDENCE =
  "provider prewarm failed before any task attempt";

export async function resolveProjectPreStartContinuation(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
  readonly reviewedOutputId?: string;
  readonly status: CodexGoalStatus;
}): Promise<ProjectPreStartContinuationDecision | undefined> {
  const controlledInterruptionEvidence =
    await readControlledRuntimeInterruptionEvidence({
      resultPath: input.status.resultPath,
      taskId: input.launch.config.taskId,
    });
  const decision = projectPreStartContinuationDecision({
    manifest: input.manifest,
    ...(input.reviewedOutputId
      ? { reviewedOutputId: input.reviewedOutputId }
      : {}),
    status: input.status,
    ...(controlledInterruptionEvidence
      ? { controlledInterruptionEvidence }
      : {}),
  });
  if (decision) return decision;
  if (await isRecoverableAdmittedInputPatchReconnect(input)) {
    return {
      kind: "capacity",
      workspaceMode: "admitted_input_patch_continuation",
    };
  }
  return (await isRecoverableAdmittedInputPatchPrewarmFailure(input))
    ? {
        kind: "prewarm_before_attempt",
        workspaceMode: "admitted_input_patch_continuation",
      }
    : undefined;
}

export async function assertProjectPreStartContinuationEvidence(input: {
  readonly decision: ProjectPreStartContinuationDecision | undefined;
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
}): Promise<void> {
  if (input.decision?.kind !== "controlled_runtime_interruption") return;
  const target = codexGoalWorkerControlTarget({
    manifest: input.manifest,
    launch: input.launch,
  });
  const signals = await codexGoalWorkerControlService(input.launch).listSignals(
    {
      target,
      signalIds: [input.decision.evidence.signalId],
      includeExpired: true,
    },
  );
  assertControlledRuntimeInterruptionSignal({
    evidence: input.decision.evidence,
    target,
    signals,
  });
}

export function sameProjectPreStartContinuation(
  left: ProjectPreStartContinuationDecision | undefined,
  right: ProjectPreStartContinuationDecision | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function observeProjectPreStartContinuation(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
  readonly reviewedOutputId?: string;
}): Promise<{
  readonly status: CodexGoalStatus;
  readonly decision: ProjectPreStartContinuationDecision | undefined;
  readonly workerAlive: boolean;
}> {
  const status = await collectCodexGoalStatus(
    codexGoalStatusInputFromLaunch(input.launch),
  );
  const decision = await resolveProjectPreStartContinuation({
    ...input,
    status,
  });
  const progressStale =
    status.progressHeartbeatAgeMs !== undefined &&
    status.progressHeartbeatAgeMs > 10 * 60_000;
  return {
    status,
    decision,
    workerAlive: projectPreStartWorkerAlive(status, progressStale),
  };
}

export async function loadProjectPreStartObservation(
  manifest: CodexGoalJobManifest,
  reviewedOutputId?: string,
): Promise<{
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
  readonly status: CodexGoalStatus;
  readonly decision: ProjectPreStartContinuationDecision | undefined;
  readonly workerAlive: boolean;
}> {
  const launch = await goalLaunchInput(codexGoalJobToArgs(manifest));
  return {
    manifest,
    launch,
    ...(await observeProjectPreStartContinuation({
      manifest,
      launch,
      ...(reviewedOutputId ? { reviewedOutputId } : {}),
    })),
  };
}

export async function reapProjectPreStartCapacitySupervisor(input: {
  readonly workerAlive: boolean;
  readonly decision: ProjectPreStartContinuationDecision | undefined;
  readonly createBroker: (
    input: Omit<CodexProjectControlBrokerInput, "admissionDeps">,
  ) => ProjectControlBroker;
  readonly registryRootDir: string;
  readonly controller: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
  readonly workspace: ProjectControlWorkspaceLease;
}): Promise<unknown | undefined> {
  if (!input.workerAlive || input.decision?.kind !== "capacity") return;
  const broker = input.createBroker({
    registryRootDir: input.registryRootDir,
    controller: input.controller,
    scope: input.scope,
    startLaunch: input.launch,
    startManifest: input.manifest,
    startAdmissionWorkspaceMode: input.decision.workspaceMode,
    startWorkspaceLease: input.workspace,
    stopLaunch: input.launch,
  });
  const result = await broker.stopWorker({
    jobId: input.manifest.jobId,
    registryRoot: input.registryRootDir,
    workspacePath: input.manifest.workspacePath,
    ...(input.launch.tmuxSession
      ? { tmuxSession: input.launch.tmuxSession }
      : {}),
  });
  const observed = await observeProjectPreStartContinuation({
    manifest: input.manifest,
    launch: input.launch,
  });
  if (observed.workerAlive) {
    throw new Error("project_control_terminal_capacity_supervisor_reap_failed");
  }
  return result;
}

export function projectWorkerAlreadyRunningView(input: {
  readonly controllerJobId: string;
  readonly jobId: string;
  readonly status: CodexGoalStatus;
}): Readonly<Record<string, unknown>> {
  return {
    ok: false,
    reason: "worker_already_running",
    ...input,
  };
}

export function projectStatusRequiresReviewView(input: {
  readonly controllerJobId: string;
  readonly jobId: string;
  readonly status: CodexGoalStatus;
}): Readonly<Record<string, unknown>> {
  return {
    ok: false,
    reason: "status_requires_review",
    ...input,
    requiredOverride: "forceStart",
  };
}

export async function projectPromptFailureView(input: {
  readonly promptPath: string;
  readonly controllerJobId: string;
  readonly jobId: string;
}): Promise<Readonly<Record<string, unknown>> | undefined> {
  try {
    await assertReadablePrompt({ promptPath: input.promptPath });
    return;
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error
          ? error.message
          : "project_control_prompt_missing_before_start",
      mode: "project_control_start",
      ...input,
    };
  }
}

export function projectTmuxSessionRequiredView(
  controllerJobId: string,
  jobId: string,
  noTmuxCommand: string,
): Readonly<Record<string, unknown>> {
  return {
    ok: false,
    reason: "tmux_session_required",
    controllerJobId,
    jobId,
    noTmuxCommand,
  };
}

export function projectConfirmStartRequiredView(
  controllerJobId: string,
  jobId: string,
  auditPath: string,
  tmuxCommand: string,
  status: CodexGoalStatus,
): Readonly<Record<string, unknown>> {
  return {
    ok: false,
    reason: "confirm_start_required",
    controllerJobId,
    jobId,
    auditPath,
    tmuxCommand,
    status,
  };
}

async function isRecoverableAdmittedInputPatchReconnect(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
  readonly reviewedOutputId?: string;
  readonly status: CodexGoalStatus;
}): Promise<boolean> {
  const status = input.status;
  const progressStale =
    status.progressHeartbeatAgeMs !== undefined &&
    status.progressHeartbeatAgeMs > 10 * 60_000;
  if (
    input.reviewedOutputId ||
    !input.manifest.projectPreStartAdmission ||
    status.workspaceDirty !== true ||
    status.resultExists !== true ||
    (status.resultStatus !== "failed" &&
      status.resultStatus !== "partial") ||
    status.resultReason !== "unknown_error" ||
    !status.resultPath ||
    projectPreStartWorkerAlive(status, progressStale)
  ) {
    return false;
  }
  try {
    const body = await readFile(status.resultPath);
    if (body.byteLength > MAX_RECOVERABLE_RESULT_BYTES) return false;
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (
      !isRecord(parsed) ||
      parsed.status !== status.resultStatus ||
      parsed.reason !== "unknown_error" ||
      parsed.taskId !== input.launch.config.taskId ||
      parsed.nextAction !== "preserve_patch" ||
      !stringArray(parsed.changedFiles) ||
      parsed.changedFiles.length === 0 ||
      !stringArray(parsed.evidence) ||
      !stringArray(parsed.blockers) ||
      !samePaths(parsed.changedFiles, status.changedFiles ?? []) ||
      !isRecord(parsed.details)
    ) {
      return false;
    }
    const rawCause = parsed.details.rawCause;
    return (
      typeof rawCause === "string" &&
      rawCause.startsWith(APP_SERVER_RECONNECT_TIMEOUT_PREFIX)
    );
  } catch {
    return false;
  }
}

async function isRecoverableAdmittedInputPatchPrewarmFailure(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
  readonly reviewedOutputId?: string;
  readonly status: CodexGoalStatus;
}): Promise<boolean> {
  const status = input.status;
  const progressStale =
    status.progressHeartbeatAgeMs !== undefined &&
    status.progressHeartbeatAgeMs > 10 * 60_000;
  if (
    input.reviewedOutputId ||
    !input.manifest.projectPreStartAdmission ||
    status.workspaceDirty !== true ||
    status.recommendedAction !== "inspect_dirty_failure" ||
    status.resultExists !== true ||
    (status.resultStatus !== "failed" && status.resultStatus !== "partial") ||
    status.resultReason !== PREWARM_FAILED_REASON ||
    (status.progressResultReason !== undefined &&
      status.progressResultReason !== PREWARM_FAILED_REASON) ||
    !status.resultPath ||
    projectPreStartWorkerAlive(status, progressStale)
  ) {
    return false;
  }
  try {
    const body = await readFile(status.resultPath);
    if (body.byteLength > MAX_RECOVERABLE_RESULT_BYTES) return false;
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (
      !isRecord(parsed) ||
      parsed.status !== status.resultStatus ||
      parsed.reason !== PREWARM_FAILED_REASON ||
      parsed.taskId !== input.launch.config.taskId ||
      parsed.nextAction !== "preserve_patch" ||
      !stringArray(parsed.changedFiles) ||
      parsed.changedFiles.length === 0 ||
      !stringArray(parsed.evidence) ||
      !parsed.evidence.includes(PREWARM_BEFORE_ATTEMPT_EVIDENCE) ||
      !stringArray(parsed.blockers) ||
      parsed.blockers.length !== 1 ||
      parsed.blockers[0] !== PREWARM_FAILED_REASON ||
      !samePaths(parsed.changedFiles, status.changedFiles ?? []) ||
      !isRecord(parsed.details)
    ) {
      return false;
    }
    return (
      parsed.details.errorCode === PREWARM_FAILED_ERROR_CODE &&
      typeof parsed.details.baseCommit === "string" &&
      /^[a-f0-9]{40}$/i.test(parsed.details.baseCommit)
    );
  } catch {
    return false;
  }
}

function projectPreStartWorkerAlive(
  status: CodexGoalStatus,
  progressStale: boolean,
): boolean {
  return resolveCodexGoalWorkerLiveness({ status, progressStale }).alive;
}

function stringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
  );
}

function samePaths(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalizedLeft = [...new Set(left)].sort((a, b) => a.localeCompare(b));
  const normalizedRight = [...new Set(right)].sort((a, b) =>
    a.localeCompare(b),
  );
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((path, index) => path === normalizedRight[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
