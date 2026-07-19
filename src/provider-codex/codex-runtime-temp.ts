import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { codexAgentTempRootFromEnv } from "./app-server/domain/app-server-types";

export async function ensureCodexAgentTempRoot(input: {
  readonly sourceEnv?: Readonly<Record<string, string | undefined>> | undefined;
}): Promise<string | null> {
  const sourceEnv = input.sourceEnv ?? process.env;
  const agentTempRoot = codexAgentTempRootFromEnv(sourceEnv);
  const jobRoot = sourceEnv.SUBSCRIPTION_RUNTIME_JOB_ROOT?.trim();
  const runtimeTempRoot = sourceEnv.SUBSCRIPTION_RUNTIME_TMPDIR?.trim();
  if (!agentTempRoot || !jobRoot || !runtimeTempRoot) return null;
  const realJobRoot = await realpath(jobRoot);
  await mkdir(runtimeTempRoot, { recursive: true, mode: 0o700 });
  const runtimeTempStat = await lstat(runtimeTempRoot);
  if (runtimeTempStat.isSymbolicLink()) {
    throw new Error("codex_agent_temp_runtime_root_symlink");
  }
  if ((await realpath(runtimeTempRoot)) !== join(realJobRoot, "tmp")) {
    throw new Error("codex_agent_temp_runtime_root_mismatch");
  }
  await mkdir(agentTempRoot, { recursive: true, mode: 0o700 });
  const agentTempStat = await lstat(agentTempRoot);
  if (agentTempStat.isSymbolicLink()) {
    throw new Error("codex_agent_temp_root_symlink");
  }
  if ((await realpath(agentTempRoot)) !== join(realJobRoot, "tmp", "agent")) {
    throw new Error("codex_agent_temp_root_mismatch");
  }
  await chmod(agentTempRoot, 0o700);
  return agentTempRoot;
}

export async function removeCodexAgentTempRoot(
  agentTempRoot: string | null,
): Promise<string | null> {
  if (!agentTempRoot) return null;
  try {
    await chmod(agentTempRoot, 0o700);
    await rm(agentTempRoot, { recursive: true, force: true });
    return null;
  } catch {
    return "codex_agent_temp_cleanup_failed";
  }
}

export async function createCodexRuntimeTempRoot(input: {
  readonly prefix: string;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>> | undefined;
}): Promise<string> {
  const env = input.sourceEnv ?? process.env;
  const candidates = uniqueNonEmpty([
    env.SUBSCRIPTION_RUNTIME_TMPDIR,
    env.TMPDIR,
    env.SUBSCRIPTION_RUNTIME_JOB_ROOT
      ? join(env.SUBSCRIPTION_RUNTIME_JOB_ROOT, "tmp")
      : undefined,
    process.env.SUBSCRIPTION_RUNTIME_TMPDIR,
    process.env.TMPDIR,
    process.env.SUBSCRIPTION_RUNTIME_JOB_ROOT
      ? join(process.env.SUBSCRIPTION_RUNTIME_JOB_ROOT, "tmp")
      : undefined,
    tmpdir(),
  ]);

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      await mkdir(candidate, { recursive: true, mode: 0o700 });
      return await mkdtemp(join(candidate, input.prefix));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("codex_runtime_temp_root_unavailable");
}

export async function createTrustedCodexRuntimeTempRoot(input: {
  readonly prefix: string;
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
}): Promise<string> {
  const jobRoot = input.sourceEnv.SUBSCRIPTION_RUNTIME_JOB_ROOT?.trim();
  const runtimeTempRoot = input.sourceEnv.SUBSCRIPTION_RUNTIME_TMPDIR?.trim();
  if (!jobRoot || !runtimeTempRoot) {
    throw new Error("codex_refresh_bootstrap_temp_boundary_missing");
  }
  if (resolve(runtimeTempRoot) !== resolve(jobRoot, "tmp")) {
    throw new Error("codex_refresh_bootstrap_temp_root_mismatch");
  }
  await mkdir(jobRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(jobRoot)).isSymbolicLink()) {
    throw new Error("codex_refresh_bootstrap_job_root_symlink");
  }
  const realJobRoot = await realpath(jobRoot);
  await mkdir(runtimeTempRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(runtimeTempRoot)).isSymbolicLink()) {
    throw new Error("codex_refresh_bootstrap_temp_root_symlink");
  }
  const realRuntimeTempRoot = await realpath(runtimeTempRoot);
  if (realRuntimeTempRoot !== join(realJobRoot, "tmp")) {
    throw new Error("codex_refresh_bootstrap_temp_root_mismatch");
  }
  const tempRoot = await mkdtemp(join(runtimeTempRoot, input.prefix));
  try {
    if ((await lstat(tempRoot)).isSymbolicLink()) {
      throw new Error("codex_refresh_bootstrap_temp_symlink");
    }
    const realTempRoot = await realpath(tempRoot);
    const relativeTempRoot = relative(realRuntimeTempRoot, realTempRoot);
    if (
      !relativeTempRoot ||
      relativeTempRoot === ".." ||
      relativeTempRoot.startsWith(`..${sep}`) ||
      isAbsolute(relativeTempRoot)
    ) {
      throw new Error("codex_refresh_bootstrap_temp_outside_job_root");
    }
    return tempRoot;
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function uniqueNonEmpty(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
