import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureOpenCodeBridgeRuntimeBinaryEnv } from '../../../../src/main/services/runtime/openCodeBridgeRuntimeEnv';

describe('ensureOpenCodeBridgeRuntimeBinaryEnv', () => {
  let tempDir: string | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-bridge-runtime-env-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  async function writeExecutable(relativePath: string): Promise<string> {
    const binaryPath = path.join(tempDir!, relativePath);
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    return binaryPath;
  }

  it('makes an app-managed OpenCode binary visible to PATH-based bridge inventory', async () => {
    const binaryPath = path.join(process.cwd(), 'managed opencode', 'bin', 'opencode');
    const env: NodeJS.ProcessEnv = {
      PATH: ['/usr/bin', '/bin'].join(path.delimiter),
    };

    await ensureOpenCodeBridgeRuntimeBinaryEnv({
      targetEnv: env,
      resolveVerifiedOpenCodeRuntimeBinaryPath: () => Promise.resolve(binaryPath),
    });

    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(env.OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(env.PATH?.split(path.delimiter)).toEqual([
      path.dirname(binaryPath),
      '/usr/bin',
      '/bin',
    ]);
  });

  it('recovers when managed OpenCode is installed after the bridge base env was created', async () => {
    const binaryPath = path.join(process.cwd(), 'late managed opencode', 'opencode');
    const bridgeEnv: NodeJS.ProcessEnv = {
      PATH: ['/usr/bin', '/bin'].join(path.delimiter),
    };
    const resolver = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce(null);

    await ensureOpenCodeBridgeRuntimeBinaryEnv({
      targetEnv: bridgeEnv,
      bridgeEnv,
      resolveVerifiedOpenCodeRuntimeBinaryPath: resolver,
    });

    expect(bridgeEnv.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBeUndefined();

    resolver.mockResolvedValueOnce(binaryPath);
    const commandEnv = { ...bridgeEnv };
    await ensureOpenCodeBridgeRuntimeBinaryEnv({
      targetEnv: commandEnv,
      bridgeEnv,
      resolveVerifiedOpenCodeRuntimeBinaryPath: resolver,
    });

    expect(commandEnv.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(commandEnv.OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(commandEnv.PATH?.split(path.delimiter)[0]).toBe(path.dirname(binaryPath));
    expect(bridgeEnv.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(bridgeEnv.OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(bridgeEnv.PATH?.split(path.delimiter)[0]).toBe(path.dirname(binaryPath));
  });

  it('honors a legacy OpenCode binary override already present in the command env', async () => {
    const binaryPath = await writeExecutable('legacy-opencode');
    const env: NodeJS.ProcessEnv = {
      OPENCODE_BIN_PATH: binaryPath,
      PATH: '/usr/bin',
    };
    const resolver = vi.fn<() => Promise<string | null>>();

    await ensureOpenCodeBridgeRuntimeBinaryEnv({
      targetEnv: env,
      resolveVerifiedOpenCodeRuntimeBinaryPath: resolver,
    });

    expect(resolver).not.toHaveBeenCalled();
    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(env.OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(binaryPath));
  });

  it('normalizes a relative OpenCode binary override before exposing it to the bridge', async () => {
    const binaryPath = await writeExecutable('relative-opencode');
    const relativeBinaryPath = path.relative(process.cwd(), binaryPath);
    const env: NodeJS.ProcessEnv = {
      OPENCODE_BIN_PATH: relativeBinaryPath,
      PATH: '/usr/bin',
    };
    const resolver = vi.fn<() => Promise<string | null>>();

    await ensureOpenCodeBridgeRuntimeBinaryEnv({
      targetEnv: env,
      resolveVerifiedOpenCodeRuntimeBinaryPath: resolver,
    });

    expect(resolver).not.toHaveBeenCalled();
    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(env.OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(binaryPath));
  });

  it('replaces stale bridge-owned OpenCode binary env with a fresh verified resolver result', async () => {
    const staleBinaryPath = path.join(tempDir!, 'missing-opencode');
    const binaryPath = path.join(process.cwd(), 'fresh managed opencode', 'opencode');
    const bridgeEnv: NodeJS.ProcessEnv = {
      CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: staleBinaryPath,
      OPENCODE_BIN_PATH: staleBinaryPath,
      PATH: '/usr/bin',
    };
    const commandEnv = { ...bridgeEnv };
    const resolver = vi.fn<() => Promise<string | null>>().mockResolvedValue(binaryPath);

    await ensureOpenCodeBridgeRuntimeBinaryEnv({
      targetEnv: commandEnv,
      bridgeEnv,
      resolveVerifiedOpenCodeRuntimeBinaryPath: resolver,
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(commandEnv.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(commandEnv.OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(bridgeEnv.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(bridgeEnv.OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(commandEnv.PATH?.split(path.delimiter)[0]).toBe(path.dirname(binaryPath));
  });

  it('keeps bridge startup non-fatal when the runtime binary resolver fails', async () => {
    const onWarning = vi.fn();
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
    };

    await expect(
      ensureOpenCodeBridgeRuntimeBinaryEnv({
        targetEnv: env,
        resolveVerifiedOpenCodeRuntimeBinaryPath: () =>
          Promise.reject(new Error('manifest unreadable')),
        onWarning,
      })
    ).resolves.toBeUndefined();

    expect(onWarning).toHaveBeenCalledWith(
      '[OpenCode] Runtime adapter OpenCode binary unresolved: manifest unreadable'
    );
    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBeUndefined();
    expect(env.OPENCODE_BIN_PATH).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });
});
