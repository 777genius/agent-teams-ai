import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
export class TempWorkspace {
    prefix;
    workspaceId = "temp-workspace";
    capabilities = {
        workspaceId: this.workspaceId,
        supportsTempDir: true,
        supportsExistingCheckout: true,
        supportsContainer: false,
    };
    constructor(prefix = "subscription-runtime-worker-") {
        this.prefix = prefix;
    }
    async create() {
        const path = await mkdtemp(join(tmpdir(), this.prefix));
        return {
            path,
            dispose: () => rm(path, { recursive: true, force: true }),
        };
    }
}
export class StableWorkerWorkspace {
    rootDir;
    options;
    workspaceId = "stable-worker-workspace";
    capabilities = {
        workspaceId: this.workspaceId,
        supportsTempDir: true,
        supportsExistingCheckout: true,
        supportsContainer: false,
    };
    constructor(rootDir, options = {}) {
        this.rootDir = rootDir;
        this.options = options;
    }
    async create() {
        await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
        return {
            path: this.rootDir,
        };
    }
    async dispose() {
        if (this.options.allowedRootDir) {
            assertDeleteWithinAllowedRoot(this.rootDir, this.options.allowedRootDir);
        }
        await rm(this.rootDir, { recursive: true, force: true });
    }
}
export class BorrowedRunTaskWorkspace {
    runTaskPath;
    fallbackWorkspace;
    workspaceId = "borrowed-run-task-workspace";
    capabilities;
    constructor(runTaskPath, fallbackWorkspace) {
        this.runTaskPath = runTaskPath;
        this.fallbackWorkspace = fallbackWorkspace;
        this.capabilities = {
            workspaceId: this.workspaceId,
            supportsTempDir: fallbackWorkspace.capabilities.supportsTempDir,
            supportsExistingCheckout: true,
            supportsContainer: fallbackWorkspace.capabilities.supportsContainer,
        };
    }
    async create(input) {
        if (input.purpose === "run-task") {
            return { path: this.runTaskPath };
        }
        return this.fallbackWorkspace.create(input);
    }
}
function assertDeleteWithinAllowedRoot(path, allowedRootDir) {
    const target = resolve(path);
    const allowedRoot = resolve(allowedRootDir);
    const relativePath = relative(allowedRoot, target);
    if (relativePath === "" ||
        relativePath.startsWith("..") ||
        isAbsolute(relativePath)) {
        throw new Error("stable_worker_workspace_delete_outside_allowed_root");
    }
}
//# sourceMappingURL=temp-workspace.js.map