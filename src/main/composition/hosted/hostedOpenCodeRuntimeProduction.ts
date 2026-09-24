import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

import { parseHostedOpenCodeRuntimeLock } from '@features/hosted-opencode-runtime';
import { applyOpenCodeRuntimeBinaryEnv } from '@main/services/runtime/openCodeRuntimeBinaryEnv';

import {
  createHostedOpenCodeRuntimeComposition,
  type HostedOpenCodeRuntimeComposition,
} from './hostedOpenCodeRuntimeComposition';

export const HOSTED_OPENCODE_RUNTIME_MODE = 'official-v1.18.32';
const MAX_LOCK_BYTES = 32 * 1024;
const REVIEWED_LOCK_SHA256 = '6814058d423cfa04fb6f139340d00b9842fd6531aae61e85452400d2206f0eea';
const RUNTIME_DIRECTORY = 'hosted-opencode-runtime';

type CompositionFactory = typeof createHostedOpenCodeRuntimeComposition;

export interface HostedOpenCodeRuntimeProductionInput {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly authDataDirectory: string;
  readonly lockFilePath: string;
  readonly createComposition?: CompositionFactory;
}

export interface HostedOpenCodeRuntimeStartupInput extends HostedOpenCodeRuntimeProductionInput {
  readonly runtimeEnvironment: NodeJS.ProcessEnv;
}

/** The image lock is an immutable input, never a user-supplied URL or version. */
export async function readHostedOpenCodeProductionLock(lockFilePath: string): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(lockFilePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error('hosted_opencode_lock_file_unavailable');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_LOCK_BYTES) {
      throw new Error('hosted_opencode_lock_file_invalid');
    }
    const buffer = Buffer.alloc(MAX_LOCK_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_LOCK_BYTES) throw new Error('hosted_opencode_lock_file_invalid');
    if (
      createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex') !==
      REVIEWED_LOCK_SHA256
    ) {
      throw new Error('hosted_opencode_lock_file_digest_mismatch');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(buffer.toString('utf8', 0, bytesRead));
    } catch {
      throw new Error('hosted_opencode_lock_file_invalid');
    }
    const lock = parseHostedOpenCodeRuntimeLock(raw);
    if (lock.version !== '1.18.32') throw new Error('hosted_opencode_lock_version_mismatch');
    return lock;
  } finally {
    await handle.close();
  }
}

async function admitRuntimeRoot(authDataDirectory: string): Promise<string> {
  if (
    !path.isAbsolute(authDataDirectory) ||
    path.resolve(authDataDirectory) !== authDataDirectory
  ) {
    throw new Error('hosted_opencode_runtime_root_invalid');
  }
  const parent = await fs.lstat(authDataDirectory);
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error('hosted_opencode_runtime_root_invalid');
  }
  const runtimeRoot = path.join(authDataDirectory, RUNTIME_DIRECTORY);
  await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(runtimeRoot);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    (process.getuid !== undefined && stat.uid !== process.getuid())
  ) {
    throw new Error('hosted_opencode_runtime_root_invalid');
  }
  return runtimeRoot;
}

/** Opt-in Product runtime preparation. No agent or terminal is started here. */
export async function prepareHostedOpenCodeRuntimeFromEnvironment(
  input: HostedOpenCodeRuntimeProductionInput
): Promise<string | null> {
  const mode = input.environment.HOSTED_OPENCODE_RUNTIME_MODE;
  if (mode === undefined || mode === '') return null;
  if (mode !== HOSTED_OPENCODE_RUNTIME_MODE) {
    throw new Error('hosted_opencode_runtime_mode_invalid');
  }
  const runtimeRoot = await admitRuntimeRoot(input.authDataDirectory);
  const composition: HostedOpenCodeRuntimeComposition = (
    input.createComposition ?? createHostedOpenCodeRuntimeComposition
  )({
    runtimeRoot,
    loadLock: () => readHostedOpenCodeProductionLock(input.lockFilePath),
  });
  let binaryPath: string;
  try {
    binaryPath = await composition.resolveBinary();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'hosted_opencode_current_manifest_missing') {
      throw error;
    }
    await composition.install();
    binaryPath = await composition.resolveBinary();
  }
  return binaryPath;
}

/** Called by standalone startup before constructing provider-facing services. */
export async function configureHostedOpenCodeRuntimeAtStartup(
  input: HostedOpenCodeRuntimeStartupInput
): Promise<boolean> {
  const binaryPath = await prepareHostedOpenCodeRuntimeFromEnvironment(input);
  if (binaryPath === null) return false;
  input.runtimeEnvironment.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = binaryPath;
  input.runtimeEnvironment.OPENCODE_BIN_PATH = binaryPath;
  applyOpenCodeRuntimeBinaryEnv(input.runtimeEnvironment, binaryPath);
  return true;
}
