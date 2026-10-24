import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';
import { expect, it } from 'vitest';

it('seeds the qualified Windows model capacity without triggering compaction after task_get', async () => {
  const source = await readFile('scripts/e2e/opencode-native-test-auth.ts', 'utf8');
  const start = source.indexOf('export async function seedWindowsTestModelOutputLimit(');
  const end = source.indexOf('\nasync function seedOpenRouter()', start);
  assert(start >= 0 && end > start);
  const actual = ts.transpileModule(source.slice(start, end).replace('export ', ''), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const protectedDirectories: string[] = [];
  // Only the Windows DACL subprocess is stubbed; execute the actual seeder and filesystem writes.
  const seed = vm.runInNewContext(`${actual};seedWindowsTestModelOutputLimit`, {
    assert, path, process: { platform: 'win32' }, mkdir, writeFile,
    protectWindowsTestDirectory: async (directory: string) => { protectedDirectories.push(directory); },
  }) as (directory: string, model: string) => Promise<void>;
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-windows-model-limit-'));
  try {
    await seed(root, 'openrouter/nvidia/nemotron-3-super-120b-a12b:free');
    const config = JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8'));
    const limit = config.provider.openrouter.models['nvidia/nemotron-3-super-120b-a12b:free'].limit;
    expect(limit).toEqual({ context: 262_144, output: 8192 });
    // Official V1 overflow.ts uses context - maxOutputTokens; the observed first tool used 29,859 tokens.
    expect(29_748 + 111).toBeLessThan(limit.context - limit.output);
    expect(29_748 + 111).toBeGreaterThanOrEqual(32_000 - limit.output);
    expect(protectedDirectories).toEqual([root]);
    await expect(seed(root, 'openrouter/nvidia/nemotron-3-super-120b-a12b:free')).rejects.toMatchObject({ code: 'EEXIST' });
    const other = path.join(root, 'TEST-other');
    await seed(other, 'openrouter/other-model');
    const unchanged = JSON.parse(await readFile(path.join(other, 'opencode.json'), 'utf8'));
    expect(unchanged.provider.openrouter.models['other-model'].limit).toEqual({ context: 32_000, output: 8192 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
