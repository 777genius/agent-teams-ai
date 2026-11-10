// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  runProbe,
  runtimeEnvironment,
} from '../../../scripts/electron-builder/smokePackagedRuntime.ts';

// Real, disposable Node processes exercise the owner's retirement protocol.
// The five-platform packaged jobs separately prove the actual Bun/native payload.
async function lifecycleFixture(
  retainChild: boolean,
  check: (project: string, run: () => ReturnType<typeof runProbe>) => Promise<void>
) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-lifecycle-TEST-')));
  const childFile = path.join(project, 'child.cjs');
  const ownerFile = path.join(project, 'owner.cjs');
  fs.writeFileSync(path.join(project, '.test-only'), 'owned-process-lifecycle\n');
  fs.writeFileSync(
    childFile,
    `const fs = require('node:fs');
process.on('disconnect', () => {
  fs.writeFileSync('child-owner-disconnected', 'observed\\n');
  ${retainChild ? 'setInterval(() => {}, 1000);' : ''}
});
process.send({ ready: true });
`
  );
  fs.writeFileSync(
    ownerFile,
    `const fs = require('node:fs');
const { spawn } = require('node:child_process');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(name) {
  while (!fs.existsSync(name)) await pause(25);
}
(async () => {
  await waitFor('runtime-start');
  const child = spawn(process.execPath, [${JSON.stringify(childFile)}], {
    cwd: process.cwd(), env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('message', resolve);
  });
  fs.writeFileSync('fixture-child-pid', String(child.pid));
  child.unref();
  child.channel.unref();
  console.log('PACKAGED_RUNTIME_OK ' + JSON.stringify({ lifecycleFixture: true }));
  await waitFor('runtime-exit');
  fs.writeFileSync('owner-natural-return', 'observed\\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
`
  );
  try {
    const env = runtimeEnvironment(process.env, project);
    await check(project, () => runProbe(process.execPath, [ownerFile], env, project));
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
}

describe('packaged runtime owner lifecycle', () => {
  it('lets an observed owner-dependent child retire after the owner naturally returns', async () => {
    await lifecycleFixture(false, async (project, run) => {
      const result = await run();
      const childPid = Number(fs.readFileSync(path.join(project, 'fixture-child-pid'), 'utf8'));
      expect(result.evidence).toEqual({ lifecycleFixture: true });
      expect(result.naturalExit).toEqual({ code: 0, signal: null });
      const child = result.beforeExitCensus.find((entry) => entry.pid === childPid);
      expect(child?.birth).toBeTruthy();
      expect(result.beforeExitCensus.some((entry) => entry.pid === child?.parent)).toBe(true);
      expect(result.naturalFinalization.remaining).toEqual([]);
      expect(result.naturalFinalization.commands).toEqual([]);
      expect(result.naturalFinalization.observed.some((entry) => entry.pid === childPid)).toBe(true);
      expect(fs.readFileSync(path.join(project, 'owner-natural-return'), 'utf8')).toBe('observed\n');
      expect(fs.readFileSync(path.join(project, 'child-owner-disconnected'), 'utf8')).toBe('observed\n');
    });
  }, 20_000);

  it('rejects a child that survives the natural owner exit and cleans up only after failure', async () => {
    const failure = vi.spyOn(console, 'error');
    try {
      await lifecycleFixture(true, async (project, run) => {
        await expect(run()).rejects.toThrow('Runtime processes did not settle naturally');
        const childPid = Number(fs.readFileSync(path.join(project, 'fixture-child-pid'), 'utf8'));
        const prefix = '[smokePackagedRuntime] FAILURE ';
        const line = failure.mock.calls.find(([value]) => String(value).startsWith(prefix));
        expect(line).toBeDefined();
        const diagnostic = JSON.parse(String(line![0]).slice(prefix.length));
        expect(diagnostic.phase).toBe('natural-tree-retirement');
        expect(diagnostic.evidence).toEqual({ lifecycleFixture: true });
        expect(diagnostic.naturalExit).toEqual({ code: 0, signal: null });
        expect(diagnostic.remaining.some((entry: { pid: number }) => entry.pid === childPid)).toBe(true);
        expect(fs.readFileSync(path.join(project, 'owner-natural-return'), 'utf8')).toBe('observed\n');
        expect(fs.readFileSync(path.join(project, 'child-owner-disconnected'), 'utf8')).toBe('observed\n');
        expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      });
    } finally {
      failure.mockRestore();
    }
  }, 20_000);
});
