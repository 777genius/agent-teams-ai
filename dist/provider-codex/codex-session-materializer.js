import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAuthJsonFromArtifact } from "./codex-auth-json-codec.js";
import { cleanupCodexRuntimeTempRoot } from "./codex-cli-temp-cleanup.js";
export class CodexEphemeralSessionMaterializer {
    mode = "ephemeral";
    async materialize(input) {
        const authJson = codexAuthJsonFromArtifact(input.session);
        input.redactor.registerSecret(authJson, "codex-auth-json");
        const tempRoot = await mkdtemp(join(tmpdir(), "subscription-runtime-codex-"));
        const home = join(tempRoot, "home");
        const codexHome = join(tempRoot, "codex-home");
        await mkdir(home, { recursive: true, mode: 0o700 });
        await mkdir(codexHome, { recursive: true, mode: 0o700 });
        await writeCodexJsonHomeSnapshot({ codexHome, authJson });
        return {
            home,
            codexHome,
            sessionHash: sessionArtifactHash(input.session),
            env: {
                HOME: home,
                CODEX_HOME: codexHome,
            },
            release: once(async () => {
                try {
                    await cleanupCodexRuntimeTempRoot({
                        tempRoot,
                        tempCodexHome: codexHome,
                    });
                }
                catch {
                    await rm(tempRoot, { recursive: true, force: true });
                }
            }),
        };
    }
    async prewarm(input) {
        const materialized = await this.materialize(input);
        try {
            return {
                mode: this.mode,
                home: materialized.home,
                codexHome: materialized.codexHome,
                sessionHash: sessionArtifactHash(input.session),
                reusable: false,
                warmedAt: new Date(),
            };
        }
        finally {
            await materialized.release();
        }
    }
}
export class CodexWorkerCacheSessionMaterializer {
    options;
    mode = "worker-cache";
    cacheKeyHash;
    entry = null;
    tail = Promise.resolve();
    constructor(options) {
        this.options = options;
        if (!options.cacheKey.trim()) {
            throw new Error("codex_worker_cache_key_required");
        }
        this.cacheKeyHash = stableHash(options.cacheKey).slice(0, 32);
    }
    async materialize(input) {
        const releaseLock = await this.acquireExclusiveUse();
        let released = false;
        try {
            const entry = await this.ensureEntry(input);
            return {
                home: entry.home,
                codexHome: entry.codexHome,
                sessionHash: entry.sessionHash ?? sessionArtifactHash(input.session),
                env: {
                    HOME: entry.home,
                    CODEX_HOME: entry.codexHome,
                },
                release: once(async () => {
                    released = true;
                    releaseLock();
                }),
            };
        }
        catch (error) {
            if (!released)
                releaseLock();
            throw error;
        }
    }
    async prewarm(input) {
        const materialized = await this.materialize(input);
        try {
            return {
                mode: this.mode,
                home: materialized.home,
                codexHome: materialized.codexHome,
                sessionHash: sessionArtifactHash(input.session),
                reusable: true,
                warmedAt: new Date(),
            };
        }
        finally {
            await materialized.release();
        }
    }
    async dispose() {
        const releaseLock = await this.acquireExclusiveUse();
        try {
            if (!this.entry || this.options.preserveOnDispose)
                return;
            await rm(this.entry.cacheRoot, { recursive: true, force: true });
            this.entry = null;
        }
        finally {
            releaseLock();
        }
    }
    async ensureEntry(input) {
        const authJson = codexAuthJsonFromArtifact(input.session);
        input.redactor.registerSecret(authJson, "codex-auth-json");
        const sessionHash = sessionArtifactHash(input.session);
        const entry = this.entry ?? (await this.createEntry());
        if (!entry.initialized) {
            await mkdir(entry.home, { recursive: true, mode: 0o700 });
            await mkdir(entry.codexHome, { recursive: true, mode: 0o700 });
            await writeCodexJsonHomeSnapshot({
                codexHome: entry.codexHome,
                authJson,
            });
            entry.sessionHash = sessionHash;
            entry.initialized = true;
            return entry;
        }
        if (entry.sessionHash !== sessionHash) {
            await writeCodexAuthJson({
                codexHome: entry.codexHome,
                authJson,
            });
            entry.sessionHash = sessionHash;
        }
        return entry;
    }
    async createEntry() {
        const cacheRoot = this.options.rootDir
            ? join(this.options.rootDir, `codex-${this.cacheKeyHash}`)
            : await mkdtemp(join(tmpdir(), "subscription-runtime-codex-cache-"));
        const entry = {
            cacheRoot,
            home: join(cacheRoot, "home"),
            codexHome: join(cacheRoot, "codex-home"),
            sessionHash: null,
            initialized: false,
        };
        this.entry = entry;
        return entry;
    }
    async acquireExclusiveUse() {
        const previous = this.tail;
        let releaseNext;
        this.tail = new Promise((resolve) => {
            releaseNext = resolve;
        });
        await previous;
        return onceSync(releaseNext);
    }
}
export class CodexWorkerCacheSessionPoolMaterializer {
    options;
    mode = "worker-cache";
    slots;
    idleSlotIndexes;
    waiters = [];
    constructor(options) {
        this.options = options;
        if (!options.cacheKey.trim()) {
            throw new Error("codex_worker_cache_pool_key_required");
        }
        if (!Number.isInteger(options.slots) || options.slots < 1) {
            throw new Error("codex_worker_cache_pool_slots_invalid");
        }
        this.slots = Array.from({ length: options.slots }, (_, index) => {
            return new CodexWorkerCacheSessionMaterializer({
                cacheKey: `${options.cacheKey}:slot:${index + 1}`,
                ...(options.rootDir ? { rootDir: options.rootDir } : {}),
                ...(options.preserveOnDispose !== undefined
                    ? { preserveOnDispose: options.preserveOnDispose }
                    : {}),
            });
        });
        this.idleSlotIndexes = this.slots.map((_, index) => index);
    }
    async materialize(input) {
        const slotIndex = await this.acquireSlot();
        let returnedSlot = false;
        try {
            const materialized = await this.slots[slotIndex].materialize(input);
            return {
                ...materialized,
                release: once(async () => {
                    try {
                        await materialized.release();
                    }
                    finally {
                        returnedSlot = true;
                        this.releaseSlot(slotIndex);
                    }
                }),
            };
        }
        catch (error) {
            if (!returnedSlot)
                this.releaseSlot(slotIndex);
            throw error;
        }
    }
    async prewarm(input) {
        const materialized = await this.materialize(input);
        try {
            return {
                mode: this.mode,
                home: materialized.home,
                codexHome: materialized.codexHome,
                sessionHash: sessionArtifactHash(input.session),
                reusable: true,
                warmedAt: new Date(),
            };
        }
        finally {
            await materialized.release();
        }
    }
    async dispose() {
        await Promise.all(this.slots.map((slot) => slot.dispose()));
    }
    acquireSlot() {
        const slotIndex = this.idleSlotIndexes.shift();
        if (slotIndex !== undefined)
            return Promise.resolve(slotIndex);
        return new Promise((resolve) => {
            this.waiters.push(resolve);
        });
    }
    releaseSlot(slotIndex) {
        const waiter = this.waiters.shift();
        if (waiter) {
            waiter(slotIndex);
            return;
        }
        this.idleSlotIndexes.push(slotIndex);
    }
}
export async function writeCodexJsonHomeSnapshot(input) {
    const config = [
        'cli_auth_credentials_store = "file"',
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        'web_search = "disabled"',
        "disable_response_storage = true",
        'model_verbosity = "low"',
        "",
        "[features]",
        "apps = false",
        "hooks = false",
        "memories = false",
        "multi_agent = false",
        "shell_snapshot = false",
        "skill_mcp_dependency_install = false",
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
    await writeFileAtomic(join(input.codexHome, "config.toml"), config);
    await writeCodexAuthJson(input);
}
export async function writeCodexAuthJson(input) {
    await writeFileAtomic(join(input.codexHome, "auth.json"), input.authJson);
}
export function sessionArtifactHash(session) {
    return stableHash(new TextDecoder().decode(session.bytes));
}
function stableHash(value) {
    return createHash("sha256").update(value).digest("hex");
}
async function writeFileAtomic(path, value) {
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, value, { mode: 0o600 });
    await rename(tempPath, path);
}
function once(fn) {
    let called = false;
    return async () => {
        if (called)
            return undefined;
        called = true;
        return fn();
    };
}
function onceSync(fn) {
    let called = false;
    return () => {
        if (called)
            return;
        called = true;
        fn();
    };
}
//# sourceMappingURL=codex-session-materializer.js.map