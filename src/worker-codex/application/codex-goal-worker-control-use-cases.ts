import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  InterruptAndContinueWorkerUseCase,
  type ActiveAttemptRegistry,
  type WorkerControlActor,
  type WorkerControlDeliveryMode,
  type WorkerControlIntent,
  type WorkerControlPriority,
} from "@vioxen/subscription-runtime/worker-core";
import {
  collectCodexGoalStatus,
} from "../codex-goal-ops";
import type {
  CodexGoalJobIdInput,
  CodexGoalWorkerControlInput,
} from "./codex-goal-use-case-inputs";
import {
  codexGoalStatusInputFromLaunch as statusInput,
} from "./codex-goal-status-input";
import {
  loadJobLaunch,
} from "../codex-goal-mcp-project-control-deps";
import {
  codexGoalWorkerControlService,
  codexGoalWorkerControlTarget,
} from "../codex-goal-mcp-worker-control";
import {
  parseIsoDate,
  signalIdList,
  workerControlCallerArgs,
  workerControlDecisionJson,
  workerControlReceiptJson,
  workerControlSignalJson,
  workerControlSignalViewJson,
} from "./codex-goal-worker-control-view";
import {
  booleanValue,
  requiredRawString,
  stringValue,
} from "./codex-goal-input-values";
import {
  codexGoalControlDeliveryDiagnostic,
} from "./codex-goal-control-delivery-diagnostic";

type JsonObject = Readonly<Record<string, unknown>>;

export type CodexGoalWorkerControlUseCaseOptions = {
  readonly activeAttemptRegistry?: ActiveAttemptRegistry;
};

export async function pauseCodexGoalWorker(
  args: CodexGoalJobIdInput,
): Promise<JsonObject> {
  const loaded = await loadJobLaunch(args);
  await mkdir(loaded.launch.config.jobRootDir, { recursive: true, mode: 0o700 });
  const pausePath = join(
    loaded.launch.config.jobRootDir,
    `${loaded.launch.config.taskId}.pause-request.json`,
  );
  const status = await collectCodexGoalStatus(statusInput(loaded.launch));
  const controlSignal = await codexGoalWorkerControlService(loaded.launch)
    .enqueueSignal({
      target: codexGoalWorkerControlTarget(loaded),
      intent: "pause_requested",
      deliveryMode: "next_safe_point",
      body:
        "Soft pause was requested by the operator. Pause at the next safe point if the provider/session supports it; otherwise preserve this request in the continuation context.",
      createdBy: "operator",
      priority: "normal",
    });
  await writeFile(
    pausePath,
    `${JSON.stringify({
      schemaVersion: 1,
      jobId: loaded.manifest.jobId,
      taskId: loaded.launch.config.taskId,
      requestedAt: new Date().toISOString(),
      mode: "soft_pause_only",
      note: "The running worker is not terminated by this marker.",
    }, null, 2)}
`,
    { encoding: "utf8", mode: 0o600 },
  );
  return {
    ok: true,
    jobId: loaded.manifest.jobId,
    pausePath,
    controlSignal: workerControlSignalJson(controlSignal, false),
    status,
    safeMessage:
      "Soft pause marker written. No tmux session or worker process was killed.",
  };
}

export async function sendCodexGoalGuidance(
  args: CodexGoalWorkerControlInput & { readonly message?: string },
  options: CodexGoalWorkerControlUseCaseOptions = {},
): Promise<JsonObject> {
  const loaded = await loadJobLaunch(args);
  const control = codexGoalWorkerControlService(loaded.launch);
  const useCase = new InterruptAndContinueWorkerUseCase({
    control,
    ...(options.activeAttemptRegistry === undefined
      ? {}
      : { activeAttemptRegistry: options.activeAttemptRegistry }),
  });
  const result = await useCase.execute({
    target: codexGoalWorkerControlTarget(loaded),
    message: requiredRawString(args.message, "message"),
    ...workerControlCallerArgs(args),
    ...(stringValue(args.priority)
      ? { priority: stringValue(args.priority) as WorkerControlPriority }
      : {}),
    ...(stringValue(args.idempotencyKey)
      ? { idempotencyKey: stringValue(args.idempotencyKey) as string }
      : {}),
    ...(stringValue(args.expiresAt)
      ? { expiresAt: parseIsoDate(stringValue(args.expiresAt) as string, "expiresAt") }
      : {}),
  });
  const decision = await control.getDecision({
    target: codexGoalWorkerControlTarget(loaded),
  });
  return {
    ok: true,
    registryRootDir: loaded.registryRootDir,
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    status: result.status,
    signal: workerControlSignalJson(result.signal, false),
    decision: workerControlDecisionJson(decision, false),
    safeMessage: result.safeMessage,
  };
}

export async function enqueueCodexGoalControlSignal(
  args: CodexGoalWorkerControlInput,
): Promise<JsonObject> {
  const loaded = await loadJobLaunch(args);
  const control = codexGoalWorkerControlService(loaded.launch);
  const enqueueInput = {
    target: codexGoalWorkerControlTarget(loaded),
    intent: requiredRawString(args.intent, "intent") as WorkerControlIntent,
    ...(stringValue(args.deliveryMode)
      ? { deliveryMode: stringValue(args.deliveryMode) as WorkerControlDeliveryMode }
      : {}),
    body: requiredRawString(args.body, "body"),
    ...(stringValue(args.createdBy)
      ? { createdBy: stringValue(args.createdBy) as WorkerControlActor }
      : {}),
    ...workerControlCallerArgs(args),
    ...(stringValue(args.priority)
      ? { priority: stringValue(args.priority) as WorkerControlPriority }
      : {}),
    ...(stringValue(args.idempotencyKey)
      ? { idempotencyKey: stringValue(args.idempotencyKey) as string }
      : {}),
    ...(stringValue(args.expiresAt)
      ? { expiresAt: parseIsoDate(stringValue(args.expiresAt) as string, "expiresAt") }
      : {}),
    supersedesSignalIds: signalIdList(args.supersedesSignalIds),
  };
  const signal = await control.enqueueSignal(enqueueInput);
  const decision = await control.getDecision({
    target: codexGoalWorkerControlTarget(loaded),
  });
  return {
    ok: true,
    registryRootDir: loaded.registryRootDir,
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    signal: workerControlSignalJson(signal, false),
    decision: workerControlDecisionJson(decision, false),
    deliveryDiagnostic: await codexGoalControlDeliveryDiagnostic({
      launch: loaded.launch,
      decision,
      signal,
    }),
  };
}

export async function listCodexGoalControlSignals(
  args: CodexGoalWorkerControlInput,
): Promise<JsonObject> {
  const loaded = await loadJobLaunch(args);
  const control = codexGoalWorkerControlService(loaded.launch);
  const includeBodies = booleanValue(args.includeBodies) ?? false;
  const signals = await control.listSignals({
    target: codexGoalWorkerControlTarget(loaded),
    includeBodies,
    includeExpired: true,
  });
  return {
    ok: true,
    registryRootDir: loaded.registryRootDir,
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    signals: signals.map((view) => workerControlSignalViewJson(view, includeBodies)),
  };
}

export async function inspectCodexGoalControlDecision(
  args: CodexGoalWorkerControlInput,
): Promise<JsonObject> {
  const loaded = await loadJobLaunch(args);
  const control = codexGoalWorkerControlService(loaded.launch);
  const decision = await control.getDecision({
    target: codexGoalWorkerControlTarget(loaded),
  });
  return {
    ok: true,
    registryRootDir: loaded.registryRootDir,
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    decision: workerControlDecisionJson(decision, false),
  };
}

export async function reconcileCodexGoalControlInbox(
  args: CodexGoalWorkerControlInput,
): Promise<JsonObject> {
  const loaded = await loadJobLaunch(args);
  const control = codexGoalWorkerControlService(loaded.launch);
  const report = await control.reconcile({
    target: codexGoalWorkerControlTarget(loaded),
    ...(args.repair === undefined ? {} : { repair: args.repair }),
    ...(args.acceptedStaleAfterMs === undefined
      ? {}
      : { acceptedStaleAfterMs: args.acceptedStaleAfterMs }),
  });
  return {
    ok: true,
    registryRootDir: loaded.registryRootDir,
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    report,
  };
}

export async function supersedeCodexGoalControlSignal(
  args: CodexGoalWorkerControlInput,
): Promise<JsonObject> {
  const loaded = await loadJobLaunch(args);
  const control = codexGoalWorkerControlService(loaded.launch);
  const receipt = await control.markSuperseded({
    target: codexGoalWorkerControlTarget(loaded),
    signalId: requiredRawString(args.signalId, "signalId"),
    ...(stringValue(args.supersededBySignalId)
      ? { supersededBySignalId: stringValue(args.supersededBySignalId) as string }
      : {}),
    ...(stringValue(args.reason)
      ? { reason: stringValue(args.reason) as string }
      : {}),
    ...workerControlCallerArgs(args),
  });
  return {
    ok: true,
    registryRootDir: loaded.registryRootDir,
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    receipt: workerControlReceiptJson(receipt),
  };
}
