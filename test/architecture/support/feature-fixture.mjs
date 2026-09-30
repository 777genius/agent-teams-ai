import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function withFeatureFixture(files, callback) {
  const root = mkdtempSync(path.join(tmpdir(), 'feature-architecture-'));
  try {
    for (const [relativePath, source] of Object.entries(files)) {
      const absolutePath = path.join(root, relativePath);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, source);
    }
    return callback(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}
