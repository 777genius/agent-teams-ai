import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAuthJsonFromArtifact } from "./codex-auth-json-codec.js";
import { pruneCodexChildEnv } from "./codex-cli-domain.js";
import { cleanupCodexRuntimeTempRoot } from "./codex-cli-temp-cleanup.js";
import { codexAgentCapabilities, codexAgentId, codexProviderId, defaultCodexModel, } from "./capabilities.js";
import { classifyCodexFailure } from "./failure-classifier.js";
export class CodexCliAgentDriver {
    options;
    agentId = codexAgentId;
    providerId = codexProviderId;
    capabilities = codexAgentCapabilities;
    constructor(options = {}) {
        this.options = options;
    }
    async runTask(input) {
        if (!input.session) {
            return {
                status: "failed",
                failure: {
                    code: "provider_session_invalid",
                    retryable: false,
                    reconnectRequired: true,
                    safeMessage: "Codex requires a session artifact.",
                },
                warnings: [],
            };
        }
        const authJson = codexAuthJsonFromArtifact(input.session);
        input.redactor.registerSecret(authJson, "codex-auth-json");
        const tempRoot = await mkdtemp(join(tmpdir(), "subscription-runtime-codex-"));
        const tempHome = join(tempRoot, "home");
        const tempCodexHome = join(tempRoot, "codex-home");
        await mkdir(tempHome, { recursive: true, mode: 0o700 });
        await mkdir(tempCodexHome, { recursive: true, mode: 0o700 });
        try {
            await writeCodexHomeSnapshot({ codexHome: tempCodexHome, authJson });
            const result = await input.runner.run({
                command: this.options.codexBinaryPath ?? "codex",
                args: [
                    "exec",
                    "--skip-git-repo-check",
                    "--model",
                    this.options.model ?? defaultCodexModel,
                    "--",
                    input.task.prompt,
                ],
                cwd: input.workspace.path,
                env: {
                    ...pruneCodexChildEnv(this.options.sourceEnv ?? process.env),
                    HOME: tempHome,
                    CODEX_HOME: tempCodexHome,
                    CI: "true",
                },
                timeoutMs: this.options.timeoutMs ?? this.capabilities.maxRuntimeMs,
                abortSignal: input.abortSignal,
            });
            const stdout = input.redactor.redact(result.stdout);
            const stderr = input.redactor.redact(result.stderr);
            input.redactor.assertNoKnownSecret(stdout, "codex-agent-stdout");
            input.redactor.assertNoKnownSecret(stderr, "codex-agent-stderr");
            if (result.exitCode !== 0) {
                return {
                    status: "failed",
                    failure: this.classifyRunFailure(`${stdout}\n${stderr}`),
                    warnings: [],
                };
            }
            return {
                status: "completed",
                outputText: stdout,
                warnings: [],
            };
        }
        finally {
            await cleanupCodexRuntimeTempRoot({ tempRoot, tempCodexHome });
        }
    }
    classifyRunFailure(error) {
        return classifyCodexFailure(error);
    }
}
async function writeCodexHomeSnapshot(input) {
    const config = [
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        "",
        "[history]",
        'persistence = "none"',
        "",
        "[otel]",
        'exporter = "none"',
        'metrics_exporter = "none"',
        'trace_exporter = "none"',
        "log_user_prompt = false",
        "",
        "[shell_environment_policy]",
        'inherit = "none"',
        'include_only = ["PATH", "HOME", "CI", "CODEX_HOME"]',
        "",
    ].join("\n");
    await writeFile(join(input.codexHome, "config.toml"), config, {
        mode: 0o600,
    });
    await writeFile(join(input.codexHome, "auth.json"), input.authJson, {
        mode: 0o600,
    });
}
//# sourceMappingURL=codex-cli-agent-driver.js.map