import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile, } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, win32 } from "node:path";
export class ClaudeLogicalThreadConflictError extends Error {
    threadId;
    expectedGeneration;
    actualGeneration;
    constructor(threadId, expectedGeneration, actualGeneration) {
        super("claude_logical_thread_generation_conflict");
        this.threadId = threadId;
        this.expectedGeneration = expectedGeneration;
        this.actualGeneration = actualGeneration;
        this.name = "ClaudeLogicalThreadConflictError";
    }
}
export class FileClaudeLogicalThreadStore {
    rootDir;
    threadsDir;
    locksDir;
    constructor(rootDir) {
        this.rootDir = rootDir;
        this.threadsDir = join(rootDir, "threads");
        this.locksDir = join(rootDir, "locks");
    }
    async read(threadId) {
        try {
            return parseThreadState(await readFile(this.threadPath(threadId), "utf8"));
        }
        catch (error) {
            if (isNodeError(error) && error.code === "ENOENT")
                return null;
            throw error;
        }
    }
    async compareAndSwap(input) {
        return this.withThreadLock(input.threadId, async () => {
            const current = await this.read(input.threadId);
            const actualGeneration = current?.generation ?? 0;
            if (actualGeneration !== input.expectedGeneration) {
                throw new ClaudeLogicalThreadConflictError(input.threadId, input.expectedGeneration, actualGeneration);
            }
            const next = {
                ...input.next,
                generation: actualGeneration + 1,
            };
            await mkdir(this.threadsDir, { recursive: true, mode: 0o700 });
            const path = this.threadPath(input.threadId);
            const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
            await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
                mode: 0o600,
            });
            await rename(tempPath, path);
            return next;
        });
    }
    async withThreadLock(threadId, action) {
        await mkdir(this.locksDir, { recursive: true, mode: 0o700 });
        const lockPath = join(this.locksDir, `${hashText(threadId)}.lock`);
        const deadline = Date.now() + 10_000;
        while (true) {
            try {
                await mkdir(lockPath, { mode: 0o700 });
                break;
            }
            catch (error) {
                if (!isNodeError(error) || error.code !== "EEXIST")
                    throw error;
                if (Date.now() >= deadline) {
                    throw new Error("claude_logical_thread_lock_timeout");
                }
                await delay(25);
            }
        }
        try {
            return await action();
        }
        finally {
            await rm(lockPath, { recursive: true, force: true });
        }
    }
    threadPath(threadId) {
        return join(this.threadsDir, `${hashText(threadId)}.json`);
    }
}
export class FileClaudeTranscriptBundleStore {
    rootDir;
    bundlesDir;
    constructor(rootDir) {
        this.rootDir = rootDir;
        this.bundlesDir = join(rootDir, "bundles");
    }
    async capture(input) {
        const sourceConfigDir = await realpath(input.sourceConfigDir);
        const transcriptPath = await findTranscriptPath(sourceConfigDir, input.sessionId);
        if (!transcriptPath) {
            throw new Error("claude_transcript_not_found");
        }
        const projectDir = dirname(transcriptPath);
        const files = await transcriptBundleFiles(projectDir, input.sessionId);
        const bundleId = `bundle-${hashText(`${input.cwd}:${input.sessionId}:${Date.now()}:${randomUUID()}`).slice(0, 24)}`;
        const bundleDir = this.bundleDir(bundleId);
        const filesDir = join(bundleDir, "files");
        await mkdir(filesDir, { recursive: true, mode: 0o700 });
        const relativeFiles = [];
        for (const filePath of files) {
            const relativePath = requireSafeRelativePath(relative(sourceConfigDir, filePath));
            relativeFiles.push(relativePath);
            const targetPath = join(filesDir, relativePath);
            await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
            await cp(filePath, targetPath, { force: true });
        }
        const bundle = {
            bundleId,
            cwd: await realpath(input.cwd),
            sessionId: input.sessionId,
            sourceConfigDir,
            files: relativeFiles.sort(),
            capturedAt: new Date().toISOString(),
        };
        await writeFile(join(bundleDir, "manifest.json"), `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
        return bundle;
    }
    async materialize(input) {
        const bundleDir = this.bundleDir(input.bundleId);
        const bundle = parseBundle(await readFile(join(bundleDir, "manifest.json"), "utf8"));
        const targetConfigDir = await ensureRealDirectory(input.targetConfigDir);
        const filesDir = join(bundleDir, "files");
        for (const file of bundle.files) {
            const relativePath = requireSafeRelativePath(file);
            const sourcePath = join(filesDir, relativePath);
            const sourceStats = await lstat(sourcePath);
            if (!sourceStats.isFile()) {
                throw new Error("claude_transcript_bundle_file_invalid");
            }
            const targetPath = join(targetConfigDir, relativePath);
            await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
            await cp(sourcePath, targetPath, { force: true });
        }
        return bundle;
    }
    bundleDir(bundleId) {
        return join(this.bundlesDir, requireSafeId(bundleId));
    }
}
async function findTranscriptPath(configDir, sessionId) {
    const projectsDir = join(configDir, "projects");
    try {
        return await findFile(projectsDir, `${sessionId}.jsonl`);
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT")
            return null;
        throw error;
    }
}
async function findFile(dir, fileName) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isFile() && entry.name === fileName)
            return path;
        if (entry.isDirectory()) {
            const found = await findFile(path, fileName);
            if (found)
                return found;
        }
    }
    return null;
}
async function transcriptBundleFiles(projectDir, sessionId) {
    const main = join(projectDir, `${sessionId}.jsonl`);
    const files = new Set([main]);
    const sessionSidecarDir = join(projectDir, sessionId);
    if (await pathExists(sessionSidecarDir)) {
        for (const file of await listFiles(sessionSidecarDir))
            files.add(file);
    }
    const subagentsDir = join(projectDir, "subagents");
    if (await pathExists(subagentsDir)) {
        for (const file of await listFiles(subagentsDir))
            files.add(file);
    }
    return [...files].sort();
}
async function listFiles(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isFile())
            files.push(path);
        if (entry.isDirectory())
            files.push(...(await listFiles(path)));
    }
    return files;
}
async function pathExists(path) {
    try {
        await stat(path);
        return true;
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT")
            return false;
        throw error;
    }
}
async function ensureRealDirectory(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    return realpath(path);
}
function parseThreadState(raw) {
    const value = JSON.parse(raw);
    if (!value.threadId || !Number.isInteger(value.generation)) {
        throw new Error("claude_logical_thread_state_invalid");
    }
    return value;
}
function parseBundle(raw) {
    const value = JSON.parse(raw);
    if (!value.bundleId || !value.sessionId || !Array.isArray(value.files)) {
        throw new Error("claude_transcript_bundle_invalid");
    }
    return value;
}
function requireSafeId(value) {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
        throw new Error("claude_safe_id_required");
    }
    return value;
}
function requireSafeRelativePath(value) {
    const normalizedInput = value.replace(/\\/g, "/");
    const normalizedPath = posix.normalize(normalizedInput);
    if (value.length === 0 ||
        value.includes("\0") ||
        isAbsolute(value) ||
        win32.isAbsolute(value) ||
        /^[A-Za-z]:/u.test(value) ||
        normalizedPath === "." ||
        normalizedPath === ".." ||
        normalizedPath.startsWith("../") ||
        normalizedInput.split("/").includes("..")) {
        throw new Error("claude_safe_relative_path_required");
    }
    return normalizedPath;
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
function hashText(value) {
    return createHash("sha256").update(value).digest("hex");
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=thread-handoff.js.map