import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createHostedOpenCodeRuntimeComposition } from '@main/composition/hosted/hostedOpenCodeRuntimeComposition';

describe('hosted OpenCode runtime composition', () => {
  it('reaches the hosted-only resolver and fails closed on the checked-in unavailable pin', async () => {
    const lock = JSON.parse(
      await fs.readFile(path.resolve('opencode-hosted-runtime.lock.json'), 'utf8')
    );
    process.env.OPENCODE_BIN_PATH = '/user-controlled/opencode';
    const composition = createHostedOpenCodeRuntimeComposition({
      runtimeRoot: '/not-used-for-unavailable-artifact',
      loadLock: async () => lock,
      platform: 'linux',
      arch: 'x64',
    });
    await expect(composition.resolveBinary()).rejects.toThrow(
      'hosted_opencode_artifact_unavailable:linux-x64'
    );
    await expect(composition.install()).rejects.toThrow(
      'hosted_opencode_artifact_unavailable:linux-x64'
    );
  });
});
