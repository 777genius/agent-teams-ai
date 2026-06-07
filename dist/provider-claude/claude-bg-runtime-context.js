import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function createClaudeBgRuntimeContext(input, options = {}) {
    if (!input.configDir) {
        throw new Error("claude_config_dir_required");
    }
    const runtime = await (options.runtimeModuleLoader ?? loadClaudeRuntime)();
    const providerRuntime = await (options.providerModuleLoader ?? loadClaudeBgProviderRuntime)();
    const redactor = new providerRuntime.SecretRedactor({
        secrets: [input.oauthToken],
    });
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
        redactor,
        runner: new providerRuntime.NodeProcessRunner({ redactor }),
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
//# sourceMappingURL=claude-bg-runtime-context.js.map