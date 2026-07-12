import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  isPathWithinRoot,
  matchesSensitivePattern,
  validateOpenPathUserSelected,
} from '@main/utils/pathValidation';

import type { TeamImportFolderSnapshot } from '../../core/application/models/TeamImportFolderSnapshot';
import type { TeamImportFolderSourcePort } from '../../core/application/ports/TeamImportFolderSourcePort';
import type { Dirent, Stats } from 'node:fs';

export const TEAM_IMPORT_LIMITS = {
  maxAgentFiles: 32,
  maxSkillFiles: 64,
  maxAgentFileBytes: 256 * 1024,
  maxClaudeMdBytes: 512 * 1024,
  maxSkillFileBytes: 64 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
} as const;

interface ReadBudget {
  totalBytes: number;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function didFileIdentityChange(expected: Stats, actual: Stats): boolean {
  if (
    Number.isFinite(expected.dev) &&
    Number.isFinite(expected.ino) &&
    Number.isFinite(actual.dev) &&
    Number.isFinite(actual.ino)
  ) {
    return expected.dev !== actual.dev || expected.ino !== actual.ino;
  }
  return (
    expected.size !== actual.size ||
    expected.mode !== actual.mode ||
    expected.mtimeMs !== actual.mtimeMs
  );
}

async function readSafeDirectory(
  directoryPath: string,
  realRoot: string
): Promise<Dirent[] | null> {
  let stat: Stats;
  try {
    stat = await fs.lstat(directoryPath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Import source cannot contain symbolic links: ${directoryPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Expected a directory: ${directoryPath}`);
  }
  const realDirectory = await fs.realpath(directoryPath);
  if (!isPathWithinRoot(realDirectory, realRoot)) {
    throw new Error(`Import path escapes the selected folder: ${directoryPath}`);
  }
  return fs.readdir(directoryPath, { withFileTypes: true });
}

async function readBoundRegularUtf8File(input: {
  filePath: string;
  realRoot: string;
  maxBytes: number;
  budget: ReadBudget;
  optional?: boolean;
}): Promise<string | null> {
  let validated: Stats;
  try {
    validated = await fs.lstat(input.filePath);
  } catch (error) {
    if (input.optional && isMissing(error)) return null;
    throw error;
  }
  if (validated.isSymbolicLink() || !validated.isFile()) {
    throw new Error(`Import files must be regular files, not links: ${input.filePath}`);
  }
  if (validated.size > input.maxBytes) {
    throw new Error(`Import file is too large: ${input.filePath}`);
  }

  const realFile = await fs.realpath(input.filePath);
  if (!isPathWithinRoot(realFile, input.realRoot)) {
    throw new Error(`Import file escapes the selected folder: ${input.filePath}`);
  }

  const handle = await fs.open(input.filePath, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || didFileIdentityChange(validated, opened)) {
      throw new Error(`Import file changed during inspection: ${input.filePath}`);
    }
    if (opened.size > input.maxBytes) {
      throw new Error(`Import file is too large: ${input.filePath}`);
    }
    const content = await handle.readFile({ encoding: 'utf8' });
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > input.maxBytes) {
      throw new Error(`Import file is too large: ${input.filePath}`);
    }
    if (input.budget.totalBytes + bytes > TEAM_IMPORT_LIMITS.maxTotalBytes) {
      throw new Error('Import source is too large to preview safely.');
    }
    input.budget.totalBytes += bytes;
    return content;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readAgentFiles(input: {
  agentsDirectory: string;
  realRoot: string;
  budget: ReadBudget;
}): Promise<Array<{ fileName: string; content: string }>> {
  const entries = await readSafeDirectory(input.agentsDirectory, input.realRoot);
  if (!entries) return [];
  if (entries.some((entry) => entry.isSymbolicLink())) {
    throw new Error('Import source cannot contain symbolic links in an agents directory.');
  }
  const markdownFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (markdownFiles.length > TEAM_IMPORT_LIMITS.maxAgentFiles) {
    throw new Error(
      `Import source has too many agent files (max ${TEAM_IMPORT_LIMITS.maxAgentFiles}).`
    );
  }

  return Promise.all(
    markdownFiles.map(async (entry) => ({
      fileName: entry.name,
      content:
        (await readBoundRegularUtf8File({
          filePath: path.join(input.agentsDirectory, entry.name),
          realRoot: input.realRoot,
          maxBytes: TEAM_IMPORT_LIMITS.maxAgentFileBytes,
          budget: input.budget,
        })) ?? '',
    }))
  );
}

async function readSkillDefinitions(input: {
  skillsDirectory: string;
  realRoot: string;
  budget: ReadBudget;
}): Promise<Array<{ directoryName: string; content: string }>> {
  const entries = await readSafeDirectory(input.skillsDirectory, input.realRoot);
  if (!entries) return [];
  const directories = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name));
  if (directories.some((entry) => entry.isSymbolicLink())) {
    throw new Error('Import source cannot contain symbolic links in .claude/skills.');
  }
  if (directories.length > TEAM_IMPORT_LIMITS.maxSkillFiles) {
    throw new Error(`Import source has too many skills (max ${TEAM_IMPORT_LIMITS.maxSkillFiles}).`);
  }

  const definitions: Array<{ directoryName: string; content: string }> = [];
  for (const directory of directories) {
    const skillDirectory = path.join(input.skillsDirectory, directory.name);
    await readSafeDirectory(skillDirectory, input.realRoot);
    const content = await readBoundRegularUtf8File({
      filePath: path.join(skillDirectory, 'SKILL.md'),
      realRoot: input.realRoot,
      maxBytes: TEAM_IMPORT_LIMITS.maxSkillFileBytes,
      budget: input.budget,
      optional: true,
    });
    if (content !== null) definitions.push({ directoryName: directory.name, content });
  }
  return definitions;
}

export class SafeLocalTeamImportFolderSource implements TeamImportFolderSourcePort {
  async inspect(folderPath: string): Promise<TeamImportFolderSnapshot> {
    const validation = validateOpenPathUserSelected(folderPath);
    if (!validation.valid || !validation.normalizedPath) {
      throw new Error(validation.error ?? 'Invalid import source.');
    }

    const selectedPath = validation.normalizedPath;
    const selectedStat = await fs.lstat(selectedPath);
    if (selectedStat.isSymbolicLink() || !selectedStat.isDirectory()) {
      throw new Error('Import source must be a real directory, not a symbolic link.');
    }
    const realRoot = await fs.realpath(selectedPath);
    if (matchesSensitivePattern(`${realRoot}${path.sep}`)) {
      throw new Error('Cannot import from a sensitive system directory.');
    }
    const budget: ReadBudget = { totalBytes: 0 };

    const rootAgentsDirectory = path.join(realRoot, 'agents');
    const claudeAgentsDirectory = path.join(realRoot, '.claude', 'agents');
    let agentFiles = await readAgentFiles({
      agentsDirectory: rootAgentsDirectory,
      realRoot,
      budget,
    });
    if (agentFiles.length === 0) {
      agentFiles = await readAgentFiles({
        agentsDirectory: claudeAgentsDirectory,
        realRoot,
        budget,
      });
    }

    const nestedClaudeMd = await readBoundRegularUtf8File({
      filePath: path.join(realRoot, '.claude', 'CLAUDE.md'),
      realRoot,
      maxBytes: TEAM_IMPORT_LIMITS.maxClaudeMdBytes,
      budget,
      optional: true,
    });
    const claudeMd =
      nestedClaudeMd ??
      (await readBoundRegularUtf8File({
        filePath: path.join(realRoot, 'CLAUDE.md'),
        realRoot,
        maxBytes: TEAM_IMPORT_LIMITS.maxClaudeMdBytes,
        budget,
        optional: true,
      }));

    const skills = await readSkillDefinitions({
      skillsDirectory: path.join(realRoot, '.claude', 'skills'),
      realRoot,
      budget,
    });

    return {
      projectPath: realRoot,
      folderName: path.basename(realRoot),
      agentFiles,
      claudeMd: claudeMd ?? undefined,
      skills,
      warnings: [],
    };
  }
}
