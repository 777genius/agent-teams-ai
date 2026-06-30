import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
export async function createClaudeBgRuntimeContext(input, options = {}) {
    if (!input.configDir) {
        throw new Error("claude_config_dir_required");
    }
    const runtime = await (options.runtimeModuleLoader ?? loadClaudeRuntime)();
    const providerRuntime = await (options.providerModuleLoader ?? loadClaudeBgProviderRuntime)();
    const provider = new providerRuntime.ClaudeBgRuntimeProvider({
        ...(options.baseEnv === undefined ? {} : { baseEnv: options.baseEnv }),
        ...(options.claudePath === undefined ? {} : { claudePath: options.claudePath }),
        ...(options.commandTimeoutMs === undefined
            ? {}
            : { commandTimeoutMs: options.commandTimeoutMs }),
        configDir: input.configDir,
        fs: new NodeFileSystem(),
        oauthToken: input.oauthToken,
        ...(options.pollIntervalMs === undefined
            ? {}
            : { pollIntervalMs: options.pollIntervalMs }),
        runner: new NodeProcessRunnerLike(),
        store: new runtime.FileRuntimeStateStore({
            filePath: options.stateFilePath ??
                join(input.configDir, "subscription-runtime-claude-bg-state.json"),
        }),
    });
    return { runtime, provider };
}
class NodeFileSystem {
    readFile(path, encoding) {
        return readFile(path, encoding);
    }
    async writeFile(path, data) {
        await writeFile(path, data);
    }
    async stat(path) {
        try {
            const fileStat = await stat(path);
            return {
                isDirectory: fileStat.isDirectory(),
                isFile: fileStat.isFile(),
                modifiedAtMs: fileStat.mtimeMs,
                size: fileStat.size,
            };
        }
        catch (error) {
            if (isRecord(error) && error.code === "ENOENT")
                return null;
            throw error;
        }
    }
    realpath(path) {
        return realpath(path);
    }
    async mkdir(path, options) {
        await mkdir(path, options);
    }
}
class NodeProcessRunnerLike {
    run(request) {
        return new Promise((resolve, reject) => {
            const startedAt = performance.now();
            const stdoutChunks = [];
            const stderrChunks = [];
            let settled = false;
            let timedOut = false;
            let timeout;
            const child = spawn(request.executable, [...request.args], {
                cwd: request.cwd,
                env: toProcessEnv(request.env),
                shell: false,
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
            });
            const cleanup = () => {
                if (timeout !== undefined)
                    clearTimeout(timeout);
            };
            const currentResult = (exitCode, signal) => ({
                durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
                exitCode,
                ...(signal === undefined || signal === null ? {} : { signal }),
                stderr: Buffer.concat(stderrChunks).toString("utf8"),
                stdout: Buffer.concat(stdoutChunks).toString("utf8"),
                timedOut,
            });
            child.stdout.on("data", (chunk) => {
                stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            child.stderr.on("data", (chunk) => {
                stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            child.once("error", (error) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                reject(new Error(`process_spawn_failed:${error.code ?? "unknown"}`));
            });
            child.once("close", (exitCode, signal) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                resolve(currentResult(exitCode, signal));
            });
            if (request.timeoutMs !== undefined) {
                timeout = setTimeout(() => {
                    timedOut = true;
                    child.kill("SIGTERM");
                }, request.timeoutMs);
            }
            child.stdin.end(request.stdin);
        });
    }
}
function loadClaudeRuntime() {
    const specifier = "claude-runtime";
    return import(/* @vite-ignore */ specifier);
}
function loadClaudeBgProviderRuntime() {
    const specifier = "claude-runtime/unstable/claude-bg/provider";
    return import(/* @vite-ignore */ specifier);
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function toProcessEnv(env) {
    if (env === undefined)
        return undefined;
    const result = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined)
            result[key] = value;
    }
    return result;
}
//# sourceMappingURL=claude-bg-runtime-context.js.map