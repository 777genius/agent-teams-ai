import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve('scripts/e2e/opencode-native-windows-pins.ts');
const roots: string[] = [];

const order = (left: string, right: string) => {
  const [a, b] = [left, right].map((value) => value.split('.').map(Number));
  return a![0]! - b![0]! || a![1]! - b![1]! || a![2]! - b![2]!;
};

/** A fake SDK tree with only the registry surface the pin script reads. */
async function sdkWith(qualified: Readonly<Record<string, readonly string[]>> | null): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-windows-pins-'));
  roots.push(root);
  if (qualified === null) return root;
  const directory = path.join(root, 'src/services/opencode/compatibility');
  await mkdir(directory, { recursive: true });
  const contract = { range: { minimum: '2.0.0', below: '3.0.0' }, qualified };
  const recorded = [...new Set(Object.values(qualified).flat())].sort(order);
  await writeFile(path.join(directory, 'OpenCodeV2Registry.ts'), [
    "export const openCodeV2Wire = (version) => version === '2.0.0' ? 'floor' : 'current';",
    `export const openCodeV2ReleaseContract = () => (${JSON.stringify(contract)});`,
    `export const openCodeV2QualifiedVersions = () => ${JSON.stringify(recorded)};`,
  ].join('\n'));
  return root;
}

function resolvePins(sdk: string, versions: string, platform?: string) {
  // A synchronous child blocks the test timer; bound it explicitly.
  const child = spawnSync(process.execPath, [script, sdk, versions, ...(platform ? [platform] : [])], { encoding: 'utf8', timeout: 10_000 });
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
  it('targets ARM64 only when the newest V2 release is qualified for ARM64', async () => {
    const result = resolvePins(await sdkWith({ 'win32-x64': ['2.1.4'], 'win32-arm64': ['2.1.4'] }), 'current', 'win32-arm64');
    expect(result.status).toBe(0);
    expect(result.outputs).toMatchObject({ current: '2.1.4' });
    expect(JSON.parse(result.outputs.contract!)).toMatchObject({ qualified: { 'win32-arm64': ['2.1.4'] } });
    const unqualified = resolvePins(await sdkWith({ 'win32-x64': ['2.1.4'], 'win32-arm64': [] }), 'current', 'win32-arm64');
    expect(unqualified.status).not.toBe(0);
    expect(unqualified.stderr).toContain('Newest OpenCode V2 2.1.4 is not qualified for win32-arm64');
    expect(unqualified.outputs).toEqual({});
  });

  it.each(['all', 'v1'])('refuses ARM64 %s before reading the SDK', (versions) => {
    const result = resolvePins(path.join(os.tmpdir(), 'TEST-windows-pins-missing-sdk'), versions, 'win32-arm64');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Windows ARM64 qualifies V2 only');
    expect(result.outputs).toEqual({});
  });

  it('targets the newest recorded V2 release once the runtime qualifies it for Windows', async () => {
    const result = resolvePins(await sdkWith({ 'darwin-arm64': ['2.0.0', '2.1.4'], 'win32-x64': ['2.0.0', '2.0.32', '2.1.4'] }), 'all');
    expect(result.status).toBe(0);
    expect(result.outputs).toMatchObject({ v1: '1.19.0', current: '2.1.4' });
    expect(result.outputs).not.toHaveProperty('floor');
    // The staged candidate pins exactly the runtime's published contract.
    expect(JSON.parse(result.outputs.contract!)).toMatchObject({ qualified: { 'win32-x64': ['2.0.0', '2.0.32', '2.1.4'] } });
  });

  it('refuses a runtime that does not qualify the newest V2 release for Windows', async () => {
    const result = resolvePins(await sdkWith({ 'darwin-arm64': ['2.0.0', '2.0.32', '2.1.4'], 'win32-x64': ['2.0.0', '2.0.32'] }), 'current');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Newest OpenCode V2 2.1.4 is not qualified for win32-x64');
    expect(result.outputs).toEqual({});
  });

  it('never reads the runtime for V1-only runs and rejects other selections', async () => {
    const result = resolvePins(path.join(os.tmpdir(), 'TEST-windows-pins-missing-sdk'), 'v1');
    expect(result.status).toBe(0);
    expect(result.outputs).toEqual({ v1: '1.19.0' });
    const v2 = resolvePins(await sdkWith({ 'win32-x64': ['2.1.4'] }), 'v2');
    expect(v2.status).not.toBe(0);
    expect(v2.stderr).toContain('Unknown Windows version selection');
  });

  it('fails closed without a current-wire release, without the registry or with an invalid contract', async () => {
    const floorOnly = resolvePins(await sdkWith({ 'win32-x64': ['2.0.0'] }), 'current');
    expect(floorOnly.status).not.toBe(0);
    expect(floorOnly.stderr).toContain('records no current-wire V2 release');
    const unpinned = resolvePins(await sdkWith(null), 'current');
    expect(unpinned.status).not.toBe(0);
    expect(unpinned.stderr).toContain('predates the OpenCode V2 registry');
    expect(unpinned.outputs).toEqual({});
    // The packaged app would reject an unsorted contract; fail before packaging instead.
    const unsorted = resolvePins(await sdkWith({ 'win32-x64': ['2.1.4', '2.0.32'] }), 'all');
    expect(unsorted.status).not.toBe(0);
    expect(unsorted.stderr).toContain('not a valid app contract');
  });
});
