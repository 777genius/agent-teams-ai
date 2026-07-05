import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCodexRuntimeTempRoot } from '../codex-runtime-temp';

describe('createCodexRuntimeTempRoot', () => {
  it('uses SUBSCRIPTION_RUNTIME_TMPDIR when provided', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-runtime-explicit-'));
    try {
      const tempRoot = await createCodexRuntimeTempRoot({
        prefix: 'subscription-runtime-codex-',
        sourceEnv: { SUBSCRIPTION_RUNTIME_TMPDIR: root },
      });
      expect(tempRoot.startsWith(join(root, 'subscription-runtime-codex-'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to job-local tmp without dirtying the workspace', async () => {
    const jobRoot = await mkdtemp(join(tmpdir(), 'codex-runtime-job-'));
    try {
      const tempRoot = await createCodexRuntimeTempRoot({
        prefix: 'subscription-runtime-codex-',
        sourceEnv: { SUBSCRIPTION_RUNTIME_JOB_ROOT: jobRoot },
      });
      expect(tempRoot.startsWith(join(jobRoot, 'tmp', 'subscription-runtime-codex-'))).toBe(true);
    } finally {
      await rm(jobRoot, { recursive: true, force: true });
    }
  });
});
