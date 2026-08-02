// @vitest-environment node
import { describe, expect, it } from 'vitest';

const {
  buildElectronBuilderInvocations,
  buildNativeRebuildPlan,
  buildNativeRestorePlan,
  runWithNativeDependencyRestore,
} = require('../../../scripts/electron-builder/dist-invocations.cjs');

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

  it('rebuilds better-sqlite3 for native Windows ARM64 packaging', () => {
    expect(buildNativeRebuildPlan(['--win', '--arm64', '--publish', 'never'])).toEqual({
      platform: 'win32',
      arch: 'arm64',
      modules: ['better-sqlite3'],
    });
  });

  it('does not rebuild Windows ARM64 dependencies for other package targets', () => {
    expect(buildNativeRebuildPlan(['--win', '--x64'])).toBeNull();
    expect(buildNativeRebuildPlan(['--mac', '--arm64'])).toBeNull();
  });

  it('restores host native dependencies after cross-architecture packaging', () => {
    const targetPlan = buildNativeRebuildPlan(['--win', '--arm64']);

    expect(buildNativeRestorePlan(targetPlan, 'win32', 'x64')).toEqual({
      platform: 'win32',
      arch: 'x64',
      modules: ['better-sqlite3'],
    });
    expect(buildNativeRestorePlan(targetPlan, 'darwin', 'arm64')).toEqual({
      platform: 'darwin',
      arch: 'arm64',
      modules: ['better-sqlite3'],
    });
    expect(buildNativeRestorePlan(targetPlan, 'win32', 'arm64')).toBeNull();
  });

  it('restores host native dependencies when packaging fails', async () => {
    const targetPlan = buildNativeRebuildPlan(['--win', '--arm64']);
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
    const targetPlan = buildNativeRebuildPlan(['--win', '--arm64']);
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
    const targetPlan = buildNativeRebuildPlan(['--win', '--arm64']);
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
