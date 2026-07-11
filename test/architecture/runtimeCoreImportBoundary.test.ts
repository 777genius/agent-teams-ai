import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOTS = ['src/renderer', 'src/preload', 'src/shared'] as const;
const SOURCE_FILE_PATTERN = /\.(?:ts|tsx)$/;
const FORBIDDEN_RUNTIME_CORE_MAIN_IMPORT =
  /(?:from\s+|import\s*\()\s*['"][^'"]*(?:@features\/runtime-core\/main|features\/runtime-core\/main)(?:\/[^'"]*)?['"]/;

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return collectSourceFiles(path);
      }
      return SOURCE_FILE_PATTERN.test(entry.name) ? [path] : [];
    })
  );
  return files.flat();
}

describe('runtime-core import boundary', () => {
  it('keeps runtime-core/main out of renderer, preload, and shared code', async () => {
    const files = (await Promise.all(ROOTS.map((root) => collectSourceFiles(root)))).flat();
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (FORBIDDEN_RUNTIME_CORE_MAIN_IMPORT.test(source)) {
        violations.push(relative(process.cwd(), file));
      }
    }

    expect(violations).toEqual([]);
  });
});
