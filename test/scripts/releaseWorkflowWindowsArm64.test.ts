// @vitest-environment node
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface ReleaseWorkflow {
  jobs?: {
    'verify-public-runtime'?: {
      strategy?: { matrix?: { include?: Array<Record<string, string>> } };
    };
    'release-win'?: {
      strategy?: { matrix?: { include?: Array<Record<string, string>> } };
      steps?: WorkflowStep[];
    };
  };
}

describe('Windows release workflow', () => {
  it('builds and publishes native x64 and ARM64 installers', async () => {
    const source = await readFile('.github/workflows/release.yml', 'utf8');
    const workflow = parse(source) as ReleaseWorkflow;
    const runtimeVerificationTargets =
      workflow.jobs?.['verify-public-runtime']?.strategy?.matrix?.include;
    const releaseJob = workflow.jobs?.['release-win'];
    const targets = releaseJob?.strategy?.matrix?.include;

    expect(targets).toEqual([
      {
        arch: 'x64',
        runner: 'windows-latest',
        runtime_platform: 'win32-x64',
        bundle_directory: 'win-unpacked',
      },
      {
        arch: 'arm64',
        runner: 'windows-11-arm',
        runtime_platform: 'win32-arm64',
        bundle_directory: 'win-arm64-unpacked',
      },
    ]);
    expect(runtimeVerificationTargets).toContainEqual({
      platform: 'win32-arm64',
      runner: 'windows-11-arm',
    });

    const commands = (releaseJob?.steps ?? []).map((step) => step.run ?? '').join('\n');
    expect(commands).toContain('stage-runtime.mjs --platform ${{ matrix.runtime_platform }}');
    expect(commands).toContain(
      'stage-terminal-platform-runtime.mjs --platform ${{ matrix.runtime_platform }}'
    );
    expect(commands).toContain('pnpm pack:win:${{ matrix.arch }} --publish never');
    expect(commands).toContain(
      'verifyBundle.cjs "release/${{ matrix.bundle_directory }}" win32 ${{ matrix.arch }}'
    );
  });
});
