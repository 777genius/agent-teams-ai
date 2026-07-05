import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
