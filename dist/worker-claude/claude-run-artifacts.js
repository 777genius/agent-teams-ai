import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile, } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { DefaultRedactor, } from "@vioxen/subscription-runtime/core";
export const claudeRunArtifactSchemaVersion = 1;
export class FileClaudeRunArtifactStore {
    options;
    clock;
    redactor;
    terminalRunIds = new Set();
    constructor(options) {
        this.options = options;
        this.clock = options.clock ?? systemClock;
        this.redactor = options.redactor ?? new DefaultRedactor();
    }
    paths(runId) {
        const runDir = join(this.options.rootDir, hashText(runId));
        return {
            runDir,
            manifestPath: join(runDir, "manifest.json"),
            progressPath: join(runDir, "progress.json"),
            resultPath: join(runDir, "result.json"),
            logPath: join(runDir, "run.log"),
        };
    }
    async listRunIds() {
        let entries;
        try {
            entries = await readdir(this.options.rootDir, { withFileTypes: true });
        }
        catch {
            return [];
        }
        const manifests = await Promise.all(entries
            .filter((entry) => entry.isDirectory())
            .map(async (entry) => {
            try {
                return await this.readManifestByDir(join(this.options.rootDir, entry.name));
            }
            catch {
                return null;
            }
        }));
        return manifests
            .filter((manifest) => manifest !== null)
            .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
            .map((manifest) => manifest.runId);
    }
    async startRun(input) {
        const now = this.clock.now().toISOString();
        const paths = this.paths(input.runId);
        await mkdir(paths.runDir, { recursive: true, mode: 0o700 });
        await writeJsonAtomic(paths.manifestPath, {
            schemaVersion: claudeRunArtifactSchemaVersion,
            providerKind: "claude",
            runId: input.runId,
            createdAt: now,
            updatedAt: now,
            providerInstanceId: input.providerInstanceId,
            workerId: input.workerId,
            configDir: input.configDir,
            ...(input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath }),
            ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
            ...(input.capacityAccountId === undefined
                ? {}
                : { capacityAccountId: input.capacityAccountId }),
        });
        await this.writeProgress({
            runId: input.runId,
            status: "running",
            ...(input.workerState === undefined ? {} : { workerState: input.workerState }),
            ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
            ...(input.controlSignalIds === undefined || input.controlSignalIds.length === 0
                ? {}
                : { controlSignalIds: input.controlSignalIds }),
        });
        await this.appendLog(input.runId, {
            event: "run.started",
            providerInstanceId: input.providerInstanceId,
            workerId: input.workerId,
            ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        });
    }
    startHeartbeat(input) {
        let stopped = false;
        const timer = setInterval(() => {
            if (stopped)
                return;
            void this.writeProgress({
                runId: input.runId,
                status: "running",
                ...input.snapshot(),
            }).catch(() => undefined);
        }, input.intervalMs);
        timer.unref?.();
        return {
            stop() {
                stopped = true;
                clearInterval(timer);
            },
        };
    }
    async completeRun(input) {
        this.terminalRunIds.add(input.runId);
        const result = {
            schemaVersion: claudeRunArtifactSchemaVersion,
            runId: input.runId,
            status: "completed",
            updatedAt: this.clock.now().toISOString(),
            ...(input.outputText === undefined
                ? {}
                : { outputTextPreview: preview(this.redactor.redact(input.outputText)) }),
            ...(input.telemetry === undefined ? {} : { telemetry: input.telemetry }),
            ...(input.warnings === undefined || input.warnings.length === 0
                ? {}
                : { warnings: input.warnings }),
        };
        await writeJsonAtomic(this.paths(input.runId).resultPath, result);
        await this.writeProgress({
            runId: input.runId,
            status: "completed",
            ...(input.workerState === undefined ? {} : { workerState: input.workerState }),
            ...(input.telemetry?.providerRunId === undefined
                ? {}
                : { providerRunId: input.telemetry.providerRunId }),
            ...(input.telemetry?.providerSessionId === undefined
                ? {}
                : { providerSessionId: input.telemetry.providerSessionId }),
            ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
            ...(input.warnings === undefined ? {} : { warningCount: input.warnings.length }),
        });
        await this.appendLog(input.runId, {
            event: "run.completed",
            ...(input.telemetry?.providerRunId === undefined
                ? {}
                : { providerRunId: input.telemetry.providerRunId }),
            ...(input.telemetry?.providerSessionId === undefined
                ? {}
                : { providerSessionId: input.telemetry.providerSessionId }),
        });
    }
    async failRun(input) {
        const status = input.status ?? "failed";
        this.terminalRunIds.add(input.runId);
        const result = {
            schemaVersion: claudeRunArtifactSchemaVersion,
            runId: input.runId,
            status,
            updatedAt: this.clock.now().toISOString(),
            ...(input.reason === undefined ? {} : { reason: this.redactor.redact(input.reason) }),
            ...(input.safeMessage === undefined
                ? {}
                : { safeMessage: this.redactor.redact(input.safeMessage) }),
            ...(input.failureDetails === undefined
                ? {}
                : { failureDetails: redactStringRecord(input.failureDetails, this.redactor) }),
            ...(input.telemetry === undefined ? {} : { telemetry: input.telemetry }),
            ...(input.warnings === undefined || input.warnings.length === 0
                ? {}
                : { warnings: input.warnings }),
        };
        await writeJsonAtomic(this.paths(input.runId).resultPath, result);
        await this.writeProgress({
            runId: input.runId,
            status,
            ...(input.workerState === undefined ? {} : { workerState: input.workerState }),
            ...(input.telemetry?.providerRunId === undefined
                ? {}
                : { providerRunId: input.telemetry.providerRunId }),
            ...(input.telemetry?.providerSessionId === undefined
                ? {}
                : { providerSessionId: input.telemetry.providerSessionId }),
            ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
            ...(input.warnings === undefined ? {} : { warningCount: input.warnings.length }),
        });
        await this.appendLog(input.runId, {
            event: `run.${status}`,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
            ...(input.safeMessage === undefined ? {} : { safeMessage: input.safeMessage }),
            ...(input.failureDetails === undefined
                ? {}
                : { failureDetails: redactStringRecord(input.failureDetails, this.redactor) }),
        });
    }
    async writeProgress(input) {
        if (input.status === "running" && this.terminalRunIds.has(input.runId)) {
            return;
        }
        await writeJsonAtomic(this.paths(input.runId).progressPath, {
            schemaVersion: claudeRunArtifactSchemaVersion,
            updatedAt: this.clock.now().toISOString(),
            pid: process.pid,
            ...input,
        });
    }
    async appendLog(runId, value) {
        const paths = this.paths(runId);
        await mkdir(paths.runDir, { recursive: true, mode: 0o700 });
        const line = this.redactor.redact(JSON.stringify({
            occurredAt: this.clock.now().toISOString(),
            ...value,
        }));
        await writeFile(paths.logPath, `${line}\n`, {
            encoding: "utf8",
            flag: "a",
            mode: 0o600,
        });
    }
    async readManifest(runId) {
        return parseManifest(await readJson(this.paths(runId).manifestPath));
    }
    async readManifestByDir(runDir) {
        return parseManifest(await readJson(join(runDir, "manifest.json")));
    }
    async readProgress(runId) {
        try {
            return parseProgress(await readJson(this.paths(runId).progressPath));
        }
        catch {
            return null;
        }
    }
    async readResult(runId) {
        try {
            return parseResult(await readJson(this.paths(runId).resultPath));
        }
        catch {
            return null;
        }
    }
    async logStatus(runId) {
        try {
            const item = await stat(this.paths(runId).logPath);
            return {
                exists: item.isFile(),
                ...(item.isFile() ? { updatedAt: item.mtime.toISOString() } : {}),
                ...(item.isFile() ? { byteLength: item.size } : {}),
            };
        }
        catch {
            return { exists: false };
        }
    }
    async tailLog(runId, lines) {
        const text = await readFile(this.paths(runId).logPath, "utf8");
        return text.split(/\r?\n/).slice(-lines).join("\n");
    }
}
async function readJson(path) {
    return JSON.parse(await readFile(path, "utf8"));
}
async function writeJsonAtomic(path, value) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tempPath = join(dirname(path), `${randomUUID()}.tmp`);
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
    await rename(tempPath, path);
}
function parseManifest(value) {
    if (!isRecord(value) || value.schemaVersion !== claudeRunArtifactSchemaVersion) {
        throw new Error("claude_run_manifest_invalid");
    }
    if (value.providerKind !== "claude" ||
        typeof value.runId !== "string" ||
        typeof value.createdAt !== "string" ||
        typeof value.updatedAt !== "string" ||
        typeof value.providerInstanceId !== "string" ||
        typeof value.workerId !== "string" ||
        typeof value.configDir !== "string") {
        throw new Error("claude_run_manifest_invalid");
    }
    return value;
}
function parseProgress(value) {
    if (!isRecord(value) || value.schemaVersion !== claudeRunArtifactSchemaVersion) {
        throw new Error("claude_run_progress_invalid");
    }
    if (typeof value.runId !== "string" ||
        !isArtifactStatus(value.status) ||
        typeof value.updatedAt !== "string" ||
        typeof value.pid !== "number") {
        throw new Error("claude_run_progress_invalid");
    }
    return value;
}
function parseResult(value) {
    if (!isRecord(value) || value.schemaVersion !== claudeRunArtifactSchemaVersion) {
        throw new Error("claude_run_result_invalid");
    }
    if (typeof value.runId !== "string" ||
        value.status === "running" ||
        !isArtifactStatus(value.status) ||
        typeof value.updatedAt !== "string") {
        throw new Error("claude_run_result_invalid");
    }
    return value;
}
function isArtifactStatus(value) {
    return value === "running" ||
        value === "completed" ||
        value === "failed" ||
        value === "blocked";
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function redactStringRecord(record, redactor) {
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [
        key,
        redactor.redact(value),
    ]));
}
function preview(value) {
    return value.length <= 4_000 ? value : `${value.slice(0, 4_000)}\n[truncated]`;
}
function hashText(value) {
    return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
const systemClock = {
    now() {
        return new Date();
    },
    monotonicMs() {
        return performance.now();
    },
};
//# sourceMappingURL=claude-run-artifacts.js.map