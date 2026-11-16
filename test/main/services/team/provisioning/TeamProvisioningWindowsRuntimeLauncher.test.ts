import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveWindowsTeamRuntimeLauncher } from '@main/services/team/provisioning/TeamProvisioningWindowsRuntimeLauncher';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teammate-job-wrapper-'));
  roots.push(root);
  const binaryPath = path.join(root, 'runtime', 'claude-multimodel.exe');
  const wrapperPath = path.join(root, 'runtime', 'teammate-console', 'teammate.exe');
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, 'runtime');
  return { root, binaryPath, wrapperPath };
}

describe('Windows team runtime Job launcher', () => {
  it('selects separately staged wrapper and retains original binary', () => {
    const { root, binaryPath, wrapperPath } = sandbox();
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
    fs.writeFileSync(wrapperPath, 'managed-wrapper');
    expect(resolveWindowsTeamRuntimeLauncher(binaryPath, {
      platform: 'win32', resourcesPath: root, requireWrapper: true,
    })).toEqual({
      binaryPath: wrapperPath,
      targetEnv: { AGENT_TEAMS_TEAMMATE_WRAPPER_TARGET: binaryPath },
    });
  });

  it('preserves non-Windows spawn behavior', () => {
    const { root, binaryPath } = sandbox();
    expect(resolveWindowsTeamRuntimeLauncher(binaryPath, {
      platform: 'linux', resourcesPath: root, requireWrapper: true,
    })).toEqual({ binaryPath });
  });

  it('fails closed for required missing wrapper and preserves optional dev fallback', () => {
    const { root, binaryPath } = sandbox();
    expect(() => resolveWindowsTeamRuntimeLauncher(binaryPath, {
      platform: 'win32', resourcesPath: root, requireWrapper: true,
    })).toThrow('Required Windows teammate Job wrapper is missing');
    expect(resolveWindowsTeamRuntimeLauncher(binaryPath, {
      platform: 'win32', resourcesPath: root,
    })).toEqual({ binaryPath });
  });

  it('rejects a directory masquerading as wrapper', () => {
    const { root, binaryPath, wrapperPath } = sandbox();
    fs.mkdirSync(wrapperPath, { recursive: true });
    expect(() => resolveWindowsTeamRuntimeLauncher(binaryPath, {
      platform: 'win32', resourcesPath: root, requireWrapper: true,
    })).toThrow('Required Windows teammate Job wrapper is missing');
  });

  it('fails closed for non-absolute or non-exe target in strict mode', () => {
    const { root } = sandbox();
    expect(() => resolveWindowsTeamRuntimeLauncher('relative.cmd', {
      platform: 'win32', resourcesPath: root, requireWrapper: true,
    })).toThrow('Required Windows teammate Job wrapper needs an absolute .exe target');
  });
});
