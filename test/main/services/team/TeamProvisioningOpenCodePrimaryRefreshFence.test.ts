import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  commitOpenCodeRuntimeBootstrapSessionEvidence,
  createDefaultOpenCodeRuntimeBootstrapEvidencePorts,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeBootstrapEvidence';
import {
  clearOpenCodeRuntimeLaneStorage,
  getOpenCodeTeamRuntimeLaneDirectory,
  setOpenCodeRuntimeActiveRunManifest,
} from '@main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { RuntimeStoreBatchWriter } from '@main/services/team/opencode/store/RuntimeStoreManifest';

describe('primary refresh bootstrap lifecycle fence', () => {
  it('rejects an authority change after a read before writing session evidence', async () => {
    const teamsBasePath = await mkdtemp(join(tmpdir(), 'TEST-primary-refresh-fence-'));
    let authorized = true;
    const input = { teamsBasePath, teamName: 'TEST-team', laneId: 'primary', runId: 'TEST-run' };
    try {
      await setOpenCodeRuntimeActiveRunManifest(input);
      const defaults = createDefaultOpenCodeRuntimeBootstrapEvidencePorts({ teamsBasePath });
      const write = vi.spyOn(RuntimeStoreBatchWriter.prototype, 'writeBatch');
      await expect(
        commitOpenCodeRuntimeBootstrapSessionEvidence(
          {
            ...input,
            memberName: 'worker',
            runtimeSessionId: 'TEST-session',
            observedAt: new Date().toISOString(),
          },
          {
            ...defaults,
            isAuthorized: () => authorized,
            readFileUtf8: async (file) => {
              try {
                return await defaults.readFileUtf8(file);
              } finally {
                authorized = false;
              }
            },
          }
        )
      ).rejects.toThrow('opencode_refresh_superseded');
      expect(write).not.toHaveBeenCalled();
      write.mockRestore();
    } finally {
      await rm(teamsBasePath, { recursive: true, force: true });
    }
  });
  it('serializes stop after an already-started batch and retires its evidence before stop completes', async () => {
    const teamsBasePath = await mkdtemp(join(tmpdir(), 'TEST-primary-refresh-stop-'));
    let authorized = true;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const input = { teamsBasePath, teamName: 'TEST-team', laneId: 'primary', runId: 'TEST-run' };
    const original = RuntimeStoreBatchWriter.prototype.writeBatch;
    let restore = () => {};
    try {
      await setOpenCodeRuntimeActiveRunManifest(input);
      const spy = vi
        .spyOn(RuntimeStoreBatchWriter.prototype, 'writeBatch')
        .mockImplementation(async function (this: RuntimeStoreBatchWriter, batch) {
          entered();
          await gate;
          return original.call(this, batch);
        });
      restore = () => spy.mockRestore();
      const commit = commitOpenCodeRuntimeBootstrapSessionEvidence(
        {
          ...input,
          memberName: 'worker',
          runtimeSessionId: 'TEST-session',
          observedAt: new Date().toISOString(),
        },
        {
          ...createDefaultOpenCodeRuntimeBootstrapEvidencePorts({ teamsBasePath }),
          isAuthorized: () => authorized,
        }
      );
      const rejected = expect(commit).rejects.toThrow('opencode_refresh_superseded');
      await started;
      authorized = false;
      let stopped = false;
      const stop = clearOpenCodeRuntimeLaneStorage({ ...input, expectedRunId: input.runId }).then(
        (cleared) => {
          stopped = true;
          return cleared;
        }
      );
      await new Promise((done) => setTimeout(done, 25));
      expect(stopped).toBe(false);
      release();
      await rejected;
      expect(await stop).toBe(true);
      const files = await readdir(
        getOpenCodeTeamRuntimeLaneDirectory(teamsBasePath, input.teamName, input.laneId)
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      expect(files).not.toContain('opencode-session-store.json');
      expect(files).not.toContain('manifest.json');
    } finally {
      release?.();
      restore();
      await rm(teamsBasePath, { recursive: true, force: true });
    }
  });
});
