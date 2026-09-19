import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { getCachedShellEnv } from '@main/utils/shellEnv';
import { parse, type ParseError } from 'jsonc-parser';

import { isPathInside } from './openCodeLocalProviderConnectorUtils';
import { LocalProviderOperationError } from './OpenCodeLocalProviderSupport';

import type { RuntimeLocalProviderScopeDto } from '../../contracts';

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

export interface OpenCodeConfigTarget {
  readonly scope: RuntimeLocalProviderScopeDto;
  readonly projectPath?: string;
  readonly configPath: string;
  readonly raw: string | null;
  readonly mode?: number;
}

interface ReadOpenCodeConfigTargetInput {
  readonly scope: RuntimeLocalProviderScopeDto;
  readonly projectPath?: string | null;
  readonly homePath: string;
  readonly getEnvironment: () => NodeJS.ProcessEnv;
  readonly ensureGlobalDirectory?: boolean;
  readonly inlineContext?: OpenCodeInlineConfigWriteContext;
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

export function readOpenCodeConfigTarget(
  input: ReadOpenCodeConfigTargetInput
): Promise<OpenCodeConfigTarget> {
  assertOpenCodeInlineConfigOverrideSafe(input.getEnvironment(), input.inlineContext);
  return input.scope === 'global'
    ? readOpenCodeGlobalConfigTarget(
        input.homePath,
        input.getEnvironment,
        input.ensureGlobalDirectory ?? false
      )
    : readOpenCodeProjectConfigTarget(input.projectPath);
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

async function readOpenCodeGlobalConfigTarget(
  homePath: string,
  getEnvironment: () => NodeJS.ProcessEnv,
  ensureDirectory: boolean
): Promise<OpenCodeConfigTarget> {
  let realHomePath: string;
  try {
    const homeStat = await fs.stat(homePath);
    if (!homeStat.isDirectory()) throw new Error('not-directory');
    realHomePath = await fs.realpath(homePath);
  } catch {
    throw new LocalProviderOperationError(
      'config-invalid',
      'The user home directory is not available for the global OpenCode config.'
    );
  }

  const overrideConflict = await getOpenCodeGlobalConfigOverrideConflict(
    getEnvironment(),
    realHomePath
  );
  if (overrideConflict) throw overrideConflict;

  let configDirectory = realHomePath;
  for (const segment of ['.config', 'opencode']) {
    configDirectory = path.join(configDirectory, segment);
    try {
      const stat = await fs.lstat(configDirectory);
      if (stat.isSymbolicLink()) {
        throw new LocalProviderOperationError(
          'config-conflict',
          'The global OpenCode config directory is a symbolic link and must be updated manually.'
        );
      }
      if (!stat.isDirectory()) {
        throw new LocalProviderOperationError(
          'config-conflict',
          'The global OpenCode config path is not a directory.'
        );
      }
    } catch (error) {
      if (error instanceof LocalProviderOperationError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new LocalProviderOperationError(
          'config-invalid',
          'Could not inspect the global OpenCode config directory.'
        );
      }
      if (!ensureDirectory) {
        return {
          scope: 'global',
          configPath: path.join(realHomePath, '.config', 'opencode', 'opencode.json'),
          raw: null,
        };
      }
      await fs.mkdir(configDirectory, { mode: 0o700 });
    }
  }

  const realConfigDirectory = await fs.realpath(configDirectory);
  if (!isPathInside(realHomePath, realConfigDirectory)) {
    throw new LocalProviderOperationError(
      'config-conflict',
      'The global OpenCode config resolves outside the user home directory.'
    );
  }

  const existingConfigs: Array<{ path: string; mode: number }> = [];
  for (const filename of OPENCODE_GLOBAL_CONFIG_FILENAMES) {
    const candidate = path.join(realConfigDirectory, filename);
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) {
        throw new LocalProviderOperationError(
          'config-conflict',
          'The global OpenCode config is a symbolic link and must be updated manually.'
        );
      }
      if (stat.isFile()) {
        existingConfigs.push({ path: candidate, mode: stat.mode & 0o777 });
      }
    } catch (error) {
      if (error instanceof LocalProviderOperationError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new LocalProviderOperationError(
          'config-invalid',
          'Could not inspect the global OpenCode config.'
        );
      }
    }
  }
  if (existingConfigs.length > 1) {
    throw new LocalProviderOperationError(
      'config-conflict',
      'Both global opencode.json and opencode.jsonc were found. Keep one config file and retry.'
    );
  }
  const existingConfig = existingConfigs[0];
  const configPath = existingConfig?.path ?? path.join(realConfigDirectory, 'opencode.json');
  return {
    scope: 'global',
    configPath,
    raw: existingConfig ? await fs.readFile(configPath, 'utf8') : null,
    mode: existingConfig?.mode,
  };
}

async function readOpenCodeProjectConfigTarget(
  projectPathInput: string | null | undefined
): Promise<OpenCodeConfigTarget> {
  const projectPath = projectPathInput?.trim();
  if (!projectPath) {
    throw new LocalProviderOperationError(
      'project-required',
      'Select a project before loading local providers.'
    );
  }
  let realProjectPath: string;
  try {
    const stat = await fs.stat(projectPath);
    if (!stat.isDirectory()) throw new Error('not-directory');
    realProjectPath = await fs.realpath(projectPath);
  } catch {
    throw new LocalProviderOperationError(
      'project-required',
      'The selected project directory is not available.'
    );
  }

  const existingConfigs: Array<{ path: string; mode: number }> = [];
  for (const relativePath of OPENCODE_PROJECT_CONFIG_CANDIDATES) {
    const candidate = path.join(realProjectPath, relativePath);
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) {
        throw new LocalProviderOperationError(
          'config-conflict',
          'The OpenCode config is a symbolic link and must be updated manually.'
        );
      }
      if (stat.isFile()) {
        const realConfigPath = await fs.realpath(candidate);
        if (!isPathInside(realProjectPath, realConfigPath)) {
          throw new LocalProviderOperationError(
            'config-conflict',
            'The OpenCode config resolves outside the selected project and must be updated manually.'
          );
        }
        existingConfigs.push({ path: candidate, mode: stat.mode & 0o777 });
      }
    } catch (error) {
      if (error instanceof LocalProviderOperationError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new LocalProviderOperationError(
          'config-invalid',
          'Could not inspect the OpenCode project config.'
        );
      }
    }
  }
  if (existingConfigs.length > 1) {
    throw new LocalProviderOperationError(
      'config-conflict',
      'Multiple OpenCode project configs were found. Keep one config file and retry.'
    );
  }
  const existingConfig = existingConfigs[0];
  const configPath = existingConfig?.path ?? path.join(realProjectPath, 'opencode.json');
  return {
    scope: 'project',
    projectPath: realProjectPath,
    configPath,
    raw: existingConfig ? await fs.readFile(configPath, 'utf8') : null,
    mode: existingConfig?.mode,
  };
}
