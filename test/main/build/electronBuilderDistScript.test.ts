// @vitest-environment node
import { describe, expect, it } from 'vitest';

import packageJson from '../../../package.json';

const {
  buildElectronBuilderInvocations,
  buildNativeRebuildPlan,
  buildNativeRestorePlan,
  runWithNativeDependencyRestore,
} = require('../../../scripts/electron-builder/dist-invocations.cjs');

describe('electron-builder dist wrapper', () => {
  it('splits multi-platform builds so Linux-only package name overrides do not affect macOS or Windows', async () => {
    expect(
      buildElectronBuilderInvocations(
        ['--mac', '--win', '--linux', '--publish', 'never'],
        'darwin',
        'x64'
      )
    ).toEqual([
      { args: ['--mac', '--publish', 'never'] },
      { args: ['--win', '--publish', 'never'] },
      {
        args: [
          '--linux',
          '--publish',
          'never',
          '--config.productName=Agent-Teams-AI',
          '--config.linux.desktop.entry.Name=Agent Teams AI',
        ],
      },
    ]);
  });

  it('normalizes documented platform aliases and combined short flags', () => {
    expect(buildElectronBuilderInvocations(['--macos', '--windows'], 'darwin', 'x64')).toEqual([
      { args: ['--mac'] },
      { args: ['--win'] },
    ]);
    expect(buildElectronBuilderInvocations(['-mwl'], 'darwin', 'x64')).toEqual([
      { args: ['--mac'] },
      { args: ['--win'] },
      {
        args: [
          '--linux',
          '--config.productName=Agent-Teams-AI',
          '--config.linux.desktop.entry.Name=Agent Teams AI',
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
          '--config.productName=Agent-Teams-AI',
          '--config.linux.desktop.entry.Name=Agent Teams AI',
        ],
      },
    ]);
  });

  it('leaves macOS arch-specific builds unchanged', async () => {
    expect(buildElectronBuilderInvocations(['--mac', '--arm64', '--publish', 'never'])).toEqual([
      { args: ['--mac', '--arm64', '--publish', 'never'] },
    ]);
  });

  it('uses a distinct installer name for Windows ARM64 packages', () => {
    expect(buildElectronBuilderInvocations(['--win', '--arm64', '--publish', 'never'])).toEqual([
      {
        args: [
          '--win',
          '--arm64',
          '--publish',
          'never',
          '--config.nsis.artifactName=Agent.Teams.AI.Setup.${version}-arm64.${ext}',
        ],
      },
    ]);
  });

  it('matches electron-builder boolean architecture flag values', () => {
    expect(buildElectronBuilderInvocations(['--win', '--arm64=true'], 'win32', 'x64')).toEqual([
      {
        args: [
          '--win',
          '--arm64=true',
          '--config.nsis.artifactName=Agent.Teams.AI.Setup.${version}-arm64.${ext}',
        ],
      },
    ]);
    expect(buildNativeRebuildPlan(['--win', '--arm64=true'], 'win32', 'x64')).toEqual({
      platform: 'win32',
      arch: 'arm64',
      modules: ['better-sqlite3', 'cpu-features'],
    });

    expect(buildElectronBuilderInvocations(['--win', '--arm64', 'false'], 'win32', 'x64')).toEqual([
      { args: ['--win', '--arm64', 'false'] },
    ]);
    expect(buildNativeRebuildPlan(['--win', '--arm64', 'false'], 'win32', 'x64')).toBeNull();
    expect(buildNativeRebuildPlan(['--win', '--arm64=false'], 'win32', 'x64')).toBeNull();
  });

  it('preserves a space-separated Windows artifact name override', () => {
    expect(
      buildElectronBuilderInvocations(
        ['--win', '--arm64', '--config.nsis.artifactName', 'custom.exe'],
        'win32',
        'x64'
      )
    ).toEqual([
      {
        args: ['--win', '--arm64', '--config.nsis.artifactName', 'custom.exe'],
      },
    ]);
  });

  it('uses the ARM64 installer name for a host-default Windows ARM64 target', () => {
    expect(
      buildElectronBuilderInvocations(['--win', '--publish', 'never'], 'win32', 'arm64')
    ).toEqual([
      {
        args: [
          '--win',
          '--publish',
          'never',
          '--config.nsis.artifactName=Agent.Teams.AI.Setup.${version}-arm64.${ext}',
        ],
      },
    ]);

    expect(buildElectronBuilderInvocations(['--publish', 'never'], 'win32', 'arm64')).toEqual([
      {
        args: [
          '--publish',
          'never',
          '--config.nsis.artifactName=Agent.Teams.AI.Setup.${version}-arm64.${ext}',
        ],
      },
    ]);
  });

  it('recognizes architecture-qualified Windows target names', () => {
    expect(
      buildElectronBuilderInvocations(
        ['--win', 'nsis:arm64', '--publish', 'never'],
        'win32',
        'x64'
      )
    ).toEqual([
      {
        args: [
          '--win',
          'nsis:arm64',
          '--publish',
          'never',
          '--config.nsis.artifactName=Agent.Teams.AI.Setup.${version}-arm64.${ext}',
        ],
      },
    ]);

    expect(buildNativeRebuildPlan(['--win', 'nsis:arm64'], 'win32', 'x64')).toEqual({
      platform: 'win32',
      arch: 'arm64',
      modules: ['better-sqlite3', 'cpu-features'],
    });
  });

  it('normalizes equals-form architecture-qualified Windows targets', () => {
    expect(
      buildElectronBuilderInvocations(
        ['--windows=nsis:arm64', '--publish', 'never'],
        'win32',
        'x64'
      )
    ).toEqual([
      {
        args: [
          '--win',
          'nsis:arm64',
          '--publish',
          'never',
          '--config.nsis.artifactName=Agent.Teams.AI.Setup.${version}-arm64.${ext}',
        ],
      },
    ]);

    expect(buildNativeRebuildPlan(['--win=nsis:arm64'], 'win32', 'x64')).toEqual({
      platform: 'win32',
      arch: 'arm64',
      modules: ['better-sqlite3', 'cpu-features'],
    });
  });

  it('keeps equals-form target lists scoped to their platform invocation', () => {
    expect(
      buildElectronBuilderInvocations(
        ['--mac=dmg:x64', '--windows=nsis:arm64', '--linux=AppImage', '--publish', 'never'],
        'darwin',
        'arm64'
      )
    ).toEqual([
      { args: ['--mac', 'dmg:x64', '--publish', 'never'] },
      {
        args: [
          '--win',
          'nsis:arm64',
          '--publish',
          'never',
          '--config.nsis.artifactName=Agent.Teams.AI.Setup.${version}-arm64.${ext}',
        ],
      },
      {
        args: [
          '--linux',
          'AppImage',
          '--publish',
          'never',
          '--config.productName=Agent-Teams-AI',
          '--config.linux.desktop.entry.Name=Agent Teams AI',
        ],
      },
    ]);
  });

  it('keeps space-separated target lists scoped to their platform invocation', () => {
    expect(
      buildElectronBuilderInvocations(
        ['--win', 'nsis:arm64', '--linux', 'AppImage', '--publish', 'never'],
        'darwin',
        'x64'
      )
    ).toEqual([
      {
        args: [
          '--win',
          'nsis:arm64',
          '--publish',
          'never',
          '--config.nsis.artifactName=Agent.Teams.AI.Setup.${version}-arm64.${ext}',
        ],
      },
      {
        args: [
          '--linux',
          'AppImage',
          '--publish',
          'never',
          '--config.productName=Agent-Teams-AI',
          '--config.linux.desktop.entry.Name=Agent Teams AI',
        ],
      },
    ]);
  });

  it('rejects mixed-architecture invocations before packaging', () => {
    expect(() =>
      buildElectronBuilderInvocations(
        ['--win', 'nsis:arm64', 'portable:x64'],
        'win32',
        'x64'
      )
    ).toThrow('multiple architectures in one invocation are unsupported');
    expect(() =>
      buildNativeRebuildPlan(['--win', 'nsis:x64', '--arm64'], 'win32', 'x64')
    ).toThrow('multiple architectures in one invocation are unsupported');
  });

  it('does not infer an architecture from unrelated option values', () => {
    expect(
      buildNativeRebuildPlan(
        ['--win', '--config.extraMetadata.channel=preview:arm64'],
        'win32',
        'x64'
      )
    ).toBeNull();
  });

  it('rebuilds packaged native dependencies for Windows ARM64 cross-target packaging', () => {
    expect(
      buildNativeRebuildPlan(
        ['--win', '--arm64', '--publish', 'never'],
        'win32',
        'x64'
      )
    ).toEqual({
      platform: 'win32',
      arch: 'arm64',
      modules: ['better-sqlite3', 'cpu-features'],
    });
  });

  it('recognizes Windows aliases and host-default Windows targets for native rebuilds', () => {
    const expectedPlan = {
      platform: 'win32',
      arch: 'arm64',
      modules: ['better-sqlite3', 'cpu-features'],
    };

    expect(buildNativeRebuildPlan(['--windows', '--arm64'], 'win32', 'x64')).toEqual(
      expectedPlan
    );
    expect(buildNativeRebuildPlan(['--arm64'], 'win32', 'x64')).toEqual(expectedPlan);
  });

  it('rebuilds packaged native dependencies for Windows x64 packaging on an ARM64 host', () => {
    expect(buildNativeRebuildPlan(['--win', '--x64'], 'win32', 'arm64')).toEqual({
      platform: 'win32',
      arch: 'x64',
      modules: ['better-sqlite3', 'cpu-features'],
    });
  });

  it('does not rebuild native dependencies for a native Windows target or another platform', () => {
    expect(buildNativeRebuildPlan(['--win', '--x64'], 'win32', 'x64')).toBeNull();
    expect(buildNativeRebuildPlan(['--win', '--arm64'], 'win32', 'arm64')).toBeNull();
    expect(buildNativeRebuildPlan(['--mac', '--arm64'], 'win32', 'x64')).toBeNull();
  });

  it('keeps generic Windows package commands explicitly on the x64 release contract', () => {
    expect(packageJson.scripts['pack:win']).toBe(
      'node ./scripts/electron-builder/dist.mjs --win --x64'
    );
    expect(packageJson.scripts['dist:win']).toMatch(/dist\.mjs --win --x64$/);
  });

  it('restores host native dependencies after cross-architecture packaging', () => {
    const targetPlan = buildNativeRebuildPlan(['--win', '--arm64'], 'win32', 'x64');

    expect(buildNativeRestorePlan(targetPlan, 'win32', 'x64')).toEqual({
      platform: 'win32',
      arch: 'x64',
      modules: ['better-sqlite3', 'cpu-features'],
    });
    expect(buildNativeRestorePlan(targetPlan, 'darwin', 'arm64')).toEqual({
      platform: 'darwin',
      arch: 'arm64',
      modules: ['better-sqlite3', 'cpu-features'],
    });
    expect(buildNativeRestorePlan(targetPlan, 'win32', 'arm64')).toBeNull();
  });

  it('restores host native dependencies when packaging fails', async () => {
    const targetPlan = buildNativeRebuildPlan(['--win', '--arm64'], 'win32', 'x64');
    const restorePlan = buildNativeRestorePlan(targetPlan, 'win32', 'x64');
    const calls: string[] = [];

    await expect(
      runWithNativeDependencyRestore({
        targetPlan,
        restorePlan,
        rebuild: async (plan: { arch: string }, phase: string) => {
          calls.push(`${phase}:${plan.arch}`);
        },
        packageTarget: async () => {
          calls.push('package');
          throw new Error('package failed');
        },
      })
    ).rejects.toThrow('package failed');

    expect(calls).toEqual(['target:arm64', 'package', 'restore:x64']);
  });

  it('preserves a packaging failure when restoring host native dependencies also fails', async () => {
    const targetPlan = buildNativeRebuildPlan(['--win', '--arm64'], 'win32', 'x64');
    const restorePlan = buildNativeRestorePlan(targetPlan, 'win32', 'x64');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(
        runWithNativeDependencyRestore({
          targetPlan,
          restorePlan,
          rebuild: async (_plan: { arch: string }, phase: string) => {
            if (phase === 'restore') throw new Error('restore failed');
          },
          packageTarget: async () => {
            throw new Error('package failed');
          },
        })
      ).rejects.toThrow('package failed');

      expect(consoleError).toHaveBeenCalledWith(
        '[electron-builder] failed to restore host native dependencies after build failure',
        expect.objectContaining({ message: 'restore failed' })
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('propagates a host native dependency restore failure after successful packaging', async () => {
    const targetPlan = buildNativeRebuildPlan(['--win', '--arm64'], 'win32', 'x64');
    const restorePlan = buildNativeRestorePlan(targetPlan, 'win32', 'x64');

    await expect(
      runWithNativeDependencyRestore({
        targetPlan,
        restorePlan,
        rebuild: async (_plan: { arch: string }, phase: string) => {
          if (phase === 'restore') throw new Error('restore failed');
        },
        packageTarget: async () => undefined,
      })
    ).rejects.toThrow('restore failed');
  });
});
