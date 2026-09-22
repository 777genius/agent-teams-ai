import { encodePath, extractBaseDir } from '@main/utils/pathDecoder';
import * as path from 'path';

export interface NewestProjectSessionDiscoveryPorts {
  readDir(dirPath: string): Promise<string[]>;
  stat(filePath: string): Promise<{ mtimeMs: number }>;
}

export async function scanForNewestProjectSession(input: {
  projectPath: string;
  knownSessions: readonly string[];
  projectsBasePath: string;
  ports: NewestProjectSessionDiscoveryPorts;
}): Promise<string | null> {
  try {
    const projectId = encodePath(input.projectPath);
    const baseDir = extractBaseDir(projectId);
    const projectDir = path.join(input.projectsBasePath, baseDir);
    const entries = await input.ports.readDir(projectDir);

    const knownSet = new Set(input.knownSessions);
    let newest: { id: string; mtime: number } | null = null;

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const sessionId = entry.replace('.jsonl', '');
      if (knownSet.has(sessionId)) continue;

      const filePath = path.join(projectDir, entry);
      const stat = await input.ports.stat(filePath);
      if (!newest || stat.mtimeMs > newest.mtime) {
        newest = { id: sessionId, mtime: stat.mtimeMs };
      }
    }

    return newest?.id ?? null;
  } catch {
    return null;
  }
}
