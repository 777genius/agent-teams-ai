// @vitest-environment node
import { describe, expect, it } from 'vitest';

const { buildElectronBuilderInvocations } = require('../../../scripts/electron-builder/dist-invocations.cjs');

describe('electron-builder dist wrapper', () => {
  it('splits multi-platform builds so Linux-only package name overrides do not affect macOS or Windows', async () => {
    expect(
      buildElectronBuilderInvocations(['--mac', '--win', '--linux', '--publish', 'never'])
    ).toEqual([
      { args: ['--mac', '--publish', 'never'] },
      { args: ['--win', '--publish', 'never'] },
      {
        args: [
          '--linux',
          '--publish',
          'never',
          '--config.productName=Agent-Teams-UI',
          '--config.linux.desktop.entry.Name=Agent Teams UI',
        ],
      },
    ]);
  });

  it('adds the filesystem-safe package name override to Linux-only builds', async () => {
    expect(buildElectronBuilderInvocations(['--linux', '--publish', 'never'])).toEqual([
      {
        args: [
          '--linux',
          '--publish',
          'never',
          '--config.productName=Agent-Teams-UI',
          '--config.linux.desktop.entry.Name=Agent Teams UI',
        ],
      },
    ]);
  });

  it('leaves macOS arch-specific builds unchanged', async () => {
    expect(buildElectronBuilderInvocations(['--mac', '--arm64', '--publish', 'never'])).toEqual([
      { args: ['--mac', '--arm64', '--publish', 'never'] },
    ]);
  });
});
