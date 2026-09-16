import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface ClaudeJsonProjectTrustEdit {
  configPaths: string[];
  projectKeys: string[];
  createdFiles: string[];
  previousProjectsByPath: Record<string, Record<string, unknown | undefined>>;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function claudeJsonProjectKeys(projectPath: string, canonicalProjectPath = projectPath): string[] {
  return [
    ...new Set([
      path.normalize(projectPath).replace(/\\/g, '/'),
      path.normalize(canonicalProjectPath).replace(/\\/g, '/'),
    ]),
  ];
}

export function resolveClaudeJsonConfigPaths(configDir: string, homeDir?: string): string[] {
  const configPaths = [path.join(configDir, '.claude.json')];
  const resolvedHome = homeDir?.trim();
  if (resolvedHome) {
    const homeConfigPath = path.join(resolvedHome, '.claude.json');
    if (homeConfigPath !== configPaths[0]) {
      configPaths.push(homeConfigPath);
    }
  }
  return configPaths;
}

export function applyClaudeJsonProjectTrust(
  existing: Record<string, unknown>,
  projectKeys: readonly string[]
): {
  next: Record<string, unknown>;
  previousProjects: Record<string, unknown | undefined>;
} {
  const projects = { ...(asRecord(existing.projects) ?? {}) };
  const previousProjects: Record<string, unknown | undefined> = {};
  for (const projectKey of projectKeys) {
    previousProjects[projectKey] = Object.prototype.hasOwnProperty.call(projects, projectKey)
      ? cloneJson(projects[projectKey])
      : undefined;
    const currentProject = asRecord(projects[projectKey]) ?? {};
    projects[projectKey] = {
      ...currentProject,
      hasTrustDialogAccepted: true,
    };
  }
  return {
    next: { ...existing, projects },
    previousProjects,
  };
}

export function revertClaudeJsonProjectTrustInMemory(
  current: Record<string, unknown>,
  projectKeys: readonly string[],
  previousProjects: Record<string, unknown | undefined>
): Record<string, unknown> {
  const projects = { ...(asRecord(current.projects) ?? {}) };
  for (const projectKey of projectKeys) {
    if (!Object.prototype.hasOwnProperty.call(previousProjects, projectKey)) {
      continue;
    }
    const previous = previousProjects[projectKey];
    if (previous === undefined) {
      delete projects[projectKey];
    } else {
      projects[projectKey] = cloneJson(previous);
    }
  }
  const next = { ...current };
  if (Object.keys(projects).length === 0) {
    delete next.projects;
  } else {
    next.projects = projects;
  }
  return next;
}

async function readClaudeJsonFile(configPath: string): Promise<string | null> {
  return fs.readFile(configPath, 'utf8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  });
}

export async function upsertTrustedClaudeProjectConfig(
  configDir: string,
  projectPath: string,
  homeDir = process.env.HOME
): Promise<ClaudeJsonProjectTrustEdit> {
  const canonicalProjectPath = await fs.realpath(projectPath).catch(() => projectPath);
  const projectKeys = claudeJsonProjectKeys(projectPath, canonicalProjectPath);
  const configPaths = resolveClaudeJsonConfigPaths(configDir, homeDir);
  const createdFiles: string[] = [];
  const previousProjectsByPath: Record<string, Record<string, unknown | undefined>> = {};

  for (const configPath of configPaths) {
    const raw = await readClaudeJsonFile(configPath);
    if (raw === null) {
      createdFiles.push(configPath);
    }
    const existing = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const applied = applyClaudeJsonProjectTrust(existing, projectKeys);
    previousProjectsByPath[configPath] = applied.previousProjects;
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(applied.next, null, 2)}\n`, 'utf8');
  }

  return {
    configPaths,
    projectKeys,
    createdFiles,
    previousProjectsByPath,
  };
}

export async function revertClaudeJsonProjectTrust(edit: ClaudeJsonProjectTrustEdit): Promise<void> {
  for (const configPath of edit.configPaths) {
    const raw = await readClaudeJsonFile(configPath);
    if (raw === null) {
      continue;
    }
    const current = JSON.parse(raw) as Record<string, unknown>;
    const previousProjects = edit.previousProjectsByPath[configPath] ?? {};
    const next = revertClaudeJsonProjectTrustInMemory(current, edit.projectKeys, previousProjects);
    const createdByTest = edit.createdFiles.includes(configPath);
    if (createdByTest && Object.keys(next).length === 0) {
      await fs.rm(configPath, { force: true });
      continue;
    }
    await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  }
}
