import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A raw control character in a source file makes git treat it as binary: the
 * diff reports `Bin 2671 -> 3600 bytes` instead of lines, review sees nothing,
 * and the source-size guard cannot count it. This has happened twice in this
 * repository, both times because a NUL byte was written where the escape
 * sequence was meant, in a map-key separator. Control characters belong in
 * string escapes, never in the bytes of a source file.
 */
const ALLOWED_CONTROL_CHARACTERS = new Set(['\t', '\n', '\r']);
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

const sourceRoot = path.resolve(__dirname, '..', '..', 'src');

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(entryPath)));
    } else if (SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }
  return files;
}

function findControlCharacter(contents: string): { line: number; codePoint: number } | null {
  const lines = contents.split('\n');
  for (const [index, line] of lines.entries()) {
    for (const character of line) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint < 0x20 && !ALLOWED_CONTROL_CHARACTERS.has(character)) {
        return { line: index + 1, codePoint };
      }
    }
  }
  return null;
}

describe('source control characters', () => {
  it('has no raw control characters in any TypeScript source file', async () => {
    const files = await listSourceFiles(sourceRoot);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const found = findControlCharacter(await readFile(file, 'utf8'));
      if (!found) continue;
      const relative = path.relative(sourceRoot, file).replaceAll('\\', '/');
      const codePoint = found.codePoint.toString(16).padStart(4, '0').toUpperCase();
      offenders.push(
        `src/${relative}:${found.line} contains U+${codePoint} — use the escape sequence instead`
      );
    }

    expect(offenders).toEqual([]);
  });
});
