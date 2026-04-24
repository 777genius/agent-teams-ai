import fs from 'node:fs';
import path from 'node:path';

import { getController } from '../controller';

function resolveConfigPath(teamName: string, claudeDir?: string): string {
  const controller = getController(teamName, claudeDir) as {
    context?: { paths?: { teamDir?: string } };
  };
  const teamDir = controller.context?.paths?.teamDir;
  if (typeof teamDir !== 'string' || teamDir.trim().length === 0) {
    throw new Error(
      `Unknown team "${teamName}". Board tools require an existing configured team with config.json. Use the real board teamName from durable team context - never use a member or lead name as teamName.`
    );
  }
  return path.join(teamDir, 'config.json');
}

export function assertConfiguredTeam(teamName: string, claudeDir?: string): void {
  const configPath = resolveConfigPath(teamName, claudeDir);
  let raw = '';
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    throw new Error(
      `Unknown team "${teamName}". Board tools require an existing configured team with config.json. Use the real board teamName from durable team context - never use a member or lead name as teamName.`
    );
  }

  try {
    const parsed = JSON.parse(raw) as { name?: unknown };
    if (typeof parsed?.name !== 'string' || parsed.name.trim().length === 0) {
      throw new Error('invalid');
    }
  } catch {
    throw new Error(
      `Unknown team "${teamName}". Board tools require an existing configured team with config.json. Use the real board teamName from durable team context - never use a member or lead name as teamName.`
    );
  }
}
