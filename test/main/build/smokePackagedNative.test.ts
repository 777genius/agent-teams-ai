// @vitest-environment node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// An inherited preload can change the native probe before it runs. This test
// must fail if any casing of hooks or owned path/mode variables survives.
describe.skipIf(process.platform === 'win32')('packaged native probe isolation', () => {
  it('runs the probe in its own test project without inherited hooks or env aliases', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'native-isolation-TEST-'));
    try {
      const poison = path.join(sandbox, 'inherited-TEST');
      fs.mkdirSync(poison);
      const evidence = path.join(sandbox, 'evidence.json');
      const preloadMarker = path.join(sandbox, 'preload-ran');
      const preload = path.join(sandbox, 'preload-TEST.cjs');
      fs.writeFileSync(
        preload,
        `require('node:fs').writeFileSync(${JSON.stringify(preloadMarker)}, 'ran');`
      );
      // Apply poison after the harness Node starts so only its child is exposed.
      const hook = path.join(sandbox, 'poison-env-TEST.cjs');
      fs.writeFileSync(
        hook,
        `Object.assign(process.env, ${JSON.stringify({
          NODE_OPTIONS: `--require ${preload}`,
          Node_Options: `--require ${preload}`,
          ELECTRON_RUN_AS_NODE: '0',
          Electron_Run_As_Node: '0',
          HOME: poison,
          Home: poison,
          USERPROFILE: poison,
          UserProfile: poison,
        })});`
      );
      fs.mkdirSync(path.join(sandbox, 'resources'));
      fs.writeFileSync(path.join(sandbox, 'resources', 'app.asar'), 'TEST placeholder');
      fs.writeFileSync(
        path.join(sandbox, 'agent-teams-ai'),
        `#!${process.execPath}
        const fs = require('node:fs');
        const path = require('node:path');
        const assert = require('node:assert/strict');
        const root = process.cwd();
        try {
          assert.deepEqual(Object.keys(process.env).filter(key => key.toUpperCase() === 'NODE_OPTIONS'), [], 'no inherited hooks');
          for (const key of ['HOME', 'USERPROFILE', 'ELECTRON_RUN_AS_NODE']) {
            assert.deepEqual(Object.keys(process.env).filter(name => name.toUpperCase() === key), [key], 'no owned env aliases');
          }
          assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1');
          assert.equal(process.env.PATH, ${JSON.stringify(process.env.PATH)}, 'preserve executable search path');
          assert.notEqual(root, fs.realpathSync(${JSON.stringify(sandbox)}));
          assert.equal(fs.realpathSync(process.env.HOME), root);
          assert.equal(process.env.HOME, process.env.USERPROFILE);
          assert.equal(fs.readFileSync(path.join(root, '.test-only'), 'utf8'), 'electron-native-test-v1');
          assert.equal(process.argv[2], '-e');
          assert.equal(fs.realpathSync(process.argv[5]), root, 'probe gets the owned project');
          assert.equal(fs.realpathSync(process.argv[4]), fs.realpathSync(${JSON.stringify(path.join(sandbox, 'resources', 'app.asar'))}));
          fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ root }));
          console.log('PACKAGED_NATIVE_OK TEST-only-native-probe');
        } catch (error) { console.error('TEST isolation failure: ' + error.message); process.exit(9); }
      `,
        { mode: 0o755 }
      );
      const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: sandbox };
      delete env.NODE_OPTIONS;
      const script = path.resolve(
        import.meta.dirname,
        '../../../scripts/electron-builder/smokePackagedNative.cjs'
      );
      const result = spawnSync(process.execPath, ['--require', hook, script, sandbox, 'linux'], {
        cwd: sandbox,
        env,
        encoding: 'utf8',
        timeout: 8_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.stdout + result.stderr).not.toContain('TEST isolation failure');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('[smokePackagedNative] OK linux: PACKAGED_NATIVE_OK');
      const { root } = JSON.parse(fs.readFileSync(evidence, 'utf8')) as { root: string };
      expect(fs.existsSync(root)).toBe(false);
      expect(fs.existsSync(preloadMarker)).toBe(false);
      expect(fs.readdirSync(poison)).toEqual([]);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
