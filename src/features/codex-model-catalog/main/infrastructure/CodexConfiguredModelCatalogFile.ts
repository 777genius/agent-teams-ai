import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  extractCodexCatalogModelRecords,
  parseCodexModelCatalogJsonPathFromToml,
} from '@features/codex-model-catalog/core/domain/coerceCodexCatalogModelInput';
import { mergeCodexCatalogModels } from '@features/codex-model-catalog/core/domain/mergeCodexCatalogModels';
import { normalizeCodexAppServerModels } from '@features/codex-model-catalog/core/domain/normalizeCodexAppServerModel';

import type { CliProviderModelCatalogItem } from '@shared/types';

function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
}

async function resolveConfiguredCatalogPath(
  env: NodeJS.ProcessEnv | undefined
): Promise<string | null> {
  const codexHome = resolveCodexHome(env);
  let toml: string;
  try {
    toml = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
  } catch {
    return null;
  }
  const configuredPath = parseCodexModelCatalogJsonPathFromToml(toml);
  if (!configuredPath) {
    return null;
  }
  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(codexHome, configuredPath);
}

export async function resolveConfiguredCodexCatalogFingerprint(
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const catalogPath = await resolveConfiguredCatalogPath(env);
  if (!catalogPath) {
    return null;
  }
  try {
    const stats = await fs.stat(catalogPath);
    return `${catalogPath}:${stats.mtimeMs}:${stats.size}`;
  } catch {
    return `${catalogPath}:missing`;
  }
}

export async function loadConfiguredCodexCatalogExtras(options: {
  env?: NodeJS.ProcessEnv;
  includeHidden?: boolean;
}): Promise<{
  models: CliProviderModelCatalogItem[];
  catalogPath: string | null;
  diagnostic: string | null;
}> {
  const catalogPath = await resolveConfiguredCatalogPath(options.env);
  if (!catalogPath) {
    return { models: [], catalogPath: null, diagnostic: null };
  }

  try {
    const raw = JSON.parse(await fs.readFile(catalogPath, 'utf8')) as unknown;
    const normalized = normalizeCodexAppServerModels(extractCodexCatalogModelRecords(raw), {
      includeHidden: options.includeHidden,
    });
    return {
      models: normalized.models,
      catalogPath,
      diagnostic:
        normalized.models.length > 0
          ? `Merged ${normalized.models.length} models from local Codex catalog ${catalogPath}.`
          : `Local Codex catalog ${catalogPath} did not contain visible models.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      models: [],
      catalogPath,
      diagnostic: `Failed to read local Codex catalog ${catalogPath}: ${message}`,
    };
  }
}

export async function mergeConfiguredCodexCatalogExtras(
  primary: readonly CliProviderModelCatalogItem[],
  options: {
    env?: NodeJS.ProcessEnv;
    includeHidden?: boolean;
  }
): Promise<{
  models: CliProviderModelCatalogItem[];
  diagnostic: string | null;
}> {
  const extras = await loadConfiguredCodexCatalogExtras(options);
  return {
    models: mergeCodexCatalogModels(primary, extras.models),
    diagnostic: extras.diagnostic,
  };
}
