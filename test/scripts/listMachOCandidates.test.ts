// @vitest-environment node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { listMachOCandidates } from '../../scripts/ci/list-macho-candidates.mjs';

function write(root: string, relativePath: string, bytes: number[] | string): string {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, typeof bytes === 'string' ? bytes : Buffer.from(bytes));
  return filePath;
}

const scriptPath = path.resolve(__dirname, '../../scripts/ci/list-macho-candidates.mjs');

// The shell verifier runs on macOS only; names with newlines and symlinks are POSIX fixtures.
describe.skipIf(process.platform === 'win32')('list-macho-candidates', () => {
  it('finds every Mach-O and universal magic number and counts regular files like find -type f', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'macho-candidates-'));
    // A doubled separator, as mktemp gives with a TMPDIR ending in "/", must stay verbatim.
    const root = `${temp}//Agent Teams AI.app`;
    try {
      const thinLittle = [0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1];
      const thinLittle32 = [0xce, 0xfa, 0xed, 0xfe];
      const thinBig = [0xfe, 0xed, 0xfa, 0xcf];
      const thinBig32 = [0xfe, 0xed, 0xfa, 0xce];
      const universal = [0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2];
      const universal64 = [0xca, 0xfe, 0xba, 0xbf];
      const gpuUniversal = [0xcb, 0xfe, 0xba, 0xbe];
      write(root, 'Contents/MacOS/Agent Teams AI', thinLittle);
      write(root, 'Contents/Resources/a/thin32.dylib', thinLittle32);
      write(root, 'Contents/Resources/b/big.node', thinBig);
      write(root, 'Contents/Resources/b/big32', thinBig32);
      write(root, 'Contents/Resources/c d/fat binary', universal);
      write(root, 'Contents/Resources/c d/fat64', universal64);
      write(root, 'Contents/Resources/metal/default.metallib', gpuUniversal);
      write(root, 'Contents/Resources/odd\nname/tool', thinLittle);
      write(root, 'Contents/Resources/node_modules/pkg/index.js', 'module.exports = 1;\n');
      write(root, 'Contents/Resources/node_modules/pkg/short', [0xcf, 0xfa]);
      write(root, 'Contents/Resources/node_modules/pkg/empty', []);
      write(root, 'Contents/Resources/node_modules/pkg/swapped', [0xfe, 0xed, 0xfa, 0xcd]);
      fs.symlinkSync(
        path.join(root, 'Contents/MacOS/Agent Teams AI'),
        path.join(root, 'Contents/Resources/linked-binary')
      );
      fs.symlinkSync(
        path.join(root, 'Contents/Resources/b'),
        path.join(root, 'Contents/linked-dir')
      );

      const result = listMachOCandidates(root);

      expect(result.regularFiles).toBe(12);
      expect(result.candidates).toEqual(
        [
          'Contents/MacOS/Agent Teams AI',
          'Contents/Resources/a/thin32.dylib',
          'Contents/Resources/b/big.node',
          'Contents/Resources/b/big32',
          'Contents/Resources/c d/fat binary',
          'Contents/Resources/c d/fat64',
          'Contents/Resources/metal/default.metallib',
          'Contents/Resources/odd\nname/tool',
        ]
          .map((relativePath) => `${root}/${relativePath}`)
          .sort()
      );
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('prints the file count, the candidate count and each candidate as NUL-terminated values', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'macho-candidates-cli-'));
    const root = path.join(temp, 'Agent Teams AI.app');
    try {
      write(root, 'Contents/MacOS/Agent Teams AI', [0xcf, 0xfa, 0xed, 0xfe]);
      write(root, 'Contents/Resources/readme.txt', 'text\n');

      const output = execFileSync(process.execPath, [scriptPath, root], { encoding: 'utf8' });

      expect(output).toBe(`2\u00001\u0000${root}/Contents/MacOS/Agent Teams AI\u0000`);
      expect(() =>
        execFileSync(process.execPath, [scriptPath, path.join(root, 'missing')], { stdio: 'pipe' })
      ).toThrow();
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
