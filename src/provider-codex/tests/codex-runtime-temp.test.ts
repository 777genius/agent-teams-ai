import { lstat, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCodexRuntimeTempRoot, createTrustedCodexRuntimeTempRoot, ensureCodexAgentTempRoot, removeCodexAgentTempRoot } from '../codex-runtime-temp';

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

  it('creates and removes only the exact job-local agent scratch root', async () => {
    const jobRoot = await mkdtemp(join(tmpdir(), 'codex-agent-temp-'));
    const runtimeTempRoot = join(jobRoot, 'tmp');
    const agentTempRoot = join(runtimeTempRoot, 'agent');
    try {
      expect(await ensureCodexAgentTempRoot({ sourceEnv: {
        SUBSCRIPTION_RUNTIME_JOB_ROOT: jobRoot,
        SUBSCRIPTION_RUNTIME_TMPDIR: runtimeTempRoot,
        TMPDIR: agentTempRoot,
      } })).toBe(agentTempRoot);
      expect((await lstat(agentTempRoot)).mode & 0o777).toBe(0o700);
      expect(await removeCodexAgentTempRoot(agentTempRoot)).toBeNull();
      await expect(lstat(agentTempRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await lstat(runtimeTempRoot)).isDirectory()).toBe(true);
    } finally {
      await rm(jobRoot, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked runtime temp root', async () => {
    const jobRoot = await mkdtemp(join(tmpdir(), 'codex-agent-temp-job-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'codex-agent-temp-outside-'));
    try {
      await symlink(outsideRoot, join(jobRoot, 'tmp'));
      await expect(ensureCodexAgentTempRoot({ sourceEnv: {
        SUBSCRIPTION_RUNTIME_JOB_ROOT: jobRoot,
        SUBSCRIPTION_RUNTIME_TMPDIR: join(jobRoot, 'tmp'),
        TMPDIR: join(jobRoot, 'tmp', 'agent'),
      } })).rejects.toThrow('codex_agent_temp_runtime_root_symlink');
    } finally {
      await rm(jobRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked trusted refresh bootstrap temp root', async () => {
    const jobRoot = await mkdtemp(join(tmpdir(), 'codex-refresh-temp-job-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'codex-refresh-temp-outside-'));
    try {
      await symlink(outsideRoot, join(jobRoot, 'tmp'));
      await expect(createTrustedCodexRuntimeTempRoot({
        prefix: 'subscription-runtime-codex-',
        sourceEnv: {
          SUBSCRIPTION_RUNTIME_JOB_ROOT: jobRoot,
          SUBSCRIPTION_RUNTIME_TMPDIR: join(jobRoot, 'tmp'),
        },
      })).rejects.toThrow('codex_refresh_bootstrap_temp_root_symlink');
    } finally {
      await rm(jobRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('reports cleanup failure without throwing or masking the worker result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-agent-cleanup-'));
    try {
      await expect(
        removeCodexAgentTempRoot(join(root, 'missing')),
      ).resolves.toBe('codex_agent_temp_cleanup_failed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
