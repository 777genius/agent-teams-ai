import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileClaudeStateProbe } from '@features/workspace-trust/main/adapters/output/ClaudeStateProbe';
import { buildWorkspaceTrustPathCandidates } from '@features/workspace-trust/core/domain';

let tmpDir: string | null = null;

async function makeTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-trust-probe-'));
  return tmpDir;
}

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe('FileClaudeStateProbe', () => {
  it('reads the explicit global config file path used by the runtime default profile', async () => {
    const dir = await makeTmpDir();
    const globalConfigFilePath = path.join(dir, '.claude.json');
    await fs.writeFile(
      globalConfigFilePath,
      JSON.stringify({
        projects: {
          '/tmp/project': {
            hasTrustDialogAccepted: true,
          },
        },
      }),
      'utf8'
    );

    const workspace = buildWorkspaceTrustPathCandidates({
      cwd: '/tmp/project/app',
      platform: 'posix',
    })[0];
    const result = await new FileClaudeStateProbe({ globalConfigFilePath }).readTrustState(
      workspace
    );

    expect(result).toEqual({
      status: 'trusted',
      evidence: ['trusted project key: /tmp/project'],
    });
  });
});
