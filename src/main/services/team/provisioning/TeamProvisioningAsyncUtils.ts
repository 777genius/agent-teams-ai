import * as fs from 'fs';

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ensure `cwd` already exists as a directory. Launch must never create a stale project path. */
export async function ensureCwdExists(cwd: string): Promise<void> {
  const normalizedCwd = cwd.trim();
  if (!normalizedCwd) {
    throw new Error('cwd must be a directory');
  }
  const canonicalCwd = await fs.promises.realpath(normalizedCwd);
  const stat = await fs.promises.stat(canonicalCwd);
  if (!stat.isDirectory()) {
    throw new Error('cwd must be a directory');
  }
}
