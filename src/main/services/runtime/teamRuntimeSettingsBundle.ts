import { atomicWriteAsync } from '@main/utils/atomicWrite';
import fs from 'fs';
import path from 'path';

import { mergeJsonSettingsObjects, parseJsonSettingsObject } from './cliSettingsArgs';

import type { AnthropicTeamApiKeyHelperMaterial } from './anthropicTeamApiKeyHelper';
import type { TeamProviderId } from '@shared/types';

export type TeamRuntimeSettingsJson = Record<string, unknown>;

export interface TeamRuntimeSettingsBundle {
  settingsPath: string;
  settingsObject: TeamRuntimeSettingsJson;
  args: string[];
}

export interface SplitSettingsJsonArgsResult {
  settingsFragments: TeamRuntimeSettingsJson[];
  passthroughArgs: string[];
}

export function splitSettingsJsonArgs(args: string[]): SplitSettingsJsonArgsResult {
  const settingsFragments: TeamRuntimeSettingsJson[] = [];
  const passthroughArgs: string[] = [];

  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--settings') {
      const value = args[index + 1];
      if (typeof value === 'string') {
        const parsed = parseJsonSettingsObject(value);
        if (parsed) {
          settingsFragments.push(parsed);
          index += 2;
          continue;
        }
        passthroughArgs.push(arg, value);
        index += 2;
        continue;
      }
    }

    const settingsPrefix = '--settings=';
    if (arg.startsWith(settingsPrefix)) {
      const value = arg.slice(settingsPrefix.length);
      const parsed = parseJsonSettingsObject(value);
      if (parsed) {
        settingsFragments.push(parsed);
        index += 1;
        continue;
      }
    }

    passthroughArgs.push(arg);
    index += 1;
  }

  return { settingsFragments, passthroughArgs };
}

function sanitizeProviderId(providerId: TeamProviderId): string {
  return providerId.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'provider';
}

function stripCompetingAnthropicEnv(settings: TeamRuntimeSettingsJson): TeamRuntimeSettingsJson {
  const env = settings.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return settings;
  }
  const nextEnv = { ...(env as Record<string, unknown>) };
  delete nextEnv.ANTHROPIC_API_KEY;
  delete nextEnv.ANTHROPIC_AUTH_TOKEN;
  delete nextEnv.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR;
  delete nextEnv.CLAUDE_CODE_OAUTH_TOKEN;
  delete nextEnv.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
  return { ...settings, env: nextEnv };
}

async function writeSettingsFile(
  filePath: string,
  settings: TeamRuntimeSettingsJson
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await fs.promises.chmod(dir, 0o700).catch(() => undefined);
  }
  const existing = await fs.promises.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  if (existing?.isSymbolicLink()) {
    throw new Error(`Refusing to replace symlinked team runtime settings file: ${filePath}`);
  }
  await atomicWriteAsync(filePath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  const written = await fs.promises.lstat(filePath);
  if (!written.isFile() || written.isSymbolicLink()) {
    throw new Error(`Unsafe team runtime settings file: ${filePath}`);
  }
  if (process.platform !== 'win32') {
    await fs.promises.chmod(filePath, 0o600).catch(() => undefined);
  }
}

export async function materializeTeamRuntimeSettingsBundle(input: {
  teamName: string;
  providerId: TeamProviderId;
  baseSettings?: (TeamRuntimeSettingsJson | null | undefined)[];
  anthropicHelper?: AnthropicTeamApiKeyHelperMaterial | null;
  settingsDirectory?: string | null;
}): Promise<TeamRuntimeSettingsBundle | null> {
  const fragments = [...(input.baseSettings ?? [])].filter(
    (fragment): fragment is TeamRuntimeSettingsJson =>
      !!fragment && typeof fragment === 'object' && !Array.isArray(fragment)
  );
  if (input.anthropicHelper) {
    fragments.push(input.anthropicHelper.settingsObject);
  }
  if (fragments.length === 0) {
    return null;
  }

  const settingsObject = stripCompetingAnthropicEnv(
    fragments.reduce<TeamRuntimeSettingsJson>(
      (merged, fragment) => mergeJsonSettingsObjects(merged, fragment),
      {}
    )
  );
  if (Object.keys(settingsObject).length === 0) {
    return null;
  }

  const baseDirectory = input.anthropicHelper?.directory ?? input.settingsDirectory;
  if (!baseDirectory) {
    return null;
  }
  const settingsPath = path.join(
    baseDirectory,
    `runtime-settings-${sanitizeProviderId(input.providerId)}.json`
  );
  await writeSettingsFile(settingsPath, settingsObject);
  return {
    settingsPath,
    settingsObject,
    args: ['--settings', settingsPath],
  };
}
