import { getAppDataPath } from '@main/utils/pathDecoder';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const SECRET_FILE_NAME = 'launch-continuation-hmac-v1.key';
const SECRET_PATTERN = /^v1:([a-f0-9]{64})\n$/;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export function getLaunchContinuationSecretPath(): string {
  return path.join(getAppDataPath(), 'identity', SECRET_FILE_NAME);
}

async function readPrivateSecret(secretPath: string): Promise<string | null> {
  let handle: fs.promises.FileHandle;
  try {
    const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
    handle = await fs.promises.open(secretPath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 128) {
      throw new Error('Stable launch continuation secret is not a bounded regular file');
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error('Stable launch continuation secret is not private');
    }
    const raw = await handle.readFile('utf8');
    const match = SECRET_PATTERN.exec(raw);
    if (!match) throw new Error('Stable launch continuation secret is invalid');
    return `launch-continuation-hmac-v1:${match[1]}`;
  } finally {
    await handle.close();
  }
}

export async function ensureLaunchContinuationSecret(options?: {
  allowCreate?: boolean;
  secretPath?: string;
}): Promise<string> {
  const secretPath = path.resolve(options?.secretPath ?? getLaunchContinuationSecretPath());
  const existing = await readPrivateSecret(secretPath);
  if (existing) return existing;
  if (options?.allowCreate === false) {
    throw new Error('Stable launch continuation secret is unavailable for persisted evidence');
  }

  const directory = path.dirname(secretPath);
  await fs.promises.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const directoryStat = await fs.promises.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('Stable launch continuation secret directory is unsafe');
  }
  if (process.platform !== 'win32') {
    await fs.promises.chmod(directory, PRIVATE_DIRECTORY_MODE);
  }
  const raw = `v1:${randomBytes(32).toString('hex')}\n`;
  try {
    const handle = await fs.promises.open(secretPath, 'wx', PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(raw, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const created = await readPrivateSecret(secretPath);
  if (!created) throw new Error('Stable launch continuation secret could not be created');
  return created;
}
