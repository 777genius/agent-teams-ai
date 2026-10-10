import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { isPathWithinRoot, validateFileName } from '@main/utils/pathValidation';
import * as fs from 'fs';
import * as path from 'path';

function realpathIfExists(inputPath: string): string | null {
  try {
    return fs.realpathSync.native(inputPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }
}

export function resolveInboxPath(teamName: string, inboxName: string): string {
  const safeTeamName = teamName.trim();
  const safeInboxName = inboxName.trim();
  if (!validateFileName(safeTeamName).valid || !validateFileName(safeInboxName).valid) {
    throw new Error('Invalid inbox path');
  }

  const teamsBasePath = getTeamsBasePath();
  const teamDir = path.join(teamsBasePath, safeTeamName);
  const inboxDir = path.join(teamsBasePath, safeTeamName, 'inboxes');
  const inboxPath = path.join(inboxDir, `${safeInboxName}.json`);
  if (
    !isPathWithinRoot(teamDir, teamsBasePath) ||
    !isPathWithinRoot(inboxDir, teamDir) ||
    !isPathWithinRoot(inboxPath, inboxDir)
  ) {
    throw new Error('Invalid inbox path');
  }

  const realTeamsBasePath = realpathIfExists(teamsBasePath) ?? path.resolve(teamsBasePath);
  const realTeamDir = realpathIfExists(teamDir);
  if (realTeamDir && !isPathWithinRoot(realTeamDir, realTeamsBasePath)) {
    throw new Error('Invalid inbox path');
  }

  const teamRootForRealCheck = realTeamDir ?? path.resolve(teamDir);
  const realInboxDir = realpathIfExists(inboxDir);
  if (
    realInboxDir &&
    (!isPathWithinRoot(realInboxDir, teamRootForRealCheck) ||
      !isPathWithinRoot(realInboxDir, realTeamsBasePath))
  ) {
    throw new Error('Invalid inbox path');
  }

  const inboxRootForRealCheck = realInboxDir ?? path.resolve(inboxDir);
  const realInboxPath = realpathIfExists(inboxPath);
  if (
    realInboxPath &&
    (!isPathWithinRoot(realInboxPath, inboxRootForRealCheck) ||
      !isPathWithinRoot(realInboxPath, teamRootForRealCheck) ||
      !isPathWithinRoot(realInboxPath, realTeamsBasePath))
  ) {
    throw new Error('Invalid inbox path');
  }

  return inboxPath;
}

