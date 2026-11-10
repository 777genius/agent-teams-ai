import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { access, readdir } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach } from 'vitest';

import type { TeamProvisioningHarness } from './index';

const harnesses: TeamProvisioningHarness[] = [];
const HOME_ENV_KEYS = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'] as const;
const ORIGINAL_HOME_ENV = Object.fromEntries(
  HOME_ENV_KEYS.map((key) => [key, process.env[key]])
) as Record<(typeof HOME_ENV_KEYS)[number], string | undefined>;

export const RESERVED_FILENAME_CHARS_WITHOUT_SEPARATORS = [
  ':',
  '<',
  '>',
  '"',
  '|',
  '?',
  '*',
] as const;

export async function track(
  harnessPromise: Promise<TeamProvisioningHarness>
): Promise<TeamProvisioningHarness> {
  const harness = await harnessPromise;
  harnesses.push(harness);
  return harness;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function listTempWorkspaceNames(prefix: string): Promise<string[]> {
  const entries = await readdir(os.tmpdir(), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort();
}

function restoreOriginalHomeEnv(): void {
  for (const key of HOME_ENV_KEYS) {
    const value = ORIGINAL_HOME_ENV[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

export function setAutoDetectedHomeForTest(label: string): string {
  const homePath = path.join(os.tmpdir(), `team-provisioning-harness-${label}-${process.pid}`);
  process.env.HOME = homePath;
  delete process.env.USERPROFILE;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
  return path.join(homePath, '.claude', 'teams');
}

export function charLabel(char: string): string {
  return char.charCodeAt(0).toString(16).padStart(2, '0');
}

afterEach(async () => {
  try {
    for (const harness of harnesses.splice(0).reverse()) {
      await harness.cleanup();
    }
  } finally {
    restoreOriginalHomeEnv();
    setClaudeBasePathOverride(null);
  }
});
