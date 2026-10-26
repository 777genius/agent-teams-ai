// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createMcpDeploymentManifest } from '../../../mcp-server/deploymentManifest';

const { isAllowedPostPackMismatch, verifyBundledMcpServer } =
  require('../../../scripts/electron-builder/verifyBundle.cjs')._internal;

const mcpSource = JSON.parse(
  readFileSync(new URL('../../../mcp-server/package.json', import.meta.url), 'utf8')
);
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function mcpBundle(platform: string, manifest: unknown) {
  const root = mkdtempSync(path.join(tmpdir(), 'TEST-packaged-mcp-'));
  fixtureRoots.push(root);
  const directory = path.join(root, platform === 'darwin' ? 'Contents/Resources' : 'resources', 'mcp-server');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'index.js'), 'export const ready = true;\n');
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));
  return { root, directory };
}

const elevateMismatch = {
  path: 'resources/elevate.exe',
  format: 'pe',
  archs: ['ia32'],
};

describe('electron-builder bundle verification', () => {
  it.each(['darwin', 'win32', 'linux'])('resolves the self-contained MCP bundle on %s without a workspace install', (platform) => {
    const { root, directory } = mcpBundle(platform, createMcpDeploymentManifest(mcpSource));
    expect(() => verifyBundledMcpServer(root, platform)).not.toThrow();
    expect(createRequire(path.join(directory, 'consumer.cjs')).resolve(directory)).toBe(
      realpathSync(path.join(directory, 'index.js'))
    );
  });

  it.each([
    { name: 'source manifest', manifest: mcpSource },
    { name: 'uninstalled workspace dependency', manifest: { ...mcpSource, main: 'index.js' } },
  ])('rejects $name before an installed V2 controller graph can fail', ({ manifest }) => {
    const { root } = mcpBundle('darwin', manifest);
    expect(() => verifyBundledMcpServer(root, 'darwin')).toThrow('self-contained deployment manifest');
  });

  it('allows the known NSIS elevation helper for supported Windows architectures', () => {
    expect(isAllowedPostPackMismatch(elevateMismatch, 'win32', 'x64')).toBe(true);
    expect(isAllowedPostPackMismatch(elevateMismatch, 'win32', 'arm64')).toBe(true);
  });

  it('keeps the elevation helper exception fail-closed', () => {
    expect(isAllowedPostPackMismatch(elevateMismatch, 'win32', 'ia32')).toBe(false);
    expect(isAllowedPostPackMismatch(elevateMismatch, 'linux', 'arm64')).toBe(false);
    expect(
      isAllowedPostPackMismatch(
        { ...elevateMismatch, path: 'resources/other-helper.exe' },
        'win32',
        'arm64'
      )
    ).toBe(false);
    expect(
      isAllowedPostPackMismatch({ ...elevateMismatch, archs: ['x64'] }, 'win32', 'arm64')
    ).toBe(false);
  });
});
