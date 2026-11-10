import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Probe only base availability in an owned sandbox with optional support absent. */
export function smokeExternalOpenCodeV2Base(
  binaryPath: string,
  runtimeEnvironment: (parent: NodeJS.ProcessEnv, project: string) => NodeJS.ProcessEnv
): void {
  const project = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-external-base-TEST-'))
  );
  try {
    const env = runtimeEnvironment(process.env, project);
    env.CLAUDE_MULTIMODEL_OPENCODE_V2_SUPPORT_ROOT = path.join(project, 'support-absent');
    const status = spawnSync(
      binaryPath,
      ['runtime', 'status', '--provider', 'opencode', '--json'],
      {
        cwd: project,
        env,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 4_194_304,
        windowsHide: true,
      }
    );
    assert.equal(status.status, 0, `Graph-free base runtime status failed: ${status.stderr}`);
    assert.equal(
      JSON.parse(status.stdout).schemaVersion,
      2,
      'Graph-free base did not answer runtime status'
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
}
