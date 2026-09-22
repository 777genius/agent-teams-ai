import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { setOpenCodeRuntimeActiveRunManifest } from '../../opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import {
  commitOpenCodeRuntimeBootstrapSessionEvidence,
  createDefaultOpenCodeRuntimeBootstrapEvidencePorts,
  hasCommittedOpenCodeRuntimeBootstrapSessionEvidence,
} from '../TeamProvisioningOpenCodeBootstrapEvidence';

const input = {
  teamName: 'bootstrap-wake-test',
  laneId: 'secondary:opencode:alice',
  runId: 'run-1',
  memberName: 'alice',
  runtimeSessionId: 'session-1',
  observedAt: '2026-01-01T00:00:00.000Z',
};
const tempDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup() {
  const teamsBasePath = await mkdtemp(join(tmpdir(), 'agent-teams-bootstrap-wake-test-'));
  tempDirectories.push(teamsBasePath);
  await setOpenCodeRuntimeActiveRunManifest({ teamsBasePath, ...input });
  const onBootstrapSessionCommitted = vi.fn();
  const ports = createDefaultOpenCodeRuntimeBootstrapEvidencePorts({
    teamsBasePath,
    onBootstrapSessionCommitted,
  });
  return { ports, onBootstrapSessionCommitted };
}

describe('OpenCode bootstrap committed wake', () => {
  it.each(['app_managed_bootstrap', 'runtime_bootstrap_checkin'] as const)(
    'publishes %s only after evidence verifies and releases the lane lock',
    async (source) => {
      const { ports, onBootstrapSessionCommitted } = await setup();
      let verified = false;
      let followup: Promise<void> | undefined;
      onBootstrapSessionCommitted.mockImplementation((committed) => {
        followup = (async () => {
          verified = await hasCommittedOpenCodeRuntimeBootstrapSessionEvidence(committed, ports);
          // Reacquiring this lock would deadlock if publication awaited delivery under it.
          await setOpenCodeRuntimeActiveRunManifest({
            teamsBasePath: ports.teamsBasePath,
            ...input,
          });
        })();
      });
      await commitOpenCodeRuntimeBootstrapSessionEvidence({ ...input, source }, ports);
      await followup;
      expect(verified).toBe(true);
      expect(onBootstrapSessionCommitted).toHaveBeenCalledExactlyOnceWith({ ...input, source });
    }
  );

  it('does not publish when evidence commit fails', async () => {
    const { ports, onBootstrapSessionCommitted } = await setup();
    ports.mkdirRecursive = vi.fn(async () => {
      throw new Error('commit failed');
    });
    await expect(commitOpenCodeRuntimeBootstrapSessionEvidence(input, ports)).rejects.toThrow(
      'commit failed'
    );
    expect(onBootstrapSessionCommitted).not.toHaveBeenCalled();
  });

  it('does not publish when the committed evidence does not read back', async () => {
    const { ports, onBootstrapSessionCommitted } = await setup();
    ports.readCommittedBootstrapSessionEvidence = vi.fn(async () => ({
      state: 'healthy' as const,
      committed: false,
      activeRunId: 'run-1',
      sessions: [],
      diagnostics: [],
    }));
    await expect(commitOpenCodeRuntimeBootstrapSessionEvidence(input, ports)).rejects.toThrow(
      'did not verify'
    );
    expect(onBootstrapSessionCommitted).not.toHaveBeenCalled();
  });

  it('does not fail a verified bootstrap if the output callback fails', async () => {
    const { ports, onBootstrapSessionCommitted } = await setup();
    onBootstrapSessionCommitted.mockImplementation(() => {
      throw new Error('wake failed');
    });
    ports.warn = vi.fn();
    await expect(
      commitOpenCodeRuntimeBootstrapSessionEvidence(input, ports)
    ).resolves.toBeUndefined();
    expect(ports.warn).toHaveBeenCalledWith('OpenCode bootstrap inbox wake failed: wake failed');
    expect(await hasCommittedOpenCodeRuntimeBootstrapSessionEvidence(input, ports)).toBe(true);
  });
});
