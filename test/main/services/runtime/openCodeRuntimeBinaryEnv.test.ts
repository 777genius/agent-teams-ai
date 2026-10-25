import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyOpenCodeRuntimeBinaryEnv,
  resolveOpenCodeConsoleWrapperPath,
  resolveOpenCodeV2NpmWrapperBinary,
} from '../../../../src/main/services/runtime/openCodeRuntimeBinaryEnv';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeResourcesWithWrapper(): {
  resourcesPath: string;
  wrapperPath: string;
  realBinaryPath: string;
} {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'at-resources-'));
  tempDirs.push(resourcesPath);
  const wrapperDir = path.join(resourcesPath, 'runtime', 'opencode-console');
  fs.mkdirSync(wrapperDir, { recursive: true });
  const wrapperPath = path.join(wrapperDir, 'opencode.exe');
  fs.writeFileSync(wrapperPath, 'stub');
  return {
    resourcesPath,
    wrapperPath,
    realBinaryPath: path.join(resourcesPath, 'runtime', 'opencode.exe'),
  };
}

describe('applyOpenCodeRuntimeBinaryEnv', () => {
  it('sets the OpenCode binary env var and prepends its directory to PATH', () => {
    const binaryPath = path.join(process.cwd(), 'mock app data', 'opencode', 'opencode');
    const env: NodeJS.ProcessEnv = {
      PATH: ['/usr/bin', '/bin'].join(path.delimiter),
    };

    applyOpenCodeRuntimeBinaryEnv(env, binaryPath);

    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(env.OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(env.PATH?.split(path.delimiter)).toEqual([path.dirname(binaryPath), '/usr/bin', '/bin']);
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

  it('moves an existing binary directory ahead of stale PATH entries', () => {
    const binaryPath = path.join(process.cwd(), 'managed opencode', 'opencode');
    const binaryDirectory = path.dirname(binaryPath);
    const env: NodeJS.ProcessEnv = {
      PATH: ['/opt/stale-opencode/bin', binaryDirectory, '/usr/bin'].join(path.delimiter),
    };

    applyOpenCodeRuntimeBinaryEnv(env, binaryPath);

    expect(env.PATH?.split(path.delimiter)).toEqual([
      binaryDirectory,
      '/opt/stale-opencode/bin',
      '/usr/bin',
    ]);
  });
});

describe('applyOpenCodeRuntimeBinaryEnv console wrapper', () => {
  function nativeV2(
    resourcesPath: string,
    version = '2.0.32',
    packageName = '@opencode/cli-windows-x64'
  ) {
    const packageRoot = path.join(resourcesPath, 'selected-cli-package');
    fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
    const binary = path.join(packageRoot, 'bin', 'opencode.exe');
    fs.writeFileSync(binary, 'TEST-native');
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        name: packageName,
        version,
      })
    );
    return fs.realpathSync(binary);
  }

  it.each(['2.0.0', '2.0.32'])(
    'keeps the selected native V2 package path for SDK metadata: %s',
    (version) => {
      const { resourcesPath, wrapperPath } = makeResourcesWithWrapper();
      const binary = nativeV2(resourcesPath, version);
      const env: NodeJS.ProcessEnv = { PATH: '' };
      applyOpenCodeRuntimeBinaryEnv(env, binary, { resourcesPath, platform: 'win32', env: {} });
      expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(binary);
      expect(env.OPENCODE_BIN_PATH).toBe(binary);
      expect(env.OPENCODE_CONSOLE_WRAPPER_TARGET).toBeUndefined();
      expect(fs.existsSync(path.join(path.dirname(wrapperPath), 'opencode.real.path'))).toBe(false);
    }
  );

  it.each(['@opencode/cli-windows-arm64', '@opencode/cli-windows-x64-baseline'])(
    'keeps the selected native V2 %s package path for SDK metadata',
    (packageName) => {
      const { resourcesPath, wrapperPath } = makeResourcesWithWrapper();
      const binary = nativeV2(resourcesPath, '2.0.32', packageName);
      const env: NodeJS.ProcessEnv = { PATH: '' };
      applyOpenCodeRuntimeBinaryEnv(env, binary, { resourcesPath, platform: 'win32', env: {} });
      expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(binary);
      expect(env.OPENCODE_BIN_PATH).toBe(binary);
      expect(env.OPENCODE_CONSOLE_WRAPPER_TARGET).toBeUndefined();
      expect(fs.existsSync(path.join(path.dirname(wrapperPath), 'opencode.real.path'))).toBe(false);
    }
  );

  it.each([
    { name: '@opencode/cli-windows-x64', version: '1.19.0' },
    { name: '@other/cli-windows-x64', version: '2.0.32' },
  ])('does not bypass the wrapper for unrelated package metadata: %j', (metadata) => {
    const { resourcesPath, wrapperPath } = makeResourcesWithWrapper();
    const binary = nativeV2(resourcesPath);
    fs.writeFileSync(
      path.join(path.dirname(path.dirname(binary)), 'package.json'),
      JSON.stringify(metadata)
    );
    const env: NodeJS.ProcessEnv = { PATH: '' };
    applyOpenCodeRuntimeBinaryEnv(env, binary, { resourcesPath, platform: 'win32', env: {} });
    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(wrapperPath);
    expect(env.OPENCODE_CONSOLE_WRAPPER_TARGET).toBe(binary);
  });

  it('does not infer native identity from a selected console wrapper and its stale target', () => {
    const { resourcesPath, wrapperPath } = makeResourcesWithWrapper();
    const binary = nativeV2(resourcesPath);
    const env: NodeJS.ProcessEnv = {
      PATH: '',
      CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: wrapperPath,
      OPENCODE_BIN_PATH: wrapperPath,
      OPENCODE_CONSOLE_WRAPPER_TARGET: binary,
    };
    applyOpenCodeRuntimeBinaryEnv(env, path.join(resourcesPath, 'unselected.exe'), {
      resourcesPath,
      platform: 'win32',
      env: {},
      verifiedNativeV2BinaryPath: binary,
    });
    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(wrapperPath);
    expect(env.OPENCODE_BIN_PATH).toBe(wrapperPath);
    expect(env.OPENCODE_CONSOLE_WRAPPER_TARGET).toBe(binary);
  });

  it('routes a probe-verified standalone V2 directly without wrapper or sidecar mutations', () => {
    const { resourcesPath, wrapperPath } = makeResourcesWithWrapper();
    const binary = path.join(resourcesPath, 'user-selected.exe');
    fs.writeFileSync(binary, 'TEST standalone native');
    const env: NodeJS.ProcessEnv = { PATH: '', OPENCODE_CONSOLE_WRAPPER_TARGET: '/TEST/stale' };
    applyOpenCodeRuntimeBinaryEnv(env, binary, {
      resourcesPath,
      platform: 'win32',
      env: {},
      verifiedNativeV2BinaryPath: binary,
    });
    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(binary);
    expect(env.OPENCODE_BIN_PATH).toBe(binary);
    expect(env.OPENCODE_CONSOLE_WRAPPER_TARGET).toBeUndefined();
    expect(fs.existsSync(path.join(path.dirname(wrapperPath), 'opencode.real.path'))).toBe(false);
  });

  it('never selects a stale V2 wrapper target over an explicit different V1 binary', () => {
    const { resourcesPath, wrapperPath, realBinaryPath } = makeResourcesWithWrapper();
    const binary = nativeV2(resourcesPath);
    const env: NodeJS.ProcessEnv = {
      PATH: '',
      CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: realBinaryPath,
      OPENCODE_CONSOLE_WRAPPER_TARGET: binary,
    };
    applyOpenCodeRuntimeBinaryEnv(env, binary, {
      resourcesPath,
      platform: 'win32',
      env: {},
      verifiedNativeV2BinaryPath: binary,
    });
    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(wrapperPath);
    expect(env.OPENCODE_CONSOLE_WRAPPER_TARGET).toBe(realBinaryPath);
  });

  it('routes the Windows runtime through the console wrapper when it is bundled', () => {
    const { resourcesPath, wrapperPath, realBinaryPath } = makeResourcesWithWrapper();
    const env: NodeJS.ProcessEnv = { PATH: path.join(resourcesPath, 'stale') };

    applyOpenCodeRuntimeBinaryEnv(env, realBinaryPath, {
      resourcesPath,
      platform: 'win32',
      env: {},
    });

    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(wrapperPath);
    expect(env.OPENCODE_BIN_PATH).toBe(wrapperPath);
    expect(env.OPENCODE_CONSOLE_WRAPPER_TARGET).toBe(realBinaryPath);
    // PATH still resolves the real runtime, not the wrapper directory.
    expect(env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(realBinaryPath));
    expect(
      fs.readFileSync(path.join(path.dirname(wrapperPath), 'opencode.real.path'), 'utf8')
    ).toBe(realBinaryPath);
  });

  it('keeps the wrapper and a single real PATH entry when applied again', () => {
    const { resourcesPath, wrapperPath, realBinaryPath } = makeResourcesWithWrapper();
    const options = { resourcesPath, platform: 'win32' as const, env: {} };
    const env: NodeJS.ProcessEnv = { PATH: '' };

    applyOpenCodeRuntimeBinaryEnv(env, realBinaryPath, options);
    applyOpenCodeRuntimeBinaryEnv(env, realBinaryPath, options);

    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(wrapperPath);
    expect(env.OPENCODE_CONSOLE_WRAPPER_TARGET).toBe(realBinaryPath);
    expect(env.PATH?.split(path.delimiter)).toEqual([path.dirname(realBinaryPath)]);
  });

  it('launches the real binary when the wrapper is opted out', () => {
    const { resourcesPath, realBinaryPath } = makeResourcesWithWrapper();
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };

    applyOpenCodeRuntimeBinaryEnv(env, realBinaryPath, {
      resourcesPath,
      platform: 'win32',
      env: { AGENT_TEAMS_OPENCODE_CONSOLE_WRAPPER: '0' },
    });

    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(realBinaryPath);
    expect(env.OPENCODE_BIN_PATH).toBe(realBinaryPath);
    expect(env.OPENCODE_CONSOLE_WRAPPER_TARGET).toBeUndefined();
  });

  it('launches the real binary off Windows even when the wrapper is bundled', () => {
    const { resourcesPath, realBinaryPath } = makeResourcesWithWrapper();
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };

    applyOpenCodeRuntimeBinaryEnv(env, realBinaryPath, {
      resourcesPath,
      platform: 'linux',
      env: {},
    });

    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(realBinaryPath);
    expect(env.OPENCODE_CONSOLE_WRAPPER_TARGET).toBeUndefined();
  });

  it('launches the real binary when the wrapper is not bundled', () => {
    const { resourcesPath, wrapperPath, realBinaryPath } = makeResourcesWithWrapper();
    fs.rmSync(wrapperPath);
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };

    applyOpenCodeRuntimeBinaryEnv(env, realBinaryPath, {
      resourcesPath,
      platform: 'win32',
      env: {},
    });

    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(realBinaryPath);
    expect(env.OPENCODE_CONSOLE_WRAPPER_TARGET).toBeUndefined();
    expect(
      resolveOpenCodeConsoleWrapperPath(realBinaryPath, {
        resourcesPath,
        platform: 'win32',
        env: {},
      })
    ).toBeNull();
  });

  it('refuses a wrapper path that is a directory rather than a file', () => {
    const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'at-resources-'));
    tempDirs.push(resourcesPath);
    fs.mkdirSync(path.join(resourcesPath, 'runtime', 'opencode-console', 'opencode.exe'), {
      recursive: true,
    });

    expect(
      resolveOpenCodeConsoleWrapperPath(path.join(resourcesPath, 'runtime', 'opencode.exe'), {
        resourcesPath,
        platform: 'win32',
        env: {},
      })
    ).toBeNull();
  });

  it('still uses the wrapper when the sidecar cannot be written', () => {
    const { resourcesPath, wrapperPath, realBinaryPath } = makeResourcesWithWrapper();
    const sidecarPath = path.join(path.dirname(wrapperPath), 'opencode.real.path');
    const writeFileSync = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('EROFS: read-only file system');
    });
    const env: NodeJS.ProcessEnv = { PATH: '' };

    applyOpenCodeRuntimeBinaryEnv(env, realBinaryPath, {
      resourcesPath,
      platform: 'win32',
      env: {},
    });

    expect(writeFileSync).toHaveBeenCalled();
    expect(fs.existsSync(sidecarPath)).toBe(false);
    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(wrapperPath);
    // The env var is the wrapper's other way of finding its target.
    expect(env.OPENCODE_CONSOLE_WRAPPER_TARGET).toBe(realBinaryPath);
  });

  it('does not rewrite a sidecar that already names the real binary', () => {
    const { resourcesPath, wrapperPath, realBinaryPath } = makeResourcesWithWrapper();
    fs.writeFileSync(path.join(path.dirname(wrapperPath), 'opencode.real.path'), realBinaryPath);
    const writeFileSync = vi.spyOn(fs, 'writeFileSync');

    expect(
      resolveOpenCodeConsoleWrapperPath(realBinaryPath, {
        resourcesPath,
        platform: 'win32',
        env: {},
      })
    ).toBe(wrapperPath);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('leaves a runtime that is already the wrapper alone', () => {
    const { resourcesPath, wrapperPath } = makeResourcesWithWrapper();
    const env: NodeJS.ProcessEnv = { PATH: '' };

    applyOpenCodeRuntimeBinaryEnv(env, wrapperPath, {
      resourcesPath,
      platform: 'win32',
      env: {},
    });

    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(wrapperPath);
    expect(env.OPENCODE_CONSOLE_WRAPPER_TARGET).toBeUndefined();
    expect(env.PATH?.split(path.delimiter)).toEqual([path.dirname(wrapperPath)]);
  });
});

describe('resolveOpenCodeV2NpmWrapperBinary', () => {
  function npmInstall(options: {
    hoisted: boolean;
    link: boolean;
    version?: string;
    platform?: 'linux' | 'windows';
    withDecoy?: boolean;
  }): { wrapperBinary: string; platformBinary: string; root: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'at-opencode-npm-'));
    tempDirs.push(root);
    const version = options.version ?? '2.0.32';
    const platformName = options.platform ?? 'linux';
    const executable = platformName === 'windows' ? 'opencode.exe' : 'opencode';
    const scope = path.join(root, 'node_modules', '@opencode');
    const wrapperRoot = path.join(scope, 'cli');
    fs.mkdirSync(path.join(wrapperRoot, 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(wrapperRoot, 'package.json'),
      JSON.stringify({ name: '@opencode/cli', version })
    );
    const platformScope = options.hoisted
      ? scope
      : path.join(wrapperRoot, 'node_modules', '@opencode');
    const writePlatformPackage = (name: string, content: string): string => {
      const packageRoot = path.join(platformScope, name);
      fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
      fs.writeFileSync(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: `@opencode/${name}`, version: '2.0.32' })
      );
      const binary = path.join(packageRoot, 'bin', executable);
      fs.writeFileSync(binary, content);
      return binary;
    };
    // The decoy sorts first and has the same size: only the real source may be selected.
    if (options.withDecoy !== false)
      writePlatformPackage(`cli-${platformName}-x64`, 'TEST-native-B');
    const platformBinary = writePlatformPackage(
      `cli-${platformName}-x64-baseline`,
      'TEST-native-A'
    );
    const wrapperBinary = path.join(wrapperRoot, 'bin', 'opencode.exe');
    if (options.link) fs.linkSync(platformBinary, wrapperBinary);
    else fs.copyFileSync(platformBinary, wrapperBinary);
    return { wrapperBinary, platformBinary: fs.realpathSync(platformBinary), root };
  }

  it.each([
    { hoisted: false, link: true },
    { hoisted: true, link: true },
    { hoisted: false, link: false },
    { hoisted: true, link: false },
    { hoisted: true, link: false, withDecoy: false },
  ])('selects the platform package binary behind the npm wrapper: %j', (layout) => {
    const { wrapperBinary, platformBinary } = npmInstall(layout);

    expect(resolveOpenCodeV2NpmWrapperBinary(wrapperBinary, 'linux')).toBe(platformBinary);

    const env: NodeJS.ProcessEnv = { CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: wrapperBinary, PATH: '' };
    applyOpenCodeRuntimeBinaryEnv(env, null, { platform: 'linux' });
    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(platformBinary);
    expect(env.OPENCODE_BIN_PATH).toBe(platformBinary);
    expect(env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(platformBinary));
  });

  it('selects the Windows platform binary instead of the bundled console wrapper', () => {
    const { resourcesPath } = makeResourcesWithWrapper();
    const { wrapperBinary, platformBinary } = npmInstall({
      hoisted: false,
      link: true,
      platform: 'windows',
    });
    const env: NodeJS.ProcessEnv = { CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: wrapperBinary, PATH: '' };

    applyOpenCodeRuntimeBinaryEnv(env, null, { resourcesPath, platform: 'win32', env: {} });

    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(platformBinary);
    expect(env.OPENCODE_BIN_PATH).toBe(platformBinary);
    expect(env.OPENCODE_CONSOLE_WRAPPER_TARGET).toBeUndefined();
  });

  it('keeps the configured path when no platform package matches the wrapper', () => {
    const { wrapperBinary } = npmInstall({ hoisted: false, link: false, version: '2.0.0' });

    expect(resolveOpenCodeV2NpmWrapperBinary(wrapperBinary, 'linux')).toBeNull();
    expect(resolveOpenCodeV2NpmWrapperBinary(wrapperBinary, 'darwin')).toBeNull();

    const env: NodeJS.ProcessEnv = { CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: wrapperBinary, PATH: '' };
    applyOpenCodeRuntimeBinaryEnv(env, null, { platform: 'linux' });
    expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(wrapperBinary);
  });
});
