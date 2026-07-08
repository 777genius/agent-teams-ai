import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
  enqueueCodexGoalControlSignal,
  inspectCodexGoalControlDecision,
  listCodexGoalControlSignals,
  pauseCodexGoalWorker,
  reconcileCodexGoalControlInbox,
  sendCodexGoalGuidance,
  supersedeCodexGoalControlSignal,
  type CodexGoalWorkerControlUseCaseOptions,
} from "./application/codex-goal-worker-control-use-cases";

type CodexGoalWorkerControlToolOptions = CodexGoalWorkerControlUseCaseOptions;

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
    async (args) => withMcpErrors(async () =>
      mcpJson(await pauseCodexGoalWorker(args as JobIdMcpArgs)),
    ),
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
    async (args) => withMcpErrors(async () =>
      mcpJson(await sendCodexGoalGuidance(
        args as WorkerControlMcpArgs & { readonly message?: string },
        options,
      )),
    ),
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
    async (args) => withMcpErrors(async () =>
      mcpJson(await enqueueCodexGoalControlSignal(args as WorkerControlMcpArgs)),
    ),
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
    async (args) => withMcpErrors(async () =>
      mcpJson(await listCodexGoalControlSignals(args as WorkerControlMcpArgs)),
    ),
  );

  server.registerTool(
    "codex_goal_control_decision",
    {
      title: "Codex Goal Control Decision",
      description:
        "Inspect pending control inbox signals and whether they are safe for next continuation.",
      inputSchema: jobIdInputSchema(),
    },
    async (args) => withMcpErrors(async () =>
      mcpJson(await inspectCodexGoalControlDecision(args as WorkerControlMcpArgs)),
    ),
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
    async (args) => withMcpErrors(async () =>
      mcpJson(await reconcileCodexGoalControlInbox(args as WorkerControlMcpArgs)),
    ),
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
    async (args) => withMcpErrors(async () =>
      mcpJson(await supersedeCodexGoalControlSignal(args as WorkerControlMcpArgs)),
    ),
  );
}
