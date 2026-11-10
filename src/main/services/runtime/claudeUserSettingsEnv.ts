import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { getClaudeBasePath } from '@main/utils/pathDecoder';

type JsonObject = Record<string, unknown>;

const FIRST_PARTY_ANTHROPIC_HOSTS = new Set(['api.anthropic.com', 'api-staging.anthropic.com']);
const CLAUDE_USER_SETTINGS_FILENAMES = ['settings.json', 'claude.json'] as const;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getSettingsEnvString(env: JsonObject, key: string): string | null {
  const value = env[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isAnthropicCompatibleBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      !FIRST_PARTY_ANTHROPIC_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
}

export interface ClaudeUserAnthropicSettingsAuthEnv {
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
}

async function readSettingsEnvFile(
  settingsPath: string
): Promise<{ env: JsonObject | null; missing: boolean }> {
  let raw: string;
  try {
    raw = await readFile(settingsPath, 'utf8');
  } catch (error) {
    return {
      env: null,
      missing: (error as NodeJS.ErrnoException).code === 'ENOENT',
    };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isJsonObject(parsed) || !isJsonObject(parsed.env)) {
      return { env: null, missing: false };
    }
    return { env: parsed.env, missing: false };
  } catch {
    return { env: null, missing: false };
  }
}

export async function readClaudeUserSettingsEnv(settingsPath?: string): Promise<JsonObject | null> {
  if (settingsPath) {
    return (await readSettingsEnvFile(settingsPath)).env;
  }

  const claudeBasePath = getClaudeBasePath();
  for (const filename of CLAUDE_USER_SETTINGS_FILENAMES) {
    const result = await readSettingsEnvFile(path.join(claudeBasePath, filename));
    if (result.env || !result.missing) {
      return result.env;
    }
  }

  return null;
}

function getValidAnthropicBaseUrl(env: JsonObject): string | null {
  const baseUrl = getSettingsEnvString(env, 'ANTHROPIC_BASE_URL');
  if (!baseUrl) {
    return null;
  }

  try {
    const url = new URL(baseUrl);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? baseUrl
      : null;
  } catch {
    return null;
  }
}

export async function readClaudeUserAnthropicSettingsAuthEnv(
  settingsPath?: string
): Promise<ClaudeUserAnthropicSettingsAuthEnv | null> {
  const env = await readClaudeUserSettingsEnv(settingsPath);
  if (!env) {
    return null;
  }

  const apiKey = getSettingsEnvString(env, 'ANTHROPIC_API_KEY');
  const baseUrl = getValidAnthropicBaseUrl(env);
  const authToken = getSettingsEnvString(env, 'ANTHROPIC_AUTH_TOKEN');

  if (apiKey) {
    return {
      ...(baseUrl ? { ANTHROPIC_BASE_URL: baseUrl } : {}),
      ANTHROPIC_API_KEY: apiKey,
    };
  }

  if (!baseUrl || !authToken || !isAnthropicCompatibleBaseUrl(baseUrl)) {
    return null;
  }

  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: authToken,
  };
}
