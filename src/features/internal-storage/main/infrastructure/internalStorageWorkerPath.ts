import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER_FILENAME = 'internal-storage-worker.cjs';

export function getInternalStorageWorkerPathCandidates(): string[] {
  const baseDir =
    typeof __dirname === 'string' && __dirname.length > 0
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));
  return [
    path.join(baseDir, WORKER_FILENAME),
    path.join(process.cwd(), 'dist-electron', 'main', WORKER_FILENAME),
  ];
}

export function resolveInternalStorageWorkerPath(): string | null {
  for (const candidate of getInternalStorageWorkerPathCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // An inaccessible candidate is unavailable; the next packaged/dev path may still work.
    }
  }
  return null;
}
