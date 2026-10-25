import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve('scripts/e2e/opencode-native-windows-pins.ts');
const roots: string[] = [];

/** A fake SDK tree with only the registry surface the pin script reads. */
async function sdkWith(windows: readonly string[] | null): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-windows-pins-'));
  roots.push(root);
  if (windows === null) return root;
  const directory = path.join(root, 'src/services/opencode/compatibility');
  await mkdir(directory, { recursive: true });
  const contract = { range: { minimum: '2.0.0', below: '3.0.0' }, qualified: { 'darwin-arm64': ['2.1.4'], 'win32-x64': windows } };
  await writeFile(path.join(directory, 'OpenCodeV2Registry.ts'), [
    "export const OPENCODE_V2_FLOOR_WIRE_VERSION = '2.0.0';",
    "export const openCodeV2Wire = (version) => version === '2.0.0' ? 'floor' : 'current';",
    `export const openCodeV2ReleaseContract = () => (${JSON.stringify(contract)});`,
  ].join('\n'));
  return root;
}

function resolvePins(sdk: string, versions: string) {
  // A synchronous child blocks the test timer; bound it explicitly.
  const child = spawnSync(process.execPath, [script, sdk, versions], { encoding: 'utf8', timeout: 10_000 });
  const outputs = Object.fromEntries(child.stdout.split('\n').filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  return { status: child.status, outputs, stderr: child.stderr };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('native Windows OpenCode pins from the selected runtime registry', () => {
  it('uses the floor wire release and the newest Windows-qualified release', async () => {
    const result = resolvePins(await sdkWith(['2.0.0', '2.0.32', '2.1.4']), 'all');
    expect(result.status).toBe(0);
    expect(result.outputs).toMatchObject({ v1: '1.19.0', floor: '2.0.0', current: '2.1.4' });
    // The staged candidate pins exactly the runtime's published contract.
    expect(JSON.parse(result.outputs.contract!)).toMatchObject({ qualified: { 'win32-x64': ['2.0.0', '2.0.32', '2.1.4'] } });
  });

  it('never reads the runtime for V1-only runs', async () => {
    const result = resolvePins(path.join(os.tmpdir(), 'TEST-windows-pins-missing-sdk'), 'v1');
    expect(result.status).toBe(0);
    expect(result.outputs).toEqual({ v1: '1.19.0' });
  });

  it('requires the floor only when the selection starts it', async () => {
    const sdk = await sdkWith(['2.0.32']);
    expect(resolvePins(sdk, 'current')).toMatchObject({ status: 0, outputs: { current: '2.0.32' } });
    const all = resolvePins(sdk, 'all');
    expect(all.status).not.toBe(0);
    expect(all.stderr).toContain('does not qualify the V2 floor 2.0.0 on win32-x64');
  });

  it('fails closed without a current-wire Windows release or without the registry', async () => {
    const floorOnly = resolvePins(await sdkWith(['2.0.0']), 'v2');
    expect(floorOnly.status).not.toBe(0);
    expect(floorOnly.stderr).toContain('qualifies no current-wire V2 release on win32-x64');
    const unpinned = resolvePins(await sdkWith(null), 'current');
    expect(unpinned.status).not.toBe(0);
    expect(unpinned.stderr).toContain('predates the OpenCode V2 registry');
    expect(unpinned.outputs).toEqual({});
    // The packaged app would reject an unsorted contract; fail before packaging instead.
    const unsorted = resolvePins(await sdkWith(['2.0.32', '2.0.0']), 'all');
    expect(unsorted.status).not.toBe(0);
    expect(unsorted.stderr).toContain('not a valid app contract');
  });
});
