import { createHash } from "node:crypto";
import { codexEnvironmentPolicy } from "./capabilities.js";
export const codexAuthJsonMaxBytes = 32 * 1024;
export function validateCodexAuthJsonBytes(input) {
    const maxBytes = input.maxBytes ?? codexAuthJsonMaxBytes;
    const byteLength = Buffer.byteLength(input.authJsonBytes, "utf8");
    if (byteLength === 0) {
        throw new Error("codex_auth_json_empty");
    }
    if (byteLength > maxBytes) {
        throw new Error("codex_auth_json_too_large");
    }
    let parsedJson;
    try {
        parsedJson = JSON.parse(input.authJsonBytes);
    }
    catch {
        throw new Error("codex_auth_json_invalid_json");
    }
    const parsed = parseCodexAuthJson(parsedJson);
    return {
        parsed,
        byteLength,
        exactBytesSha256: createHash("sha256")
            .update(input.authJsonBytes, "utf8")
            .digest("hex"),
        warnings: collectCodexAuthJsonWarnings({
            parsed,
            staleWarningDays: input.staleWarningDays ?? 30,
            now: input.now ?? new Date(),
        }),
    };
}
export function compactCodexAuthJson(input) {
    const validation = validateCodexAuthJsonBytes(input);
    const compactAuthJsonBytes = JSON.stringify(validation.parsed);
    const byteLength = Buffer.byteLength(compactAuthJsonBytes, "utf8");
    if (byteLength > (input.maxBytes ?? codexAuthJsonMaxBytes)) {
        throw new Error("codex_auth_json_too_large_after_compact");
    }
    return { compactAuthJsonBytes, byteLength };
}
export function readCodexAuthJsonFreshness(input) {
    const validation = validateCodexAuthJsonBytes({
        authJsonBytes: input.authJsonBytes,
        ...(input.now ? { now: input.now } : {}),
    });
    const warnings = [...validation.warnings];
    const lastRefreshAt = parseOptionalDate(validation.parsed.last_refresh, "last_refresh_unparseable", warnings);
    const expiresAt = parseOptionalExpiry(validation.parsed.tokens.expiry, warnings);
    return {
        lastRefreshAt,
        expiresAt,
        warnings,
    };
}
export function classifyCodexRuntimeFailure(message) {
    const normalized = message.toLowerCase();
    if (isCodexQuotaOrRateLimitFailure(normalized)) {
        return "quota_limited";
    }
    if (normalized.includes("unauthorized") ||
        normalized.includes("invalid_grant") ||
        normalized.includes("refresh token") ||
        normalized.includes("login required")) {
        return "needs_reconnect";
    }
    if (normalized.includes("permission") ||
        normalized.includes("forbidden") ||
        normalized.includes("resource not accessible")) {
        return "permission_required";
    }
    return "unknown_auth_state";
}
function isCodexQuotaOrRateLimitFailure(normalizedMessage) {
    return (/\b(?:429|too many requests|rate[_ -]?limit(?:ed| exceeded)?|rate_limit_exceeded)\b/.test(normalizedMessage) ||
        /\b(?:rate[_ -]?limits?|not enough retry quota|usage[_ -]?limit(?: reached| exceeded)?|limit reached)\b/.test(normalizedMessage) ||
        /\b(?:insufficient_quota|quota_exceeded|exceeded (?:your )?(?:current )?quota|quota (?:limit|exceeded))\b/.test(normalizedMessage) ||
        /\byou(?:'|’)ve hit your usage limit\b/.test(normalizedMessage) ||
        /\b(?:purchase|buy|add|get) more credits\b/.test(normalizedMessage) ||
        /\bout of credits\b/.test(normalizedMessage) ||
        /\b(?:billing_hard_limit|payment required|billing (?:limit|quota|hard limit|not active|required))\b/.test(normalizedMessage));
}
export function pruneCodexChildEnv(env) {
    const allowed = {};
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined)
            continue;
        if (!shouldAllowChildEnvKey(key))
            continue;
        allowed[key] = value;
    }
    return allowed;
}
export function buildCodexRefreshBootstrapPlan(input) {
    return {
        command: input.codexBinaryPath,
        args: [
            "exec",
            "--sandbox",
            "read-only",
            "--ignore-rules",
            "--ephemeral",
            "-C",
            input.emptyWorkingDirectory,
            "--skip-git-repo-check",
            "-",
        ],
        cwd: input.emptyWorkingDirectory,
        env: {
            HOME: input.tempHome,
            CODEX_HOME: input.tempCodexHome,
            REVIEWROUTER_CODEX_AUTH_PATH: input.authJsonPath,
        },
    };
}
function parseCodexAuthJson(value) {
    if (!isObject(value)) {
        throw new Error("codex_auth_json_invalid_shape");
    }
    if (value.auth_mode !== "chatgpt") {
        throw new Error("codex_auth_json_invalid_auth_mode");
    }
    if (!isObject(value.tokens)) {
        throw new Error("codex_auth_json_missing_tokens");
    }
    if (typeof value.tokens.refresh_token !== "string" ||
        value.tokens.refresh_token.length === 0) {
        throw new Error("codex_auth_json_missing_refresh_token");
    }
    for (const key of ["access_token", "id_token"]) {
        const token = value.tokens[key];
        if (token !== undefined && typeof token !== "string") {
            throw new Error(`codex_auth_json_invalid_${key}`);
        }
    }
    if (value.last_refresh !== undefined &&
        typeof value.last_refresh !== "string") {
        throw new Error("codex_auth_json_invalid_last_refresh");
    }
    if (value.tokens.expiry !== undefined &&
        typeof value.tokens.expiry !== "string" &&
        typeof value.tokens.expiry !== "number") {
        throw new Error("codex_auth_json_invalid_expiry");
    }
    return value;
}
function collectCodexAuthJsonWarnings(input) {
    const warnings = [];
    if (!input.parsed.last_refresh) {
        warnings.push("last_refresh_missing");
        return warnings;
    }
    const refreshedAt = Date.parse(input.parsed.last_refresh);
    if (!Number.isFinite(refreshedAt)) {
        warnings.push("last_refresh_unparseable");
        return warnings;
    }
    const ageDays = (input.now.getTime() - refreshedAt) / 86_400_000;
    if (ageDays > input.staleWarningDays) {
        warnings.push("last_refresh_stale");
    }
    return warnings;
}
function parseOptionalDate(value, warning, warnings) {
    if (!value)
        return null;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
        if (!warnings.includes(warning))
            warnings.push(warning);
        return null;
    }
    return new Date(parsed);
}
function parseOptionalExpiry(value, warnings) {
    if (value === undefined)
        return null;
    const ms = typeof value === "number"
        ? normalizeEpochToMs(value)
        : Number.isFinite(Number(value))
            ? normalizeEpochToMs(Number(value))
            : Date.parse(value);
    if (!Number.isFinite(ms)) {
        warnings.push("expiry_unparseable");
        return null;
    }
    return new Date(ms);
}
function normalizeEpochToMs(value) {
    return value < 10_000_000_000 ? value * 1000 : value;
}
function shouldDropChildEnvKey(key) {
    return codexEnvironmentPolicy.denylist.some((pattern) => matchesEnvPattern(key, pattern));
}
function shouldAllowChildEnvKey(key) {
    if (shouldDropChildEnvKey(key)) {
        return false;
    }
    if (codexEnvironmentPolicy.inheritHostEnvironment) {
        return true;
    }
    return codexEnvironmentPolicy.allowlist.some((pattern) => matchesEnvPattern(key, pattern));
}
function matchesEnvPattern(key, pattern) {
    if (pattern.endsWith("*") && pattern.startsWith("*")) {
        return key.includes(pattern.slice(1, -1));
    }
    if (pattern.endsWith("*")) {
        return key.startsWith(pattern.slice(0, -1));
    }
    if (pattern.startsWith("*")) {
        return key.endsWith(pattern.slice(1));
    }
    return key === pattern;
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=codex-cli-domain.js.map