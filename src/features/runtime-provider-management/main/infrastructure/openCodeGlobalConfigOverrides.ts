import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { getCachedShellEnv } from '@main/utils/shellEnv';
import { parse, type ParseError } from 'jsonc-parser';

import { LocalProviderOperationError } from './OpenCodeLocalProviderSupport';

export const OPENCODE_GLOBAL_CONFIG_FILENAMES = ['opencode.json', 'opencode.jsonc'] as const;
export const OPENCODE_PROJECT_CONFIG_CANDIDATES = [
  'opencode.json',
  'opencode.jsonc',
  '.opencode/opencode.json',
  '.opencode/opencode.jsonc',
] as const;

export interface OpenCodeInlineConfigWriteContext {
  providerId: string;
  setAsDefault?: boolean;
  setAsSmallModel?: boolean;
}

export function createOpenCodeGlobalConfigEnvironmentResolver(
  configuredEnvironment: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv) | undefined
): () => NodeJS.ProcessEnv {
  if (typeof configuredEnvironment === 'function') {
    return configuredEnvironment;
  }
  return () => configuredEnvironment ?? { ...process.env, ...(getCachedShellEnv() ?? {}) };
}

export async function getOpenCodeGlobalConfigOverrideConflict(
  environment: NodeJS.ProcessEnv,
  homePath: string
): Promise<LocalProviderOperationError | null> {
  const canonicalConfigDirectory = path.resolve(homePath, '.config', 'opencode');
  const canonicalConfigPaths = new Set(
    OPENCODE_GLOBAL_CONFIG_FILENAMES.map((filename) =>
      path.join(canonicalConfigDirectory, filename)
    )
  );
  const configuredPath = readNonEmptyEnvironmentValue(environment, 'OPENCODE_CONFIG');
  if (configuredPath && !isAbsoluteEnvironmentConfigPath(configuredPath, homePath)) {
    return new LocalProviderOperationError(
      'config-conflict',
      'OpenCode is using a relative OPENCODE_CONFIG path. Agent Teams cannot safely resolve it from the desktop process; use an absolute path or update the active config manually.'
    );
  }
  if (
    configuredPath &&
    !canonicalConfigPaths.has(await resolveComparableConfigPath(configuredPath, homePath))
  ) {
    return new LocalProviderOperationError(
      'config-conflict',
      'OpenCode is using OPENCODE_CONFIG, so Agent Teams cannot safely update the canonical global config. Remove that override or update its active config manually.'
    );
  }

  const xdgConfigHome = readNonEmptyEnvironmentValue(environment, 'XDG_CONFIG_HOME');
  if (xdgConfigHome && !isAbsoluteEnvironmentConfigPath(xdgConfigHome, homePath)) {
    return new LocalProviderOperationError(
      'config-conflict',
      'OpenCode is using a relative XDG_CONFIG_HOME path. Agent Teams cannot safely resolve it from the desktop process; use an absolute path or update the active config manually.'
    );
  }
  if (
    xdgConfigHome &&
    (await resolveComparableConfigPath(xdgConfigHome, homePath)) !==
      path.resolve(homePath, '.config')
  ) {
    return new LocalProviderOperationError(
      'config-conflict',
      'OpenCode is using XDG_CONFIG_HOME, so Agent Teams cannot safely update the canonical global config. Remove that override or update its active config manually.'
    );
  }

  return null;
}

export function getOpenCodeInlineConfigOverrideConflict(
  environment: NodeJS.ProcessEnv,
  context?: OpenCodeInlineConfigWriteContext
): LocalProviderOperationError | null {
  const raw = environment.OPENCODE_CONFIG_CONTENT?.trim();
  if (!raw) return null;

  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;
  if (errors.length > 0 || !isRecord(parsed)) {
    return inlineConfigConflict(
      'OPENCODE_CONFIG_CONTENT is set but is not valid JSON/JSONC, so Agent Teams cannot prove which provider settings OpenCode will use.'
    );
  }

  const providers = isRecord(parsed.provider) ? parsed.provider : {};
  const conflicts = context
    ? Object.prototype.hasOwnProperty.call(providers, context.providerId) ||
      (context.setAsDefault === true && typeof parsed.model === 'string') ||
      (context.setAsSmallModel === true && typeof parsed.small_model === 'string')
    : Object.keys(providers).length > 0 ||
      typeof parsed.model === 'string' ||
      typeof parsed.small_model === 'string';

  return conflicts
    ? inlineConfigConflict(
        'OpenCode is using OPENCODE_CONFIG_CONTENT that overrides the provider or model settings Agent Teams would read or write.'
      )
    : null;
}

export function assertOpenCodeInlineConfigOverrideSafe(
  environment: NodeJS.ProcessEnv,
  context?: OpenCodeInlineConfigWriteContext
): void {
  const conflict = getOpenCodeInlineConfigOverrideConflict(environment, context);
  if (conflict) throw conflict;
}

function readNonEmptyEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: 'OPENCODE_CONFIG' | 'XDG_CONFIG_HOME'
): string | null {
  const value = environment[name]?.trim();
  return value || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function inlineConfigConflict(message: string): LocalProviderOperationError {
  return new LocalProviderOperationError(
    'config-conflict',
    `${message} Remove that inline override or update its active config manually.`
  );
}

function isAbsoluteEnvironmentConfigPath(value: string, homePath: string): boolean {
  const expanded =
    value === '~'
      ? homePath
      : value.startsWith('~/') || value.startsWith('~\\')
        ? path.join(homePath, value.slice(2))
        : value;
  return path.isAbsolute(expanded);
}

function resolveEnvironmentConfigPath(value: string, homePath: string): string {
  const expanded =
    value === '~'
      ? homePath
      : value.startsWith('~/') || value.startsWith('~\\')
        ? path.join(homePath, value.slice(2))
        : value;
  return path.resolve(expanded);
}

async function resolveComparableConfigPath(value: string, homePath: string): Promise<string> {
  let candidate = resolveEnvironmentConfigPath(value, homePath);
  const unresolvedSuffix: string[] = [];
  while (true) {
    try {
      return path.join(await fs.realpath(candidate), ...unresolvedSuffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return candidate;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        return candidate;
      }
      unresolvedSuffix.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}
