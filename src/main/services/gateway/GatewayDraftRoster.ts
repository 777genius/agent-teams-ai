import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Destructive draft recovery must distinguish a missing roster from an unreadable one. */
export async function isGatewayMemberSaved(
  teamsBasePath: string,
  teamName: string,
  memberName: string
): Promise<boolean> {
  if (!teamName || teamName === '.' || teamName === '..' || /[\\/\0]/.test(teamName))
    throw new Error('Invalid gateway team name.');
  let saved = false;
  for (const filename of ['members.meta.json', 'config.json']) {
    let raw: string;
    try {
      raw = await readFile(join(teamsBasePath, teamName, filename), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const roster = JSON.parse(raw) as { members?: unknown };
    if (
      !roster ||
      !Array.isArray(roster.members) ||
      roster.members.some(
        (entry: unknown) =>
          !entry ||
          typeof entry !== 'object' ||
          typeof (entry as { name?: unknown }).name !== 'string'
      )
    )
      throw new Error('Cannot recover gateway drafts from an invalid saved roster.');
    saved ||= roster.members.some((entry: { name: string }) => entry.name === memberName);
  }
  return saved;
}
