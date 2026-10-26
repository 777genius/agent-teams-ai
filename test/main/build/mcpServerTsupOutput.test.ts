// @vitest-environment node
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const server = fileURLToPath(new URL('../../../mcp-server/', import.meta.url));
const tsup = realpathSync(path.join(server, 'node_modules/tsup/dist/cli-default.js'));
const sourceManifest = JSON.parse(readFileSync(path.join(server, 'package.json'), 'utf8'));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('MCP tsup deployment output', () => {
  it.each(['default', 'custom'] as const)(
    'writes the manifest beside the actual %s CLI output',
    async (mode) => {
      const root = mkdtempSync(path.join(tmpdir(), 'TEST-mcp-tsup-output-'));
      roots.push(root);
      for (const file of ['tsup.config.ts', 'deploymentManifest.ts', 'package.json'])
        copyFileSync(path.join(server, file), path.join(root, file));
      mkdirSync(path.join(root, 'src'));
      writeFileSync(path.join(root, 'src/index.ts'), 'export const ready = true;\n');
      symlinkSync(
        realpathSync(path.join(server, 'node_modules')),
        path.join(root, 'node_modules'),
        'junction'
      );
      const output =
        mode === 'default'
          ? path.join(root, 'dist')
          : path.join(root, 'private output', 'generation');
      await run(process.execPath, [tsup, ...(mode === 'custom' ? ['--out-dir', output] : [])], {
        cwd: root,
        timeout: 15_000,
        maxBuffer: 512 * 1024,
      });

      expect(existsSync(path.join(output, 'index.js'))).toBe(true);
      expect(JSON.parse(readFileSync(path.join(output, 'package.json'), 'utf8'))).toEqual({
        name: sourceManifest.name,
        version: sourceManifest.version,
        private: true,
        type: 'module',
        main: 'index.js',
        engines: sourceManifest.engines,
      });
      expect(createRequire(path.join(root, 'consumer.cjs')).resolve(output)).toBe(
        realpathSync(path.join(output, 'index.js'))
      );
      expect(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))).toEqual(
        sourceManifest
      );
      if (mode === 'custom') expect(existsSync(path.join(root, 'dist'))).toBe(false);
    }
  );
});
