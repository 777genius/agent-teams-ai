import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ensureOpenCodeBridgeRuntimeBinaryEnv } from '../../../../src/main/services/runtime/openCodeBridgeRuntimeEnv';

describe('ensureOpenCodeBridgeRuntimeBinaryEnv', () => {
  it('makes an app-managed OpenCode binary visible to PATH-based bridge inventory', async () => {
    const binaryPath = path.join(process.cwd(), 'managed opencode', 'bin', 'opencode');
    const env: NodeJS.ProcessEnv = {
      PATH: ['/usr/bin', '/bin'].join(path.delimiter),
    };

    await ensureOpenCodeBridgeRuntimeBinaryEnv({
      targetEnv: env,
      resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath: () => Promise.resolve(binaryPath),
    });

    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(binaryPath);
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
      resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath: resolver,
    });

    expect(bridgeEnv.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBeUndefined();

    resolver.mockResolvedValueOnce(binaryPath);
    const commandEnv = { ...bridgeEnv };
    await ensureOpenCodeBridgeRuntimeBinaryEnv({
      targetEnv: commandEnv,
      bridgeEnv,
      resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath: resolver,
    });

    expect(commandEnv.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(commandEnv.PATH?.split(path.delimiter)[0]).toBe(path.dirname(binaryPath));
    expect(bridgeEnv.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(bridgeEnv.PATH?.split(path.delimiter)[0]).toBe(path.dirname(binaryPath));
  });

  it('keeps bridge startup non-fatal when the managed resolver fails', async () => {
    const onWarning = vi.fn();
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
    };

    await expect(
      ensureOpenCodeBridgeRuntimeBinaryEnv({
        targetEnv: env,
        resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath: () =>
          Promise.reject(new Error('manifest unreadable')),
        onWarning,
      })
    ).resolves.toBeUndefined();

    expect(onWarning).toHaveBeenCalledWith(
      '[OpenCode] Runtime adapter bundled OpenCode binary unresolved: manifest unreadable'
    );
    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });
});
