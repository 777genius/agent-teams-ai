import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAuthJsonFromArtifact, sessionArtifactFromCodexAuthJson, validateCodexSessionArtifact, } from "./codex-auth-json-codec.js";
import { buildCodexRefreshBootstrapPlan, readCodexAuthJsonFreshness, pruneCodexChildEnv, } from "./codex-cli-domain.js";
import { cleanupCodexRuntimeTempRoot } from "./codex-cli-temp-cleanup.js";
import { codexAuthJsonFormatVersion, defaultCodexModel, codexProviderId, codexSessionCapabilities, } from "./capabilities.js";
import { classifyCodexFailure } from "./failure-classifier.js";
export class CodexCliSessionDriver {
    options;
    providerId = codexProviderId;
    supportedArtifactKinds = ["json-file"];
    capabilities;
    constructor(options = {}) {
        this.options = options;
        this.capabilities = options.refreshMode
            ? {
                ...codexSessionCapabilities,
                refreshMode: options.refreshMode,
            }
            : codexSessionCapabilities;
    }
    async validateSession(input) {
        return validateCodexSessionArtifact(input.session);
    }
    async refreshSession(input) {
        const authJson = codexAuthJsonFromArtifact(input.session);
        input.redactor.registerSecret(authJson, "codex-auth-json");
        const tempRoot = await mkdtemp(join(tmpdir(), "subscription-runtime-codex-"));
        const tempHome = join(tempRoot, "home");
        const tempCodexHome = join(tempRoot, "codex-home");
        const emptyWorkingDirectory = join(tempRoot, "empty-workdir");
        const authJsonPath = join(tempCodexHome, "auth.json");
        await mkdir(tempHome, { recursive: true, mode: 0o700 });
        await mkdir(tempCodexHome, { recursive: true, mode: 0o700 });
        await mkdir(emptyWorkingDirectory, { recursive: true, mode: 0o700 });
        try {
            await writeCodexHomeSnapshot({ codexHome: tempCodexHome, authJson });
            const plan = buildCodexRefreshBootstrapPlan({
                codexBinaryPath: this.options.codexBinaryPath ?? "codex",
                tempHome,
                tempCodexHome,
                emptyWorkingDirectory,
                authJsonPath,
                model: this.options.model ?? defaultCodexModel,
            });
            await input.runner.run({
                command: plan.command,
                args: plan.args,
                cwd: plan.cwd,
                env: {
                    ...pruneCodexChildEnv(this.options.sourceEnv ?? process.env),
                    ...plan.env,
                },
                stdin: new TextEncoder().encode("Respond with OK only."),
                timeoutMs: 5 * 60 * 1000,
                abortSignal: input.abortSignal,
            });
            const refreshedAuthJson = await readFile(authJsonPath, "utf8");
            const refreshed = sessionArtifactFromCodexAuthJson(refreshedAuthJson);
            const providerState = refreshedAuthJson === authJson ? "unchanged" : "refreshed";
            return {
                artifact: refreshed,
                providerState,
                warnings: [],
            };
        }
        catch (error) {
            const failure = classifyCodexFailure(error);
            if (failure.code === "needs_reconnect") {
                return {
                    artifact: {
                        ...input.session,
                        formatVersion: codexAuthJsonFormatVersion,
                    },
                    providerState: "needs-reconnect",
                    warnings: [],
                };
            }
            if (failure.code === "quota_limited") {
                return {
                    artifact: input.session,
                    providerState: "quota-limited",
                    warnings: [{ code: failure.code, safeMessage: failure.safeMessage }],
                };
            }
            if (failure.code === "permission_required") {
                return {
                    artifact: input.session,
                    providerState: "permission-required",
                    warnings: [{ code: failure.code, safeMessage: failure.safeMessage }],
                };
            }
            throw error;
        }
        finally {
            await cleanupCodexRuntimeTempRoot({ tempRoot, tempCodexHome });
        }
    }
    async inspectSessionFreshness(input) {
        const authJson = codexAuthJsonFromArtifact(input.session);
        const freshness = readCodexAuthJsonFreshness({
            authJsonBytes: authJson,
            now: input.now,
        });
        const warnings = freshness.warnings.map((warning) => ({
            code: warning,
            safeMessage: `Codex auth freshness warning: ${warning}`,
        }));
        if (freshness.lastRefreshAt) {
            const ageMs = input.now.getTime() - freshness.lastRefreshAt.getTime();
            if (ageMs >= input.policy.maxSessionAgeMs) {
                return {
                    status: "refresh_recommended",
                    reason: "max_age_exceeded",
                    refreshedAt: freshness.lastRefreshAt,
                    ...(freshness.expiresAt ? { expiresAt: freshness.expiresAt } : {}),
                    warnings,
                };
            }
        }
        if (freshness.expiresAt) {
            const refreshAt = freshness.expiresAt.getTime() - input.policy.refreshBeforeExpiryMs;
            if (freshness.expiresAt.getTime() <= input.now.getTime()) {
                return {
                    status: "refresh_recommended",
                    reason: "expired",
                    expiresAt: freshness.expiresAt,
                    ...(freshness.lastRefreshAt
                        ? { refreshedAt: freshness.lastRefreshAt }
                        : {}),
                    warnings,
                };
            }
            if (refreshAt <= input.now.getTime()) {
                return {
                    status: "refresh_recommended",
                    reason: "expires_soon",
                    expiresAt: freshness.expiresAt,
                    ...(freshness.lastRefreshAt
                        ? { refreshedAt: freshness.lastRefreshAt }
                        : {}),
                    warnings,
                };
            }
            return {
                status: "fresh",
                reason: "expires_later",
                expiresAt: freshness.expiresAt,
                ...(freshness.lastRefreshAt
                    ? { refreshedAt: freshness.lastRefreshAt }
                    : {}),
                warnings,
            };
        }
        if (freshness.lastRefreshAt) {
            const ageMs = input.now.getTime() - freshness.lastRefreshAt.getTime();
            if (ageMs <= input.policy.minFreshMs) {
                return {
                    status: "fresh",
                    reason: "recent_refresh",
                    refreshedAt: freshness.lastRefreshAt,
                    warnings,
                };
            }
        }
        return {
            status: "refresh_recommended",
            reason: "freshness_unknown",
            ...(freshness.lastRefreshAt
                ? { refreshedAt: freshness.lastRefreshAt }
                : {}),
            warnings,
        };
    }
    classifySessionFailure(error) {
        return classifyCodexFailure(error);
    }
}
async function writeCodexHomeSnapshot(input) {
    const config = [
        'cli_auth_credentials_store = "file"',
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        'web_search = "disabled"',
        "disable_response_storage = true",
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
//# sourceMappingURL=codex-cli-session-driver.js.map