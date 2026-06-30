export class ClaudeCliTaskExecutionEngine {
    options;
    kind = "claude-cli-print";
    capabilities = {
        supportsStreaming: false,
        supportsToolCalls: false,
        supportsUsage: false,
        supportsProviderRunId: false,
        supportsCleanup: true,
    };
    constructor(options = {}) {
        this.options = options;
    }
    async run(input) {
        if (!input.session.configDir)
            throw new Error("claude_config_dir_required");
        assertReadOnlyToolPolicy(input.permissionMode, input.allowedTools);
        const warnings = unsupportedWarnings(input);
        const result = await input.runner.run({
            command: this.options.claudePath ?? "claude",
            args: this.args(input),
            cwd: input.workspacePath,
            env: this.env(input),
            timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
            abortSignal: input.abortSignal,
        });
        const stdout = input.redactor.redact(result.stdout.trim());
        const stderr = input.redactor.redact(result.stderr.trim());
        input.redactor.assertNoKnownSecret(stdout, "claude-cli-stdout");
        input.redactor.assertNoKnownSecret(stderr, "claude-cli-stderr");
        assertOutputWithinBounds(stdout, this.options.maxOutputBytes);
        assertOutputWithinBounds(stderr, this.options.maxOutputBytes);
        if (stderr.length > 0) {
            warnings.push({
                code: "claude_cli_stderr",
                safeMessage: "Claude CLI wrote diagnostics to stderr.",
                details: { stderrPreview: preview(stderr) },
            });
        }
        return {
            outputText: stdout,
            ...(input.outputSchemaName === undefined
                ? {}
                : { structuredOutput: parseStructuredJson(stdout) }),
            telemetry: {
                durationMs: result.durationMs,
            },
            warnings,
        };
    }
    args(input) {
        const args = [
            "--print",
            "--safe-mode",
            "--no-session-persistence",
            "--output-format",
            "text",
            "--model",
            input.model,
            "--permission-mode",
            mapPermissionMode(input.permissionMode),
        ];
        if (input.appendSystemPrompt !== undefined) {
            args.push("--append-system-prompt", input.appendSystemPrompt);
        }
        if (input.allowedTools !== undefined) {
            args.push("--allowedTools", input.allowedTools.join(","));
        }
        if (input.mcpConfig !== undefined) {
            args.push("--mcp-config", ...input.mcpConfig);
        }
        if (input.strictMcpConfig) {
            args.push("--strict-mcp-config");
        }
        args.push(input.prompt);
        return args;
    }
    env(input) {
        const configDir = input.session.configDir;
        return definedEnv({
            ...pruneClaudeChildEnv(this.options.baseEnv ?? process.env),
            HOME: configDir,
            CLAUDE_CONFIG_DIR: configDir,
            CLAUDE_CODE_OAUTH_TOKEN: input.session.oauthToken,
            CI: "true",
        });
    }
}
const defaultTimeoutMs = 30 * 60 * 1000;
function mapPermissionMode(mode) {
    if (mode === "allow-edits")
        return "acceptEdits";
    if (mode === "bypass")
        return "bypassPermissions";
    if (mode === "read-only" || mode === "preapproved")
        return "dontAsk";
    return "default";
}
function assertReadOnlyToolPolicy(permissionMode, allowedTools) {
    if (permissionMode !== "read-only" || allowedTools === undefined)
        return;
    const unsafe = allowedTools.filter((tool) => !isReadOnlyClaudeTool(tool));
    if (unsafe.length === 0)
        return;
    throw new Error(`claude_read_only_allowed_tools_unsafe:${unsafe.join(",")}`);
}
const readOnlyClaudeTools = new Set([
    "Glob",
    "Grep",
    "LS",
    "Read",
    "TodoRead",
    "WebFetch",
]);
function isReadOnlyClaudeTool(tool) {
    const name = tool.split("(", 1)[0]?.trim();
    return name !== undefined && readOnlyClaudeTools.has(name);
}
function unsupportedWarnings(input) {
    const warnings = [];
    if (input.maxTurns !== undefined) {
        warnings.push({
            code: "claude_cli_max_turns_unsupported",
            safeMessage: "Claude CLI print engine does not support maxTurns.",
        });
    }
    return warnings;
}
function parseStructuredJson(outputText) {
    try {
        return JSON.parse(outputText);
    }
    catch {
        throw new Error("claude_structured_output_invalid");
    }
}
function assertOutputWithinBounds(output, maxOutputBytes = 2 * 1024 * 1024) {
    if (Buffer.byteLength(output, "utf8") <= maxOutputBytes)
        return;
    throw new Error("claude_output_too_large");
}
function pruneClaudeChildEnv(env) {
    const allowed = new Set([
        "CI",
        "LANG",
        "LC_ALL",
        "PATH",
        "TEMP",
        "TMP",
        "TMPDIR",
    ]);
    return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined &&
        (allowed.has(key) || key.startsWith("LC_"))));
}
function definedEnv(env) {
    return Object.fromEntries(Object.entries(env).filter((entry) => entry[1] !== undefined));
}
function preview(value) {
    return value.length <= 1000 ? value : `${value.slice(-1000)}`;
}
//# sourceMappingURL=claude-cli-task-execution-engine.js.map