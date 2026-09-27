import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readOpenCodeEffectiveRuntimeStatus } from '@main/services/runtime/openCodeEffectiveRuntimeVersion';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('readOpenCodeEffectiveRuntimeStatus', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-effective-runtime-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeBinary(name: string): Promise<string> {
    const binaryPath = path.join(tempDir, name);
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'binary');
    return binaryPath;
  }

  it('uses the selected managed runtime without an explicit override', async () => {
    const readDefaultStatus = vi.fn(() => Promise.resolve({ installed: true, version: '1.18.32' }));
    const probe = vi.fn();
    await expect(readOpenCodeEffectiveRuntimeStatus({}, readDefaultStatus, probe)).resolves.toEqual(
      {
        installed: true,
        version: '1.18.32',
      }
    );
    expect(probe).not.toHaveBeenCalled();
  });

  it('checks the exact override binary instead of an outdated managed runtime', async () => {
    const binaryPath = await writeBinary('custom-opencode');
    const readDefaultStatus = vi.fn(() => Promise.resolve({ installed: true, version: '1.17.18' }));
    const probe = vi.fn(() => Promise.resolve({ ok: true, version: '1.18.32' }));
    await expect(
      readOpenCodeEffectiveRuntimeStatus(
        { OPENCODE_BIN_PATH: binaryPath },
        readDefaultStatus,
        probe
      )
    ).resolves.toEqual({
      installed: true,
      version: '1.18.32',
      binaryOverrideEnvName: 'OPENCODE_BIN_PATH',
    });
    expect(readDefaultStatus).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledWith(binaryPath);
  });

  it('uses the managed runtime when an explicit override is too old for Agent Teams', async () => {
    const binaryPath = await writeBinary('unsupported-opencode');
    const readDefaultStatus = vi.fn(() => Promise.resolve({ installed: true, version: '1.18.32' }));
    const probe = vi.fn(() => Promise.resolve({ ok: true, version: '1.15.9' }));

    await expect(
      readOpenCodeEffectiveRuntimeStatus(
        { OPENCODE_BIN_PATH: binaryPath },
        readDefaultStatus,
        probe
      )
    ).resolves.toEqual({ installed: true, version: '1.18.32' });
    expect(readDefaultStatus).toHaveBeenCalledOnce();
  });

  it('keeps a supported override below the free-tier minimum as the effective runtime', async () => {
    const binaryPath = await writeBinary('supported-opencode');
    const readDefaultStatus = vi.fn(() => Promise.resolve({ installed: true, version: '1.18.32' }));
    const probe = vi.fn(() => Promise.resolve({ ok: true, version: '1.17.18' }));

    await expect(
      readOpenCodeEffectiveRuntimeStatus(
        { OPENCODE_BIN_PATH: binaryPath },
        readDefaultStatus,
        probe
      )
    ).resolves.toEqual({
      installed: true,
      version: '1.17.18',
      binaryOverrideEnvName: 'OPENCODE_BIN_PATH',
    });
    expect(readDefaultStatus).not.toHaveBeenCalled();
  });

  it('uses the managed runtime when an explicit override cannot be probed', async () => {
    const readDefaultStatus = vi.fn(() => Promise.resolve({ installed: true, version: '1.18.32' }));
    const probe = vi.fn(() => Promise.resolve({ ok: false }));

    await expect(
      readOpenCodeEffectiveRuntimeStatus(
        { OPENCODE_BIN_PATH: '/missing/opencode' },
        readDefaultStatus,
        probe
      )
    ).resolves.toEqual({ installed: true, version: '1.18.32' });
  });

  it('checks the wrapper target when Windows wraps an explicit override', async () => {
    const wrapperPath = await writeBinary('runtime/opencode-console/opencode.exe');
    const targetPath = await writeBinary('custom-opencode.exe');
    const probe = vi.fn(() => Promise.resolve({ ok: true, version: '1.17.18' }));
    await expect(
      readOpenCodeEffectiveRuntimeStatus(
        {
          CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: wrapperPath,
          OPENCODE_CONSOLE_WRAPPER_TARGET: targetPath,
        },
        vi.fn(),
        probe
      )
    ).resolves.toEqual({
      installed: true,
      version: '1.17.18',
      binaryOverrideEnvName: 'CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH',
    });
    expect(probe).toHaveBeenCalledWith(targetPath);
  });

  it('uses the legacy override when the preferred override path was removed', async () => {
    const legacyBinaryPath = await writeBinary('legacy-opencode');
    const readDefaultStatus = vi.fn(() => Promise.resolve({ installed: true, version: '1.17.18' }));
    const probe = vi.fn((binaryPath: string) =>
      Promise.resolve({
        ok: binaryPath === legacyBinaryPath,
        version: binaryPath === legacyBinaryPath ? '1.18.32' : undefined,
      })
    );

    await expect(
      readOpenCodeEffectiveRuntimeStatus(
        {
          CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: path.join(tempDir, 'deleted-opencode'),
          OPENCODE_BIN_PATH: legacyBinaryPath,
          OPENCODE_CONSOLE_WRAPPER_TARGET: path.join(tempDir, 'stale-wrapper-target'),
        },
        readDefaultStatus,
        probe
      )
    ).resolves.toEqual({
      installed: true,
      version: '1.18.32',
      binaryOverrideEnvName: 'OPENCODE_BIN_PATH',
    });
    expect(probe).toHaveBeenCalledExactlyOnceWith(legacyBinaryPath);
    expect(readDefaultStatus).not.toHaveBeenCalled();
  });
});
