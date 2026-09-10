// @vitest-environment node
import { mkdtemp, readFile, rm as removeDirectory } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { writeGate, removeGate, context } = vi.hoisted(() => ({
  writeGate: vi.fn(),
  removeGate: vi.fn(),
  context: { root: '' },
}));
vi.mock('@main/utils/atomicWrite', async (importOriginal) => {
  const original = await importOriginal<typeof import('@main/utils/atomicWrite')>();
  return {
    ...original,
    atomicWriteAsync: async (...args: Parameters<typeof original.atomicWriteAsync>) => {
      await writeGate();
      return original.atomicWriteAsync(...args);
    },
  };
});
vi.mock('fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs/promises')>();
  return {
    ...original,
    rm: async (...args: Parameters<typeof original.rm>) => {
      await removeGate();
      return original.rm(...args);
    },
  };
});
vi.mock('@main/utils/pathDecoder', () => ({ getClaudeBasePath: () => context.root }));

import {
  buildTeamControlApiBaseUrl,
  clearTeamControlApiState,
  writeTeamControlApiState,
} from '@main/services/team/TeamControlApiState';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function statePath() {
  return path.join(context.root, 'team-control-api.json');
}

async function expectPublished(baseUrl: string) {
  expect(process.env.CLAUDE_TEAM_CONTROL_URL).toBe(baseUrl);
  expect(JSON.parse(await readFile(statePath(), 'utf8'))).toMatchObject({
    baseUrl,
    pid: process.pid,
  });
}

async function expectCleared() {
  expect(process.env.CLAUDE_TEAM_CONTROL_URL).toBeUndefined();
  await expect(readFile(statePath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('Host control endpoint publication', () => {
  beforeEach(async () => {
    context.root = await mkdtemp(path.join(os.tmpdir(), 'app-control-publication-'));
    writeGate.mockReset().mockResolvedValue(undefined);
    removeGate.mockReset().mockResolvedValue(undefined);
    vi.stubEnv('CLAUDE_TEAM_CONTROL_URL', 'http://127.0.0.1:9999');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await removeDirectory(context.root, { recursive: true, force: true });
  });

  it('publishes the actual listening endpoint only after disk publication succeeds', async () => {
    const gate = deferred();
    writeGate.mockReturnValueOnce(gate.promise);
    const pending = writeTeamControlApiState(buildTeamControlApiBaseUrl(4569));
    expect(process.env.CLAUDE_TEAM_CONTROL_URL).toBeUndefined();
    gate.resolve();
    await pending;
    await expectPublished('http://127.0.0.1:4569');
  });

  it('revokes stale publication on failure and can subsequently restart on another port', async () => {
    writeGate.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(writeTeamControlApiState('http://127.0.0.1:4570')).rejects.toThrow(
      'disk unavailable'
    );
    await expectCleared();
    await writeTeamControlApiState('http://127.0.0.1:4571');
    await expectPublished('http://127.0.0.1:4571');
  });

  it('revokes synchronously on stop, tolerates cleanup failure and repeated stop, and republishes on reopen', async () => {
    await writeTeamControlApiState('http://127.0.0.1:4572');
    removeGate.mockRejectedValueOnce(new Error('file inaccessible'));
    const stopping = clearTeamControlApiState();
    expect(process.env.CLAUDE_TEAM_CONTROL_URL).toBeUndefined();
    await stopping;
    await clearTeamControlApiState();
    await expectCleared();
    await writeTeamControlApiState('http://127.0.0.1:4573');
    await expectPublished('http://127.0.0.1:4573');
  });

  it('orders write then clear so a late atomic write cannot restore the stopped file or env', async () => {
    const gate = deferred();
    writeGate.mockReturnValueOnce(gate.promise);
    const pending = writeTeamControlApiState('http://127.0.0.1:4574');
    await vi.waitFor(() => expect(writeGate).toHaveBeenCalledOnce());
    const stopping = clearTeamControlApiState();
    // Give an incorrectly unqueued remove time to finish before releasing the write.
    await vi.waitFor(() => expect(process.env.CLAUDE_TEAM_CONTROL_URL).toBeUndefined());
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    gate.resolve();
    await Promise.all([pending, stopping]);
    await expectCleared();
  });

  it('orders clear then write so a late remove cannot delete the restarted endpoint file', async () => {
    await writeTeamControlApiState('http://127.0.0.1:4575');
    const gate = deferred();
    removeGate.mockReturnValueOnce(gate.promise);
    const stopping = clearTeamControlApiState();
    await vi.waitFor(() => expect(removeGate).toHaveBeenCalledOnce());
    const restarting = writeTeamControlApiState('http://127.0.0.1:4576');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    gate.resolve();
    await Promise.all([stopping, restarting]);
    await expectPublished('http://127.0.0.1:4576');
  });
});
