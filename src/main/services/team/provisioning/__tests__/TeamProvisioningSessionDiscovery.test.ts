import { encodePath } from '@main/utils/pathDecoder';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { scanForNewestProjectSession } from '../TeamProvisioningSessionDiscovery';

describe('TeamProvisioningSessionDiscovery', () => {
  it('returns the newest unknown JSONL session id from the encoded project directory', async () => {
    const projectPath = '/fake/my project';
    const projectsBasePath = '/fake/claude/projects';
    const projectDir = path.join(projectsBasePath, encodePath(projectPath));
    const statByFile = new Map<string, number>([
      ['known.jsonl', 300],
      ['older.jsonl', 100],
      ['newer.jsonl', 400],
    ]);
    const readDir = vi.fn(async () => ['known.jsonl', 'older.jsonl', 'notes.txt', 'newer.jsonl']);
    const stat = vi.fn(async (filePath: string) => ({
      mtimeMs: statByFile.get(path.basename(filePath)) ?? 0,
    }));

    await expect(
      scanForNewestProjectSession({
        projectPath,
        knownSessions: ['known'],
        projectsBasePath,
        ports: { readDir, stat },
      })
    ).resolves.toBe('newer');
    expect(readDir).toHaveBeenCalledWith(projectDir);
    expect(stat).toHaveBeenCalledWith(path.join(projectDir, 'older.jsonl'));
    expect(stat).toHaveBeenCalledWith(path.join(projectDir, 'newer.jsonl'));
  });

  it('returns null when there are no unknown JSONL sessions', async () => {
    await expect(
      scanForNewestProjectSession({
        projectPath: '/fake/project',
        knownSessions: ['existing'],
        projectsBasePath: '/fake/claude/projects',
        ports: {
          readDir: vi.fn(async () => ['existing.jsonl', 'readme.md']),
          stat: vi.fn(async () => ({ mtimeMs: 1 })),
        },
      })
    ).resolves.toBeNull();
  });

  it('returns null on filesystem errors', async () => {
    await expect(
      scanForNewestProjectSession({
        projectPath: '/fake/project',
        knownSessions: [],
        projectsBasePath: '/fake/claude/projects',
        ports: {
          readDir: vi.fn(async () => {
            throw new Error('missing');
          }),
          stat: vi.fn(async () => ({ mtimeMs: 1 })),
        },
      })
    ).resolves.toBeNull();
  });
});
