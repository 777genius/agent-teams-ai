import { z } from "zod";
export function registerCodexGoalPrompts(server) {
    for (const prompt of [
        ["start_codex_goal_worker", "Start a stored Codex goal worker safely."],
        ["monitor_codex_goal_worker", "Monitor a running Codex goal worker."],
        ["recover_codex_goal_worker", "Recover a stopped Codex goal worker."],
        ["handoff_codex_goal_job", "Prepare a handoff for another agent."],
        ["review_worker_changes", "Review worker changes before merge or commit."],
    ]) {
        server.registerPrompt(prompt[0], {
            title: prompt[0],
            description: prompt[1],
            argsSchema: { jobId: z.string().optional() },
        }, ({ jobId }) => ({
            messages: [{
                    role: "user",
                    content: {
                        type: "text",
                        text: codexGoalPromptText(prompt[0], jobId),
                    },
                }],
        }));
    }
}
function codexGoalPromptText(name, jobId) {
    const id = jobId?.trim() || "<jobId>";
    const shared = `Use the subscription-runtime Codex goal MCP tools for jobId ${id}. ` +
        "Never print auth.json or tokens. Do not run two writer workers in the same worktree. " +
        "Treat codex_goal_overview as the registry monitor, codex_goal_brief as the single-job monitor, and codex_goal_decision as the read-only action gate for safeToContinue, blockers, evidence and nextBestCommand.";
    if (name === "start_codex_goal_worker") {
        return `${shared} First call codex_goal_decision. Start or continue only when decision.safeToContinue is true, otherwise follow decision.checklist and decision.nextBestCommand. If no job exists yet, create one with model gpt-5.5, reasoningEffort high, serviceTier default, app-server-goal behavior and 72h timeout.`;
    }
    if (name === "monitor_codex_goal_worker") {
        return `${shared} Call codex_goal_overview for pool-level status, codex_goal_brief for monitoring, and codex_goal_decision before taking action. If worker is alive and silentStale is false, keep monitoring instead of starting another worker. If silentStale is true, verify progress heartbeat, tmux, runner process, app-server process, recent log tail and git status before stopping or recovery.`;
    }
    if (name === "recover_codex_goal_worker") {
        return `${shared} Use codex_goal_recover only for safe capacity, auth, reconnect or timeout states and only when decision.safeToContinue is true. If decision.action is fix_accounts, call codex_goal_accounts_status for the job. Inspect dirty, provider_output_invalid, unknown runtime, test and benchmark failures manually.`;
    }
    if (name === "handoff_codex_goal_job") {
        return `${shared} Provide jobId, registryRootDir if non-default, worktree, branch, tmux session, task id, prompt path, accounts, model, effort, service tier, decision.action, decision.safeToContinue, decision.nextBestCommand and any dirty files.`;
    }
    return `${shared} Inspect git diff, result JSON, recent commands and test evidence before merging. Use codex_goal_mark_reviewed only after the worker output has been reviewed.`;
}
//# sourceMappingURL=codex-goal-mcp-prompts.js.map