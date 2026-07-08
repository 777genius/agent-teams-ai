import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { InterruptAndContinueWorkerUseCase, } from "@vioxen/subscription-runtime/worker-core";
import { collectCodexGoalStatus, } from "./codex-goal-ops.js";
import { jobIdInputSchema, } from "./codex-goal-mcp-inputs.js";
import { mcpJson, withMcpErrors, } from "./codex-goal-mcp-response.js";
import { codexGoalWorkerControlService, codexGoalWorkerControlTarget, } from "./codex-goal-mcp-worker-control.js";
import { parseIsoDate, signalIdList, workerControlCallerArgs, workerControlDecisionJson, workerControlReceiptJson, workerControlSignalJson, workerControlSignalViewJson, } from "./codex-goal-mcp-worker-control-view.js";
import { booleanValue, requiredRawString, stringValue, } from "./codex-goal-mcp-values.js";
import { codexGoalStatusInputFromLaunch as statusInput, } from "./codex-goal-mcp-status-input.js";
import { loadJobLaunch, } from "./codex-goal-mcp-project-control-deps.js";
import { codexGoalControlDeliveryDiagnostic, } from "./application/codex-goal-control-delivery-diagnostic.js";
export function registerCodexGoalWorkerControlTools(server, options = {}) {
    server.registerTool("codex_goal_pause", {
        title: "Soft Pause Codex Goal",
        description: "Write a soft pause request marker. This never kills a running worker.",
        inputSchema: jobIdInputSchema(),
    }, async (args) => withMcpErrors(async () => {
        const loaded = await loadJobLaunch(args);
        await mkdir(loaded.launch.config.jobRootDir, { recursive: true, mode: 0o700 });
        const pausePath = join(loaded.launch.config.jobRootDir, `${loaded.launch.config.taskId}.pause-request.json`);
        const status = await collectCodexGoalStatus(statusInput(loaded.launch));
        const controlSignal = await codexGoalWorkerControlService(loaded.launch)
            .enqueueSignal({
            target: codexGoalWorkerControlTarget(loaded),
            intent: "pause_requested",
            deliveryMode: "next_safe_point",
            body: "Soft pause was requested by the operator. Pause at the next safe point if the provider/session supports it; otherwise preserve this request in the continuation context.",
            createdBy: "operator",
            priority: "normal",
        });
        await writeFile(pausePath, `${JSON.stringify({
            schemaVersion: 1,
            jobId: loaded.manifest.jobId,
            taskId: loaded.launch.config.taskId,
            requestedAt: new Date().toISOString(),
            mode: "soft_pause_only",
            note: "The running worker is not terminated by this marker.",
        }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        return mcpJson({
            ok: true,
            jobId: loaded.manifest.jobId,
            pausePath,
            controlSignal: workerControlSignalJson(controlSignal, false),
            status,
            safeMessage: "Soft pause marker written. No tmux session or worker process was killed.",
        });
    }));
    server.registerTool("codex_goal_send_guidance", {
        title: "Send Codex Goal Guidance",
        description: "Durably send guidance to a Codex goal. Requests interrupt-then-continue when the active attempt is locally controllable; otherwise it safely falls back to next safe continuation.",
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
    }, async (args) => withMcpErrors(async () => {
        const controlArgs = args;
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
                ? { priority: stringValue(controlArgs.priority) }
                : {}),
            ...(stringValue(controlArgs.idempotencyKey)
                ? { idempotencyKey: stringValue(controlArgs.idempotencyKey) }
                : {}),
            ...(stringValue(controlArgs.expiresAt)
                ? { expiresAt: parseIsoDate(stringValue(controlArgs.expiresAt), "expiresAt") }
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
    }));
    server.registerTool("codex_goal_control_enqueue", {
        title: "Enqueue Codex Goal Control Signal",
        description: "Durably enqueue guidance or a control request for a stored Codex goal job. Default delivery is next safe continuation.",
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
    }, async (args) => withMcpErrors(async () => {
        const loaded = await loadJobLaunch(args);
        const control = codexGoalWorkerControlService(loaded.launch);
        const controlArgs = args;
        const enqueueInput = {
            target: codexGoalWorkerControlTarget(loaded),
            intent: requiredRawString(controlArgs.intent, "intent"),
            ...(stringValue(controlArgs.deliveryMode)
                ? {
                    deliveryMode: stringValue(controlArgs.deliveryMode),
                }
                : {}),
            body: requiredRawString(controlArgs.body, "body"),
            ...(stringValue(controlArgs.createdBy)
                ? { createdBy: stringValue(controlArgs.createdBy) }
                : {}),
            ...workerControlCallerArgs(controlArgs),
            ...(stringValue(controlArgs.priority)
                ? { priority: stringValue(controlArgs.priority) }
                : {}),
            ...(stringValue(controlArgs.idempotencyKey)
                ? { idempotencyKey: stringValue(controlArgs.idempotencyKey) }
                : {}),
            ...(stringValue(controlArgs.expiresAt)
                ? { expiresAt: parseIsoDate(stringValue(controlArgs.expiresAt), "expiresAt") }
                : {}),
            supersedesSignalIds: signalIdList(controlArgs.supersedesSignalIds),
        };
        const signal = await control.enqueueSignal(enqueueInput);
        const decision = await control.getDecision({
            target: codexGoalWorkerControlTarget(loaded),
        });
        return mcpJson({
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
        });
    }));
    server.registerTool("codex_goal_control_list", {
        title: "List Codex Goal Control Signals",
        description: "List durable control inbox signals for a stored Codex goal job.",
        inputSchema: {
            ...jobIdInputSchema(),
            includeBodies: z.boolean().optional(),
        },
    }, async (args) => withMcpErrors(async () => {
        const loaded = await loadJobLaunch(args);
        const control = codexGoalWorkerControlService(loaded.launch);
        const includeBodies = booleanValue(args.includeBodies) ?? false;
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
    }));
    server.registerTool("codex_goal_control_decision", {
        title: "Codex Goal Control Decision",
        description: "Inspect pending control inbox signals and whether they are safe for next continuation.",
        inputSchema: jobIdInputSchema(),
    }, async (args) => withMcpErrors(async () => {
        const loaded = await loadJobLaunch(args);
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
    }));
    server.registerTool("codex_goal_control_reconcile", {
        title: "Reconcile Codex Goal Control Inbox",
        description: "Return derived control inbox counts for a stored Codex goal job. With repair, stale accepted local delivery claims can be released back to pending.",
        inputSchema: {
            ...jobIdInputSchema(),
            repair: z.boolean().optional(),
            acceptedStaleAfterMs: z.number().int().positive().optional(),
        },
    }, async (args) => withMcpErrors(async () => {
        const controlArgs = args;
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
    }));
    server.registerTool("codex_goal_control_supersede", {
        title: "Supersede Codex Goal Control Signal",
        description: "Mark a pending control inbox signal as superseded for a stored Codex goal job.",
        inputSchema: {
            ...jobIdInputSchema(),
            signalId: z.string(),
            supersededBySignalId: z.string().optional(),
            reason: z.string().optional(),
            callerKind: z.enum(["user", "operator", "orchestrator", "runtime", "agent"]).optional(),
            callerActor: z.enum(["user", "operator", "orchestrator", "runtime", "agent"]).optional(),
            callerId: z.string().optional(),
        },
    }, async (args) => withMcpErrors(async () => {
        const loaded = await loadJobLaunch(args);
        const control = codexGoalWorkerControlService(loaded.launch);
        const receipt = await control.markSuperseded({
            target: codexGoalWorkerControlTarget(loaded),
            signalId: requiredRawString(args.signalId, "signalId"),
            ...(stringValue(args.supersededBySignalId)
                ? {
                    supersededBySignalId: stringValue(args.supersededBySignalId),
                }
                : {}),
            ...(stringValue(args.reason)
                ? { reason: stringValue(args.reason) }
                : {}),
            ...workerControlCallerArgs(args),
        });
        return mcpJson({
            ok: true,
            registryRootDir: loaded.registryRootDir,
            jobId: loaded.manifest.jobId,
            taskId: loaded.launch.config.taskId,
            receipt: workerControlReceiptJson(receipt),
        });
    }));
}
//# sourceMappingURL=codex-goal-mcp-worker-control-tools.js.map