import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { platform } from "node:os";
import { resolve, sep } from "node:path";

const FIND_CANDIDATES = Object.freeze(["/usr/bin/find", "/bin/find"] as const);

export const NATIVE_DEPENDENCY_TRAVERSAL_POLICY = Object.freeze({
  supportedPlatform: "linux",
  requiredFindVersionMarker: "GNU findutils",
  executableCandidates: FIND_CANDIDATES,
  maxOutputBytes: 64 * 1024 * 1024,
  scanTimeoutMs: 60_000,
  probeTimeoutMs: 2_000,
});

export type NativeDependencyTraversalLimits = {
  readonly maxDependencyEntries: number;
};

export type NativeDependencyTraversalRuntimePolicy = {
  readonly maxOutputBytes: number;
  readonly scanTimeoutMs: number;
};

let nativeFindExecutablePromise: Promise<string | null> | undefined;

export async function discoverDependencyLinksNative(input: {
  readonly dependencyRoot: string;
  readonly limits: NativeDependencyTraversalLimits;
}): Promise<readonly string[] | null> {
  const executablePath = await resolveNativeFindExecutable();
  if (!executablePath) return null;
  return discoverDependencyLinksWithNativeFind({
    ...input,
    executablePath,
  });
}

export async function discoverNativeAddonFilesNative(input: {
  readonly dependencyRoot: string;
  readonly limits: NativeDependencyTraversalLimits;
}): Promise<readonly string[] | null> {
  const executablePath = await resolveNativeFindExecutable();
  if (!executablePath) return null;
  return discoverNativeAddonFilesWithNativeFind({
    ...input,
    executablePath,
  });
}

export async function discoverNativeAddonFilesWithNativeFind(input: {
  readonly dependencyRoot: string;
  readonly limits: NativeDependencyTraversalLimits;
  readonly executablePath: string;
  readonly runtimePolicy?: NativeDependencyTraversalRuntimePolicy;
}): Promise<readonly string[] | null> {
  const dependencyRoot = resolve(input.dependencyRoot);
  const addonFiles: string[] = [];
  const result = await runNativeFind({
    executablePath: input.executablePath,
    rootPath: dependencyRoot,
    args: [
      "-P",
      dependencyRoot,
      "-mindepth",
      "1",
      "(",
      "-type",
      "f",
      "-name",
      "*.node",
      "-printf",
      "n%p\\0",
      ")",
      "-o",
      "-printf",
      "x\\0",
    ],
    maxRecords: input.limits.maxDependencyEntries,
    maxOutputBytes:
      input.runtimePolicy?.maxOutputBytes ??
      NATIVE_DEPENDENCY_TRAVERSAL_POLICY.maxOutputBytes,
    timeoutMs:
      input.runtimePolicy?.scanTimeoutMs ??
      NATIVE_DEPENDENCY_TRAVERSAL_POLICY.scanTimeoutMs,
    limitError: "dependency_environment_tree_scan_limit_exceeded",
    onRecord: (bytes) => {
      if (bytes.byteLength === 1 && bytes[0] === 0x78) return;
      if (bytes.byteLength <= 1 || bytes[0] !== 0x6e) {
        throw new Error("dependency_environment_native_scan_invalid");
      }
      const path = bytes.subarray(1).toString("utf8");
      if (!path) throw new Error("dependency_environment_native_scan_invalid");
      assertPathWithin(dependencyRoot, path);
      addonFiles.push(path);
    },
  });
  if (result === null) return null;
  return addonFiles;
}

export async function discoverDependencyLinksWithNativeFind(input: {
  readonly dependencyRoot: string;
  readonly limits: NativeDependencyTraversalLimits;
  readonly executablePath: string;
  readonly runtimePolicy?: NativeDependencyTraversalRuntimePolicy;
}): Promise<readonly string[] | null> {
  const dependencyRoot = resolve(input.dependencyRoot);
  const links: string[] = [];
  const result = await runNativeFind({
    executablePath: input.executablePath,
    rootPath: dependencyRoot,
    args: [
      "-P",
      dependencyRoot,
      "-mindepth",
      "1",
      "(",
      "-type",
      "l",
      "-printf",
      "l%p\\0",
      ")",
      "-o",
      "-printf",
      "x\\0",
    ],
    maxRecords: input.limits.maxDependencyEntries,
    maxOutputBytes:
      input.runtimePolicy?.maxOutputBytes ??
      NATIVE_DEPENDENCY_TRAVERSAL_POLICY.maxOutputBytes,
    timeoutMs:
      input.runtimePolicy?.scanTimeoutMs ??
      NATIVE_DEPENDENCY_TRAVERSAL_POLICY.scanTimeoutMs,
    limitError: "dependency_environment_tree_scan_limit_exceeded",
    onRecord: (bytes) => {
      if (bytes.byteLength === 1 && bytes[0] === 0x78) {
        return;
      }
      if (bytes.byteLength <= 1 || bytes[0] !== 0x6c) {
        throw new Error("dependency_environment_native_scan_invalid");
      }
      const path = bytes.subarray(1).toString("utf8");
      if (!path) throw new Error("dependency_environment_native_scan_invalid");
      assertPathWithin(dependencyRoot, path);
      links.push(path);
    },
  });
  if (result === null) return null;
  return links;
}

async function resolveNativeFindExecutable(): Promise<string | null> {
  nativeFindExecutablePromise ??= findNativeExecutable();
  return nativeFindExecutablePromise;
}

async function findNativeExecutable(): Promise<string | null> {
  if (platform() !== NATIVE_DEPENDENCY_TRAVERSAL_POLICY.supportedPlatform) {
    return null;
  }
  const { executableCandidates } = NATIVE_DEPENDENCY_TRAVERSAL_POLICY;
  for (const candidate of executableCandidates) {
    try {
      await access(candidate, constants.X_OK);
      if (await supportsGnuFind(candidate)) return candidate;
    } catch (error) {
      if (!isMissingOrDenied(error)) throw error;
    }
  }
  return null;
}

async function supportsGnuFind(executablePath: string): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executablePath, ["--version"], {
        env: {
          PATH: "/usr/bin:/bin",
          LC_ALL: "C",
        },
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolvePromise(false);
      return;
    }
    const stdout = child.stdout;
    if (!stdout) {
      child.kill("SIGKILL");
      resolvePromise(false);
      return;
    }

    let settled = false;
    let output = "";
    const finish = (supported: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise(supported);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, NATIVE_DEPENDENCY_TRAVERSAL_POLICY.probeTimeoutMs);
    timeout.unref();
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 4_096) {
        child.kill("SIGKILL");
        finish(false);
      }
    });
    stdout.on("error", () => finish(false));
    child.on("error", () => finish(false));
    child.on("close", (code, signal) => {
      finish(
        code === 0 &&
          signal === null &&
          output.includes(
            NATIVE_DEPENDENCY_TRAVERSAL_POLICY.requiredFindVersionMarker,
          ),
      );
    });
  });
}

async function runNativeFind(input: {
  readonly executablePath: string;
  readonly rootPath: string;
  readonly args: readonly string[];
  readonly maxRecords: number;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
  readonly limitError: string;
  readonly onRecord: (bytes: Buffer<ArrayBufferLike>) => void;
}): Promise<true | null> {
  return await new Promise<true | null>((resolvePromise, rejectPromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.executablePath, [...input.args], {
        cwd: input.rootPath,
        env: {
          PATH: "/usr/bin:/bin",
          LC_ALL: "C",
        },
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error) {
      if (isMissingError(error)) {
        resolvePromise(null);
        return;
      }
      rejectPromise(error);
      return;
    }
    const stdout = child.stdout;
    if (!stdout) {
      child.kill("SIGKILL");
      rejectPromise(
        new Error("dependency_environment_native_scan_unavailable"),
      );
      return;
    }

    let settled = false;
    let recordCount = 0;
    let outputBytes = 0;
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const finish = (result: true | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise(result);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGKILL");
      rejectPromise(error);
    };
    const acceptRecord = (bytes: Buffer<ArrayBufferLike>): void => {
      recordCount += 1;
      if (recordCount > input.maxRecords) {
        throw new Error(input.limitError);
      }
      input.onRecord(bytes);
    };
    const timeout = setTimeout(() => {
      fail(new Error("dependency_environment_native_scan_timeout"));
    }, input.timeoutMs);
    timeout.unref();

    stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      try {
        outputBytes += chunk.byteLength;
        if (outputBytes > input.maxOutputBytes) {
          throw new Error(input.limitError);
        }
        const bytes =
          pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
        let start = 0;
        for (;;) {
          const separator = bytes.indexOf(0, start);
          if (separator < 0) break;
          acceptRecord(bytes.subarray(start, separator));
          start = separator + 1;
        }
        pending = bytes.subarray(start);
      } catch (error) {
        fail(error);
      }
    });
    stdout.on("error", fail);
    child.on("error", (error) => {
      if (isMissingError(error)) finish(null);
      else fail(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0 || signal !== null || pending.byteLength !== 0) {
        fail(new Error("dependency_environment_native_scan_failed"));
        return;
      }
      finish(true);
    });
  });
}

function assertPathWithin(root: string, candidate: string): void {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  if (
    normalizedCandidate !== normalizedRoot &&
    !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  ) {
    throw new Error("dependency_environment_native_scan_escape");
  }
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isMissingOrDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EACCES";
}
