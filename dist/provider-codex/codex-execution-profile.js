const statelessCompletionBaseInstructions = [
    "You are a fast backend inference worker.",
    "Return only the requested final answer.",
    "Do not inspect files.",
    "Do not use tools unless explicitly allowed.",
    "If JSON is requested, return valid JSON only.",
].join(" ");
const subscriptionWorkerDeveloperInstructions = "You are a non-interactive subscription runtime worker. Do not run tools unless explicitly required by the prompt. Return one final answer only. If JSON or an output schema is requested, return strict valid JSON only, with no markdown fences or commentary.";
export function resolveCodexExecutionProfile(profile) {
    if (!profile || profile === "subscription-worker") {
        return {
            kind: "subscription-worker",
            baseInstructions: null,
            developerInstructions: subscriptionWorkerDeveloperInstructions,
            disableTools: true,
            historyMode: "none",
        };
    }
    if (profile === "stateless-completion") {
        return {
            kind: "stateless-completion",
            baseInstructions: statelessCompletionBaseInstructions,
            developerInstructions: null,
            disableTools: true,
            historyMode: "none",
        };
    }
    return {
        kind: "custom",
        baseInstructions: profile.baseInstructions === undefined
            ? null
            : emptyToNull(profile.baseInstructions),
        developerInstructions: profile.developerInstructions === undefined
            ? null
            : emptyToNull(profile.developerInstructions),
        disableTools: profile.disableTools ?? true,
        historyMode: profile.historyMode ?? "none",
    };
}
function emptyToNull(value) {
    if (value === null)
        return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}
//# sourceMappingURL=codex-execution-profile.js.map