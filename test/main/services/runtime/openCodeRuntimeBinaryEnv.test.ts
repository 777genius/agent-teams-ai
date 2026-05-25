import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { applyOpenCodeRuntimeBinaryEnv } from '../../../../src/main/services/runtime/openCodeRuntimeBinaryEnv';

describe('applyOpenCodeRuntimeBinaryEnv', () => {
  it('sets the OpenCode binary env var and prepends its directory to PATH', () => {
    const binaryPath = path.join(process.cwd(), 'mock app data', 'opencode', 'opencode');
    const env: NodeJS.ProcessEnv = {
      PATH: ['/usr/bin', '/bin'].join(path.delimiter),
    };

    applyOpenCodeRuntimeBinaryEnv(env, binaryPath);

    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(env.OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(env.PATH?.split(path.delimiter)).toEqual([
      path.dirname(binaryPath),
      '/usr/bin',
      '/bin',
    ]);
  });

  it('keeps an explicit OpenCode binary override but still exposes it on PATH', () => {
    const explicitBinaryPath = path.join(process.cwd(), 'custom opencode', 'opencode');
    const discoveredBinaryPath = path.join(process.cwd(), 'managed opencode', 'opencode');
    const env: NodeJS.ProcessEnv = {
      CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: explicitBinaryPath,
      PATH: '/usr/bin',
    };

    applyOpenCodeRuntimeBinaryEnv(env, discoveredBinaryPath);

    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(explicitBinaryPath);
    expect(env.OPENCODE_BIN_PATH).toBe(explicitBinaryPath);
    expect(env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(explicitBinaryPath));
  });

  it('mirrors a legacy OpenCode binary override into the managed env var', () => {
    const explicitBinaryPath = path.join(process.cwd(), 'legacy opencode', 'opencode');
    const env: NodeJS.ProcessEnv = {
      OPENCODE_BIN_PATH: explicitBinaryPath,
      PATH: '/usr/bin',
    };

    applyOpenCodeRuntimeBinaryEnv(env, null);

    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(explicitBinaryPath);
    expect(env.OPENCODE_BIN_PATH).toBe(explicitBinaryPath);
    expect(env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(explicitBinaryPath));
  });

  it('does not duplicate the binary directory in PATH on repeated application', () => {
    const binaryPath = path.join(process.cwd(), 'mock app data', 'opencode', 'opencode');
    const env: NodeJS.ProcessEnv = {
      PATH: [path.dirname(binaryPath), '/usr/bin'].join(path.delimiter),
    };

    applyOpenCodeRuntimeBinaryEnv(env, binaryPath);
    applyOpenCodeRuntimeBinaryEnv(env, binaryPath);

    expect(env.PATH?.split(path.delimiter)).toEqual([path.dirname(binaryPath), '/usr/bin']);
  });
});
