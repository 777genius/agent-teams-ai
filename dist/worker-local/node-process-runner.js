import { spawn } from "node:child_process";
export class NodeProcessRunner {
    options;
    runnerId = "node-process-runner";
    capabilities = {
        runnerId: this.runnerId,
        supportsEnvAllowlist: true,
        supportsWorkingDirectory: true,
        supportsTimeout: true,
        supportsAbortSignal: true,
        supportsOutputRedaction: false,
        supportsReadOnlySandbox: false,
        readOnlyFilesystem: false,
        platform: "node-process",
    };
    constructor(options = {}) {
        this.options = options;
    }
    async run(input) {
        if (input.abortSignal.aborted) {
            throw new Error("node_process_runner_aborted");
        }
        const startedAt = Date.now();
        const child = spawn(input.command, [...input.args], {
            cwd: input.cwd,
            env: input.env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout = [];
        const stderr = [];
        child.stdout.on("data", (chunk) => {
            stdout.push(chunk);
            input.stdout?.write(chunk);
        });
        child.stderr.on("data", (chunk) => {
            stderr.push(chunk);
            input.stderr?.write(chunk);
        });
        let forceKillTimer = null;
        let abortError = null;
        let timedOut = false;
        const terminate = () => {
            if (child.exitCode !== null || child.signalCode !== null)
                return;
            child.kill("SIGTERM");
            forceKillTimer ??= setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) {
                    child.kill("SIGKILL");
                }
            }, this.options.killGraceMs ?? 5_000);
        };
        const timeout = setTimeout(() => {
            timedOut = true;
            terminate();
        }, input.timeoutMs);
        const abort = () => {
            abortError = new Error("node_process_runner_aborted");
            terminate();
        };
        input.abortSignal.addEventListener("abort", abort, { once: true });
        if (input.stdin) {
            child.stdin.end(input.stdin);
        }
        else {
            child.stdin.end();
        }
        try {
            const exit = await new Promise((resolve, reject) => {
                child.on("error", reject);
                child.on("close", (code) => resolve({ exitCode: code ?? 1 }));
            });
            if (abortError)
                throw abortError;
            if (timedOut) {
                throw new Error(`node_process_runner_timeout:${input.timeoutMs}`);
            }
            const result = {
                exitCode: exit.exitCode,
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: Buffer.concat(stderr).toString("utf8"),
                durationMs: Date.now() - startedAt,
            };
            if (exit.exitCode !== 0) {
                throw Object.assign(new Error(`node_process_runner_failed:${exit.exitCode}:${safeFailureOutput(`${result.stdout}\n${result.stderr}`)}`), {
                    exitCode: exit.exitCode,
                    stdout: result.stdout,
                    stderr: result.stderr,
                });
            }
            return result;
        }
        finally {
            clearTimeout(timeout);
            if (forceKillTimer)
                clearTimeout(forceKillTimer);
            input.abortSignal.removeEventListener("abort", abort);
        }
    }
}
function safeFailureOutput(output) {
    const compact = output.replace(/\s+/g, " ").trim();
    return compact ? compact.slice(-1000) : "empty_process_output";
}
//# sourceMappingURL=node-process-runner.js.map