import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sessionArtifactFromCodexAuthJson } from "@vioxen/subscription-runtime/provider-codex";
import { createLocalClaudeControlledAgentProvider, loadScopedClaudeSessionArtifact, } from "@vioxen/subscription-runtime/worker-local";
import { RunEventProviderKind, } from "@vioxen/subscription-runtime/worker-core";
import { CodexControlledAgentProvider } from "./controlled-agent/index.js";
import { availableCodexGoalAccountSlots, dedupeCodexGoalAccountSlots, } from "./codex-goal-mcp-accounts.js";
import { redactText, truncateText } from "./codex-goal-mcp-decision.js";
import { stringValue } from "./codex-goal-mcp-values.js";
import { codexGoalStateRootDir, codexGoalWorkerControlService, codexGoalWorkerControlTarget, } from "./codex-goal-mcp-worker-control.js";
import { listCodexGoalAccountStatuses } from "./codex-goal-ops.js";
export async function projectControllerProvider(input) {
    if (input.profile.providerKind === RunEventProviderKind.Claude) {
        const loaded = await controlledAgentClaudeSessionArtifact(input);
        const controllerObjective = await projectControllerObjectiveWithPendingGuidance(input.controller, input.launch);
        return {
            provider: createLocalClaudeControlledAgentProvider({
                profile: input.profile,
                sessionArtifact: loaded.sessionArtifact,
                workspacePath: input.launch.config.workspacePath,
                ...(stringValue(input.args.claudePath) === undefined
                    ? {}
                    : { claudePath: stringValue(input.args.claudePath) }),
                ...(input.launch.config.model === undefined
                    ? {}
                    : { model: input.launch.config.model }),
                ...(input.args.maxGoalTurns === undefined
                    ? {}
                    : { maxTurns: input.args.maxGoalTurns }),
                controllerObjective,
            }),
            sessionArtifact: {
                path: loaded.path,
                sha256Prefix: loaded.sha256Prefix,
            },
            safeMessage: "Claude broker-only controlled-agent provider started with strict MCP broker tools.",
        };
    }
    const account = await controlledAgentCodexAccount({
        controller: input.controller,
        launch: input.launch,
    });
    const controllerObjective = await projectControllerObjectiveWithPendingGuidance(input.controller, input.launch);
    return {
        provider: new CodexControlledAgentProvider({
            profile: input.profile,
            sessionArtifact: account.sessionArtifact,
            workspacePath: input.launch.config.workspacePath,
            codexBinaryPath: input.launch.config.codexBinaryPath ?? "codex",
            controllerObjective,
            ...(input.launch.config.model === undefined
                ? {}
                : { model: input.launch.config.model }),
            ...(input.launch.config.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: input.launch.config.reasoningEffort }),
            ...(input.launch.config.serviceTier === undefined
                ? {}
                : { serviceTier: input.launch.config.serviceTier }),
            ...(input.args.maxGoalTurns === undefined
                ? {}
                : { maxGoalTurns: input.args.maxGoalTurns }),
        }),
        account: {
            name: account.name,
            ...(account.authJsonSha256Prefix === undefined
                ? {}
                : { authJsonSha256Prefix: account.authJsonSha256Prefix }),
        },
        safeMessage: "Codex broker-only controlled-agent provider started with native app-server environments disabled.",
    };
}
async function projectControllerObjectiveWithPendingGuidance(controller, launch) {
    const baseObjective = await readFile(launch.config.promptPath, "utf8");
    const guidanceContext = await projectControllerPendingGuidanceContext(controller, launch);
    return guidanceContext === undefined
        ? baseObjective
        : `${baseObjective}\n\n${guidanceContext}`;
}
async function projectControllerPendingGuidanceContext(controller, launch) {
    try {
        const control = codexGoalWorkerControlService(launch);
        const target = codexGoalWorkerControlTarget({
            manifest: controller.controller,
            launch,
        });
        const decision = await control.getDecision({ target });
        return projectControllerPendingGuidancePromptContext({
            pendingCount: decision.pendingSignals.length,
            deliverableSignals: decision.deliverableSignals,
        });
    }
    catch {
        return undefined;
    }
}
export function projectControllerPendingGuidancePromptContext(input) {
    const deliverable = input.deliverableSignals
        .slice()
        .sort((left, right) => right.signal.createdAt.getTime() - left.signal.createdAt.getTime())
        .slice(0, 5);
    if (deliverable.length === 0)
        return undefined;
    const lines = [
        "Pending controller guidance from durable inbox:",
        "- Treat this as read-only context for this run.",
        "- Before applying it, call codex_goal_project_controller_consume_guidance for your controller job so the inbox records delivery.",
        `- pendingCount=${input.pendingCount} deliverableCount=${input.deliverableSignals.length}`,
    ];
    for (const view of deliverable) {
        const signal = view.signal;
        lines.push(`- ${signal.createdAt.toISOString()} ${signal.createdBy}/${signal.priority}: ${truncateText(redactPromptGuidanceText(signal.body), 800)}`);
    }
    if (input.deliverableSignals.length > deliverable.length) {
        lines.push(`- ${input.deliverableSignals.length - deliverable.length} older deliverable guidance item(s) omitted from prompt context.`);
    }
    return lines.join("\n");
}
function redactPromptGuidanceText(value) {
    return redactText(value).replace(/[A-Za-z0-9_=-]{32,}/g, "[redacted]");
}
async function controlledAgentCodexAccount(input) {
    if (!input.controller.scope.authRoot) {
        throw new Error("project_control_controller_auth_root_scope_required");
    }
    if (resolve(input.launch.config.authRootDir) !== resolve(input.controller.scope.authRoot)) {
        throw new Error("project_control_controller_auth_root_outside_scope");
    }
    const slots = await listCodexGoalAccountStatuses({
        authRootDir: input.launch.config.authRootDir,
        accounts: input.launch.config.accounts.map((account) => account.name),
        stateRootDir: codexGoalStateRootDir(input.launch),
    });
    const allowedAccountIds = input.controller.scope.allowedAccountIds;
    const available = availableCodexGoalAccountSlots(dedupeCodexGoalAccountSlots(slots))
        .filter((slot) => allowedAccountIds === undefined ||
        allowedAccountIds.includes(slot.name));
    const selected = available[0];
    if (!selected) {
        throw new Error("project_control_controller_no_available_account");
    }
    const authJsonBytes = await readFile(selected.authJsonPath, "utf8");
    return {
        name: selected.name,
        ...(selected.authJsonSha256Prefix === undefined
            ? {}
            : { authJsonSha256Prefix: selected.authJsonSha256Prefix }),
        sessionArtifact: sessionArtifactFromCodexAuthJson(authJsonBytes),
    };
}
async function controlledAgentClaudeSessionArtifact(input) {
    if (!input.controller.scope.authRoot) {
        throw new Error("project_control_controller_auth_root_scope_required");
    }
    const rawPath = stringValue(input.args.sessionArtifactPath);
    if (rawPath === undefined) {
        throw new Error("project_control_controller_session_artifact_path_required");
    }
    return loadScopedClaudeSessionArtifact({
        sessionArtifactPath: rawPath,
        authRoot: input.controller.scope.authRoot,
        cwd: input.state.cwd,
    });
}
//# sourceMappingURL=codex-goal-mcp-project-controller-provider.js.map