import { z } from "zod";
import { jobRegistryInputSchema, } from "./codex-goal-mcp-inputs.js";
import { mcpJson, withMcpErrors, } from "./codex-goal-mcp-response.js";
import { compactAgentRunEvents, planAgentRunEventCompaction, projectAgentRunEvents, readAgentRunEvents, readAgentRunState, watchAgentRuns, } from "./codex-goal-mcp-run-events.js";
export function registerCodexGoalRunEventTools(server) {
    const agentRunWatchTool = {
        title: "Agent Run Watch",
        description: "Read-only provider-neutral run observation. Reports status, liveness, progress, logs, workspace changes, capacity hints and read-only recommendations without starting, stopping or continuing workers.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            providerKind: z.string().optional(),
            jobId: z.string().optional(),
            jobIds: z.union([z.string(), z.array(z.string())]).optional(),
            stateRootDir: z.string().optional(),
            runArtifactsRootDir: z.string().optional(),
            staleAfterMs: z.number().int().positive().optional(),
            tailLines: z.number().int().positive().optional(),
            limit: z.number().int().positive().optional(),
            includeChangedFiles: z.boolean().optional(),
            includeLogTail: z.boolean().optional(),
        },
    };
    server.registerTool("agent_run_watch", agentRunWatchTool, async (args) => withMcpErrors(async () => {
        const watch = await watchAgentRuns(args);
        return mcpJson(watch);
    }));
    server.registerTool("codex_goal_run_watch", {
        ...agentRunWatchTool,
        title: "Codex Goal Run Watch",
        description: "Codex-scoped read-only run observation. Reports status, liveness, progress, logs, workspace changes, capacity hints and read-only recommendations without starting, stopping or continuing workers.",
    }, async (args) => withMcpErrors(async () => {
        const watch = await watchAgentRuns(args);
        return mcpJson(watch);
    }));
    const agentRunEventsTool = {
        title: "Agent Run Events",
        description: "Read normalized durable run events from the local outbox. This is read-only and does not observe, start, stop, continue or recover workers.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            providerKind: z.string().optional(),
            jobId: z.string().optional(),
            eventRootDir: z.string().optional(),
            cursor: z.string().optional(),
            type: z.union([z.string(), z.array(z.string())]).optional(),
            types: z.union([z.string(), z.array(z.string())]).optional(),
            limit: z.number().int().positive().optional(),
        },
    };
    server.registerTool("agent_run_events", agentRunEventsTool, async (args) => withMcpErrors(async () => {
        const events = await readAgentRunEvents(args);
        return mcpJson(events);
    }));
    server.registerTool("codex_goal_events", {
        ...agentRunEventsTool,
        title: "Codex Goal Events",
        description: "Read normalized durable Codex goal run events from the local outbox. This is read-only and does not observe, start, stop, continue or recover workers.",
    }, async (args) => withMcpErrors(async () => {
        const events = await readAgentRunEvents({
            ...args,
            providerKind: "codex",
        });
        return mcpJson(events);
    }));
    const agentRunStateTool = {
        title: "Agent Run State",
        description: "Read projected run read-model state from the local event projection store. This is read-only and does not observe, start, stop, continue or recover workers.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            providerKind: z.string().optional(),
            jobId: z.string(),
            eventRootDir: z.string().optional(),
        },
    };
    server.registerTool("agent_run_state", agentRunStateTool, async (args) => withMcpErrors(async () => {
        const state = await readAgentRunState(args);
        return mcpJson(state);
    }));
    server.registerTool("codex_goal_state", {
        ...agentRunStateTool,
        title: "Codex Goal State",
        description: "Read projected Codex goal run read-model state from the local event projection store. This is read-only and does not observe, start, stop, continue or recover workers.",
    }, async (args) => withMcpErrors(async () => {
        const state = await readAgentRunState({
            ...args,
            providerKind: "codex",
        });
        return mcpJson(state);
    }));
    const agentRunEventCompactionTool = {
        title: "Agent Run Event Compaction",
        description: "Plan or run explicit local RunEvent JSONL compaction. This touches only the event outbox and delivery cursors; it does not observe, start, stop, continue or recover workers.",
        inputSchema: {
            ...jobRegistryInputSchema(),
            eventRootDir: z.string().optional(),
            keepEventsAfter: z.string().optional(),
            keepLatestEventsPerRun: z.number().int().positive().optional(),
            compactDeliveredEvents: z.boolean().optional(),
            dropInvalidLines: z.boolean().optional(),
            safetyMode: z.string().optional(),
            confirmCompact: z.boolean().optional(),
        },
    };
    server.registerTool("agent_run_event_compaction_plan", {
        ...agentRunEventCompactionTool,
        title: "Agent Run Event Compaction Plan",
        description: "Read-only plan for local RunEvent JSONL compaction. No files are rewritten.",
    }, async (args) => withMcpErrors(async () => {
        const plan = await planAgentRunEventCompaction(args);
        return mcpJson(plan);
    }));
    server.registerTool("agent_run_event_compact", {
        ...agentRunEventCompactionTool,
        title: "Agent Run Event Compact",
        description: "Run explicit local RunEvent JSONL compaction. Requires confirmCompact=true and never controls workers.",
    }, async (args) => withMcpErrors(async () => {
        const result = await compactAgentRunEvents(args);
        return mcpJson(result);
    }));
    const agentRunProjectEventsTool = {
        title: "Agent Run Project Events",
        description: "Observe runs and project normalized durable RunEvent records into the local outbox. This writes event/projection state only; it does not start, stop, continue or recover workers.",
        inputSchema: {
            ...agentRunWatchTool.inputSchema,
            eventRootDir: z.string().optional(),
            hostId: z.string().optional(),
            type: z.union([z.string(), z.array(z.string())]).optional(),
            types: z.union([z.string(), z.array(z.string())]).optional(),
        },
    };
    server.registerTool("agent_run_project_events", agentRunProjectEventsTool, async (args) => withMcpErrors(async () => {
        const projected = await projectAgentRunEvents(args);
        return mcpJson(projected);
    }));
    server.registerTool("codex_goal_project_events", {
        ...agentRunProjectEventsTool,
        title: "Codex Goal Project Events",
        description: "Observe Codex goal runs and project normalized durable RunEvent records into the local outbox. This writes event/projection state only; it does not start, stop, continue or recover workers.",
    }, async (args) => withMcpErrors(async () => {
        const projected = await projectAgentRunEvents({
            ...args,
            providerKind: "codex",
        });
        return mcpJson(projected);
    }));
}
//# sourceMappingURL=codex-goal-mcp-run-event-tools.js.map