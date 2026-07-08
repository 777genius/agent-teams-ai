import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  InterruptAndContinueWorkerUseCase,
  type ActiveAttemptRegistry,
  type WorkerControlActor,
  type WorkerControlDeliveryMode,
  type WorkerControlIntent,
  type WorkerControlDecision,
  type WorkerControlPriority,
  type WorkerControlSignal,
} from "@vioxen/subscription-runtime/worker-core";
import {
  collectCodexGoalStatus,
  resolveCodexGoalWorkerLiveness,
} from "./codex-goal-ops";
import {
  jobIdInputSchema,
  type JobIdMcpArgs,
  type WorkerControlMcpArgs,
} from "./codex-goal-mcp-inputs";
import {
  mcpJson,
  withMcpErrors,
} from "./codex-goal-mcp-response";
import {
  codexGoalWorkerControlService,
  codexGoalWorkerControlTarget,
} from "./codex-goal-mcp-worker-control";
import {
  parseIsoDate,
  signalIdList,
  workerControlCallerArgs,
  workerControlDecisionJson,
  workerControlReceiptJson,
  workerControlSignalJson,
  workerControlSignalViewJson,
} from "./codex-goal-mcp-worker-control-view";
import {
  booleanValue,
  numberValue,
  requiredRawString,
  stringValue,
} from "./codex-goal-mcp-values";
import {
  codexGoalStatusInputFromLaunch as statusInput,
} from "./codex-goal-mcp-status-input";
import {
  loadJobLaunch,
} from "./codex-goal-mcp-project-control-deps";

type CodexGoalWorkerControlToolOptions = {
  readonly activeAttemptRegistry?: ActiveAttemptRegistry;
};

export function registerCodexGoalWorkerControlTools(
  server: McpServer,
  options: CodexGoalWorkerControlToolOptions = {},
): void {
  server.registerTool(
    "codex_goal_pause",
    {
      title: "Soft Pause Codex Goal",
      description:
        "Write a soft pause request marker. This never kills a running worker.",
      inputSchema: jobIdInputSchema(),
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as JobIdMcpArgs);
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
        }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      return mcpJson({
        ok: true,
        jobId: loaded.manifest.jobId,
        pausePath,
        controlSignal: workerControlSignalJson(controlSignal, false),
        status,
        safeMessage:
          "Soft pause marker written. No tmux session or worker process was killed.",
      });
    }),
  );

  server.registerTool(
    "codex_goal_send_guidance",
    {
      title: "Send Codex Goal Guidance",
      description:
        "Durably send guidance to a Codex goal. Requests interrupt-then-continue when the active attempt is locally controllable; otherwise it safely falls back to next safe continuation.",
      inputSchema: {
        ...jobIdInputSchema(),
        message: z.string(),
        callerKind: z.enum(["user", "operator", "orchestrator", "runtime", "agent"]).optional(),
        callerActor: z.enum(["user", "operator", "orchestrator", "runtime", "agent"]).optional(),
        callerId: z.string().optional(),
        priority: z.enum(["low", "normal", "high"]).optional(),
        idempotencyKey: z.string().optional(),
        expiresAt: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const controlArgs = args as WorkerControlMcpArgs & {
        readonly message?: string;
      };
      const loaded = await loadJobLaunch(controlArgs);
      const control = codexGoalWorkerControlService(loaded.launch);
      const useCase = new InterruptAndContinueWorkerUseCase({
        control,
        ...(options.activeAttemptRegistry === undefined
          ? {}
          : { activeAttemptRegistry: options.activeAttemptRegistry }),
      });
      const result = await useCase.execute({
        target: codexGoalWorkerControlTarget(loaded),
        message: requiredRawString(controlArgs.message, "message"),
        ...workerControlCallerArgs(controlArgs),
        ...(stringValue(controlArgs.priority)
          ? { priority: stringValue(controlArgs.priority) as WorkerControlPriority }
          : {}),
        ...(stringValue(controlArgs.idempotencyKey)
          ? { idempotencyKey: stringValue(controlArgs.idempotencyKey) as string }
          : {}),
        ...(stringValue(controlArgs.expiresAt)
          ? { expiresAt: parseIsoDate(stringValue(controlArgs.expiresAt) as string, "expiresAt") }
          : {}),
      });
      const decision = await control.getDecision({
        target: codexGoalWorkerControlTarget(loaded),
      });
      return mcpJson({
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        taskId: loaded.launch.config.taskId,
        status: result.status,
        signal: workerControlSignalJson(result.signal, false),
        decision: workerControlDecisionJson(decision, false),
        safeMessage: result.safeMessage,
      });
    }),
  );

  server.registerTool(
    "codex_goal_control_enqueue",
    {
      title: "Enqueue Codex Goal Control Signal",
      description:
        "Durably enqueue guidance or a control request for a stored Codex goal job. Default delivery is next safe continuation.",
      inputSchema: {
        ...jobIdInputSchema(),
        intent: z.enum([
          "guidance",
          "pause_requested",
          "stop_requested",
          "cancel_requested",
          "resume_requested",
          "repair_requested",
          "policy_update",
          "operator_note",
        ]),
        deliveryMode: z.enum([
          "record_only",
          "next_safe_point",
          "pause_then_continue",
          "interrupt_then_continue",
          "idle_turn_if_supported",
          "live_if_supported",
        ]).optional(),
        body: z.string(),
        createdBy: z.enum(["user", "operator", "orchestrator", "runtime", "agent"]).optional(),
        callerKind: z.enum(["user", "operator", "orchestrator", "runtime", "agent"]).optional(),
        callerActor: z.enum(["user", "operator", "orchestrator", "runtime", "agent"]).optional(),
        callerId: z.string().optional(),
        priority: z.enum(["low", "normal", "high"]).optional(),
        idempotencyKey: z.string().optional(),
        expiresAt: z.string().optional(),
        supersedesSignalIds: z.union([z.string(), z.array(z.string())]).optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as WorkerControlMcpArgs);
      const control = codexGoalWorkerControlService(loaded.launch);
      const controlArgs = args as WorkerControlMcpArgs;
      const enqueueInput = {
        target: codexGoalWorkerControlTarget(loaded),
        intent: requiredRawString(controlArgs.intent, "intent") as WorkerControlIntent,
        ...(stringValue(controlArgs.deliveryMode)
          ? {
              deliveryMode: stringValue(controlArgs.deliveryMode) as WorkerControlDeliveryMode,
            }
          : {}),
        body: requiredRawString(controlArgs.body, "body"),
        ...(stringValue(controlArgs.createdBy)
          ? { createdBy: stringValue(controlArgs.createdBy) as WorkerControlActor }
          : {}),
        ...workerControlCallerArgs(controlArgs),
        ...(stringValue(controlArgs.priority)
          ? { priority: stringValue(controlArgs.priority) as WorkerControlPriority }
          : {}),
        ...(stringValue(controlArgs.idempotencyKey)
          ? { idempotencyKey: stringValue(controlArgs.idempotencyKey) as string }
          : {}),
        ...(stringValue(controlArgs.expiresAt)
          ? { expiresAt: parseIsoDate(stringValue(controlArgs.expiresAt) as string, "expiresAt") }
          : {}),
        supersedesSignalIds: signalIdList(controlArgs.supersedesSignalIds),
      };
      const signal = await control.enqueueSignal(enqueueInput);
      const decision = await control.getDecision({
        target: codexGoalWorkerControlTarget(loaded),
      });
      const status = await collectCodexGoalStatus(statusInput(loaded.launch));
      return mcpJson({
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        taskId: loaded.launch.config.taskId,
        signal: workerControlSignalJson(signal, false),
        decision: workerControlDecisionJson(decision, false),
        deliveryDiagnostic: controlDeliveryDiagnostic({ decision, status, signal }),
      });
    }),
  );

  server.registerTool(
    "codex_goal_control_list",
    {
      title: "List Codex Goal Control Signals",
      description:
        "List durable control inbox signals for a stored Codex goal job.",
      inputSchema: {
        ...jobIdInputSchema(),
        includeBodies: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as WorkerControlMcpArgs);
      const control = codexGoalWorkerControlService(loaded.launch);
      const includeBodies =
        booleanValue((args as WorkerControlMcpArgs).includeBodies) ?? false;
      const signals = await control.listSignals({
        target: codexGoalWorkerControlTarget(loaded),
        includeBodies,
        includeExpired: true,
      });
      return mcpJson({
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        taskId: loaded.launch.config.taskId,
        signals: signals.map((view) => workerControlSignalViewJson(view, includeBodies)),
      });
    }),
  );

  server.registerTool(
    "codex_goal_control_decision",
    {
      title: "Codex Goal Control Decision",
      description:
        "Inspect pending control inbox signals and whether they are safe for next continuation.",
      inputSchema: jobIdInputSchema(),
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as WorkerControlMcpArgs);
      const control = codexGoalWorkerControlService(loaded.launch);
      const decision = await control.getDecision({
        target: codexGoalWorkerControlTarget(loaded),
      });
      return mcpJson({
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        taskId: loaded.launch.config.taskId,
        decision: workerControlDecisionJson(decision, false),
      });
    }),
  );

  server.registerTool(
    "codex_goal_control_reconcile",
    {
      title: "Reconcile Codex Goal Control Inbox",
      description:
        "Return derived control inbox counts for a stored Codex goal job. With repair, stale accepted local delivery claims can be released back to pending.",
      inputSchema: {
        ...jobIdInputSchema(),
        repair: z.boolean().optional(),
        acceptedStaleAfterMs: z.number().int().positive().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const controlArgs = args as WorkerControlMcpArgs;
      const loaded = await loadJobLaunch(controlArgs);
      const control = codexGoalWorkerControlService(loaded.launch);
      const report = await control.reconcile({
        target: codexGoalWorkerControlTarget(loaded),
        ...(controlArgs.repair === undefined ? {} : { repair: controlArgs.repair }),
        ...(controlArgs.acceptedStaleAfterMs === undefined
          ? {}
          : { acceptedStaleAfterMs: controlArgs.acceptedStaleAfterMs }),
      });
      return mcpJson({
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        taskId: loaded.launch.config.taskId,
        report,
      });
    }),
  );

  server.registerTool(
    "codex_goal_control_supersede",
    {
      title: "Supersede Codex Goal Control Signal",
      description:
        "Mark a pending control inbox signal as superseded for a stored Codex goal job.",
      inputSchema: {
        ...jobIdInputSchema(),
        signalId: z.string(),
        supersededBySignalId: z.string().optional(),
        reason: z.string().optional(),
        callerKind: z.enum(["user", "operator", "orchestrator", "runtime", "agent"]).optional(),
        callerActor: z.enum(["user", "operator", "orchestrator", "runtime", "agent"]).optional(),
        callerId: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as WorkerControlMcpArgs);
      const control = codexGoalWorkerControlService(loaded.launch);
      const receipt = await control.markSuperseded({
        target: codexGoalWorkerControlTarget(loaded),
        signalId: requiredRawString((args as WorkerControlMcpArgs).signalId, "signalId"),
        ...(stringValue((args as WorkerControlMcpArgs).supersededBySignalId)
          ? {
              supersededBySignalId: stringValue((args as WorkerControlMcpArgs).supersededBySignalId) as string,
            }
          : {}),
        ...(stringValue((args as WorkerControlMcpArgs).reason)
          ? { reason: stringValue((args as WorkerControlMcpArgs).reason) as string }
          : {}),
        ...workerControlCallerArgs(args as WorkerControlMcpArgs),
      });
      return mcpJson({
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        taskId: loaded.launch.config.taskId,
        receipt: workerControlReceiptJson(receipt),
      });
    }),
  );

}

function controlDeliveryDiagnostic(input: {
  readonly decision: WorkerControlDecision;
  readonly status: Awaited<ReturnType<typeof collectCodexGoalStatus>>;
  readonly signal: WorkerControlSignal;
}): Readonly<Record<string, unknown>> {
  const progressStale = input.status.progressHeartbeatAgeMs !== undefined &&
    input.status.progressHeartbeatAgeMs > 10 * 60_000;
  const workerLiveness = resolveCodexGoalWorkerLiveness({
    status: input.status,
    progressStale,
  });
  const pendingSignal = input.decision.pendingSignals.find(
    (view) => view.signal.signalId === input.signal.signalId,
  );
  const base = {
    workerAlive: workerLiveness.alive,
    workerSupervisorKind: workerLiveness.supervisorKind,
    workerAliveReason: workerLiveness.aliveReason,
    signalState: pendingSignal?.state ?? "unknown",
    deliveryMode: input.signal.deliveryMode,
    deliverable: pendingSignal?.deliverable ?? false,
  };
  if (
    workerLiveness.alive &&
    pendingSignal?.state === "pending" &&
    input.signal.deliveryMode === "next_safe_point"
  ) {
    return {
      ...base,
      reason: "pending_until_next_safe_point",
      recommendedTool: "codex_goal_send_guidance",
      safeMessage:
        "Worker appears alive and the signal is pending until the next safe continuation point. Use codex_goal_send_guidance when immediate guidance delivery is required.",
    };
  }
  return base;
}
