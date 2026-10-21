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
  const memberKey = memberName.trim().toLowerCase();
  let saved = false;
  let removedByMetadata = false;
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
          typeof (entry as { name?: unknown }).name !== 'string' ||
          !(entry as { name: string }).name.trim() ||
          ((entry as { removedAt?: unknown }).removedAt != null &&
            (typeof (entry as { removedAt: unknown }).removedAt !== 'number' ||
              !Number.isFinite((entry as { removedAt: number }).removedAt)))
      )
    )
      throw new Error('Cannot recover gateway drafts from an invalid saved roster.');
    for (const entry of roster.members as { name: string; removedAt?: number | null }[]) {
      if (entry.name.trim().toLowerCase() !== memberKey) continue;
      // Match the canonical roster merge: metadata tombstones suppress stale CLI rows.
      if (filename === 'members.meta.json' && entry.removedAt != null) removedByMetadata = true;
      if (entry.removedAt == null) saved = true;
    }
  }
  return saved && !removedByMetadata;
}
