// @vitest-environment node
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const filesystem = vi.hoisted(() => ({ failure: null as Error | null, canonical: '' }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    realpathSync: (...args: Parameters<typeof actual.realpathSync>) =>
      String(args[0]).startsWith(path.resolve('/TEST'))
        ? (() => {
            if (filesystem.failure) throw filesystem.failure;
            return filesystem.canonical;
          })()
        : actual.realpathSync(...args),
  };
});

import {
  createStopTarget,
  runtimeStopRequest,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeRuntimeStopRecovery';

const cwd = path.resolve('/TEST/deleted-project');
const input = {
  teamName: 'TEST-stop',
  laneId: 'primary',
  runId: 'run-1',
  capabilitySnapshotId: `opencode:${'a'.repeat(32)}`,
  behaviorFingerprint: 'b'.repeat(64),
  cwd,
  body: { projectPath: cwd },
};
const manifest = {
  highWatermark: 1,
  sessionIdentityHash: 'retained-sessions',
  stopSessions: [
    {
      teamName: input.teamName,
      laneId: 'primary',
      runId: input.runId,
      memberName: 'alice',
      sessionId: 'session-1',
    },
  ],
};
const entry = { requestId: 'original-stop', idempotencyKey: 'original-key' };

describe('Stop project filesystem fallback', () => {
  beforeEach(() => {
    filesystem.failure = null;
    filesystem.canonical = cwd;
  });

  it.each(['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP', 'EPERM'])(
    'retains exact authority through runtime-compatible %s fallback',
    (code) => {
      filesystem.failure = Object.assign(new Error('filesystem'), { code });
      const target = createStopTarget(input, manifest);
      const request = runtimeStopRequest(entry, target);
      expect(request.target).toEqual(target.runtimeTarget);
      expect(request.target.projectPath).toBe(cwd);
      expect(request.target.members).toEqual([{ memberName: 'alice', sessionId: 'session-1' }]);
      expect(request.originalRequestId).toBe(entry.requestId);
      expect(request.idempotencyKey).toBe(entry.idempotencyKey);
      expect(target.cwd).toBe(cwd);
      expect(target.body).toEqual(input.body);
    }
  );

  it('propagates unexpected filesystem errors at creation and retained-request validation', () => {
    filesystem.canonical = cwd;
    const target = createStopTarget(input, manifest);
    const failure = Object.assign(new Error('I/O failed'), { code: 'EIO' });
    filesystem.failure = failure;
    expect(() => createStopTarget(input, manifest)).toThrow(failure);
    expect(() => runtimeStopRequest(entry, target)).toThrow(failure);
  });

  it('rejects an unavailable alias rather than rewriting its retained canonical target', () => {
    filesystem.canonical = path.resolve('/TEST/original-canonical');
    const target = createStopTarget(input, manifest);
    const original = structuredClone(target);
    filesystem.failure = Object.assign(new Error('gone'), { code: 'ENOENT' });
    expect(() => runtimeStopRequest(entry, target)).toThrow('project identity mismatch');
    expect(target).toEqual(original);
  });
});
