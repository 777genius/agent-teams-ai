// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import packageJson from '../../../package.json';

const {
  buildElectronBuilderInvocations,
  buildNativeRebuildPlan,
  buildNativeRestorePlan,
  isRetryableAppleNotaryNetworkFailure,
  isRetryableDmgDetachFailure,
  runElectronBuilderOnce,
  runWithPackagingRetry,
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

  it('assigns a clustered short-flag target list only to the final platform', () => {
    expect(buildElectronBuilderInvocations(['-mw', 'nsis:arm64'], 'darwin', 'x64')).toEqual([
      { args: ['--mac'] },
      {
        args: [
          '--win',
          'nsis:arm64',
          '--config.nsis.artifactName=Agent.Teams.AI.Setup.${version}-arm64.${ext}',
        ],
      },
    ]);
    expect(buildElectronBuilderInvocations(['-mwl=AppImage'], 'darwin', 'x64')).toEqual([
      { args: ['--mac'] },
      { args: ['--win'] },
      {
        args: [
          '--linux',
          'AppImage',
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
      buildNativeRebuildPlan(['--win', 'nsis', 'portable:arm64'], 'win32', 'x64')
    ).toThrow('multiple architectures in one invocation are unsupported');
    expect(() =>
      buildElectronBuilderInvocations(
        ['--win', 'nsis', 'portable:arm64'],
        'win32',
        'x64'
      )
    ).toThrow('multiple architectures in one invocation are unsupported');
  });

  it('does not apply a global architecture flag to a fully qualified target list', () => {
    expect(buildNativeRebuildPlan(['--win', 'nsis:x64', '--arm64'], 'win32', 'arm64')).toEqual({
      platform: 'win32',
      arch: 'x64',
      modules: ['better-sqlite3', 'cpu-features'],
    });
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

describe('electron-builder transient packaging retry', () => {
  const detachFailureOutput =
    "dmgbuild.core.DMGError: Unable to detach device cleanly: hdiutil: couldn't eject \"disk2\" - Resource busy";

  function detachFlakeError(): Error & { output?: string } {
    const error: Error & { output?: string } = new Error(
      'electron-builder failed with exit code 1'
    );
    error.output = detachFailureOutput;
    return error;
  }

  it('classifies the dmgbuild clean-detach failure from packaged CI run 39495942432', () => {
    expect(isRetryableDmgDetachFailure(detachFailureOutput)).toBe(true);
    expect(
      isRetryableDmgDetachFailure("hdiutil: couldn't eject \"disk2\" - Resource busy")
    ).toBe(true);
    expect(
      isRetryableDmgDetachFailure('Exit code: 1. Command failed: /cache/dmgbuild -s 2.json')
    ).toBe(false);
  });

  it('retries once after a detach flake and resolves the second attempt', async () => {
    const calls: number[] = [];
    const result = await runWithPackagingRetry(
      (attempt: number) => {
        calls.push(attempt);
        if (attempt === 1) {
          throw detachFlakeError();
        }
        return 'packaged';
      },
      { delayMs: 0, log: { warn: () => undefined } }
    );

    expect(result).toBe('packaged');
    expect(calls).toEqual([1, 2]);
  });

  it('does not retry failures that are not detach flakes', async () => {
    const calls: number[] = [];
    const failure: Error & { output?: string } = new Error(
      'electron-builder failed with exit code 1'
    );
    failure.output = 'Found incompatible native binaries in win32-arm64 bundle after pruning';

    await expect(
      runWithPackagingRetry(
        (attempt: number) => {
          calls.push(attempt);
          throw failure;
        },
        { delayMs: 0, log: { warn: () => undefined } }
      )
    ).rejects.toBe(failure);
    expect(calls).toEqual([1]);
  });

  it('retries notarization and stapling only after Apple transport failures', async () => {
    // Shapes taken from Release run 40142955746 (macOS x64 attempts 1 and 5, arm64 attempt 1).
    const pollFailure = (code: string, text: string) =>
      `  ⨯ Failed to notarize via notarytool.  Failed with unexpected result: \n\nError: HTTPError(statusCode: nil, error: Error Domain=NSURLErrorDomain Code=${code} "${text}" UserInfo={...})  failedTask=build`;
    const pollOffline = pollFailure('-1009', 'The Internet connection appears to be offline.');
    const pollTimedOut = pollFailure('-1001', 'The request timed out.');
    const stapleLost = [
      '  ⨯ Failed to staple your application with code: 68',
      '',
      'Processing: /work/release/mac-arm64/Agent Teams AI.app',
      'Domain is api.apple-cloudkit.com',
      'Response is (null)',
      'error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."',
      "CloudKit's response is inconsistent with expections: (null)",
      'The staple and validate action failed! Error 68.',
    ].join('\n');
    // A rejection is parsed JSON; a network error while fetching its log must not make it retryable.
    const rejectedWithLogNetworkError = [
      '  ⨯ Failed to notarize via notarytool',
      '',
      '{"id":"11d1990d","status":"Invalid","message":"Processing complete"}',
      '',
      'Diagnostics from notarytool log: Error: HTTPError(statusCode: nil, error: Error Domain=NSURLErrorDomain Code=-1009 "The Internet connection appears to be offline.")',
    ].join('\n');
    const unauthorizedAfterEarlierNetworkNoise = [
      'downloading electron: Error Domain=NSURLErrorDomain Code=-1001 "The request timed out."',
      '  ⨯ Failed to notarize via notarytool.  Failed with unexpected result: ',
      '',
      'Error: HTTPError(statusCode: Optional(401), error: unauthorized)',
    ].join('\n');
    const pollTlsFailure = pollFailure('-1200', 'An SSL error has occurred.');
    const stapleMissingTicket = [
      '  ⨯ Failed to staple your application with code: 65',
      '',
      'Could not find base64 encoded ticket in response for 2/2/abc',
      'The staple and validate action failed! Error 65.',
      'later: error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."',
    ].join('\n');
    const unrelatedNetwork =
      'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost." while downloading electron';

    for (const output of [pollOffline, pollTimedOut, stapleLost]) {
      expect(isRetryableAppleNotaryNetworkFailure(output)).toBe(true);
    }
    for (const output of [
      rejectedWithLogNetworkError,
      unauthorizedAfterEarlierNetworkNoise,
      pollTlsFailure,
      stapleMissingTicket,
      unrelatedNetwork,
    ]) {
      expect(isRetryableAppleNotaryNetworkFailure(output)).toBe(false);
    }

    const calls: number[] = [];
    const warnings: string[] = [];
    const result = await runWithPackagingRetry(
      (attempt: number) => {
        calls.push(attempt);
        if (attempt === 1) {
          const error: Error & { output?: string } = new Error(
            'electron-builder failed with exit code 1'
          );
          error.output = pollTimedOut;
          throw error;
        }
        return 'notarized';
      },
      { delayMs: 0, log: { warn: (message: string) => warnings.push(message) } }
    );

    expect(result).toBe('notarized');
    expect(calls).toEqual([1, 2]);
    expect(warnings).toEqual([
      '[electron-builder] Apple notarization network failure detected (attempt 1/2); retrying in 0ms',
    ]);
  });

  it('captures stderr written after exit so late detach flakes classify as retryable', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-cli-capture-'));
    const cliPath = path.join(tempDir, 'fake-cli.cjs');
    fs.writeFileSync(
      cliPath,
      [
        "const { spawn } = require('node:child_process');",
        '// Keep the inherited stderr pipe open past this process exit and write the',
        '// detach failure late, so exit-based capture would miss it.',
        "spawn(process.execPath, ['-e', `setTimeout(() => { console.error('dmgbuild.core.DMGError: Unable to detach device cleanly'); }, 400)`], {",
        "  stdio: ['ignore', 'inherit', 'inherit'],",
        '});',
        'process.exit(1);',
        '',
      ].join('\n')
    );

    try {
      let failure: (Error & { output?: string }) | undefined;
      try {
        await runElectronBuilderOnce(cliPath, []);
      } catch (error) {
        failure = error as Error & { output?: string };
      }
      expect(failure).toBeDefined();
      expect(failure?.output).toContain('Unable to detach device cleanly');
      expect(
        isRetryableDmgDetachFailure(`${failure?.message ?? ''}\n${failure?.output ?? ''}`)
      ).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('stops after the attempt budget when the volume stays busy', async () => {
    const calls: number[] = [];

    await expect(
      runWithPackagingRetry(
        (attempt: number) => {
          calls.push(attempt);
          throw detachFlakeError();
        },
        { delayMs: 0, log: { warn: () => undefined } }
      )
    ).rejects.toThrow('electron-builder failed with exit code 1');
    expect(calls).toEqual([1, 2]);
  });
});
