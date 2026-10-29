import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { isQualifiedDarwinBuild } from '../src/process/qualifiedDarwinBuild.ts';
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const file = (path: string, expected: string) => {
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    realpathSync(path) !== path ||
    hash(path) !== expected
  )
    throw new Error('Process artifact build input changed');
};
/** Packaging actor only. Never imported/called by Host startup, Main, renderer or MCP. */
export function buildProcessNativeArtifact(input: {
  compiler: string;
  compilerSha256: string;
  sdkRoot: string;
  sdkSettingsSha256: string;
  headersRoot: string;
  headers: readonly { file: string; sha256: string }[];
  source: string;
  sourceSha256: string;
  outputDirectory: string;
}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('Unsupported build tuple');
  const hostBuild = () => execFileSync('/usr/sbin/sysctl', ['-n', 'kern.osversion'], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 1024,
  }).trim();
  const osBuild = hostBuild();
  if (!isQualifiedDarwinBuild(osBuild)) throw new Error('Unsupported build tuple');
  const required = ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h'];
  if (
    new Set(input.headers.map((row) => row.file)).size !== input.headers.length ||
    required.some((name) => !input.headers.some((row) => row.file === name))
  )
    throw new Error('Complete NAPI header pins required');
  const validate = () => {
    if (hostBuild() !== osBuild) throw new Error('Process artifact build tuple changed');
    file(input.compiler, input.compilerSha256);
    file(join(input.sdkRoot, 'SDKSettings.json'), input.sdkSettingsSha256);
    file(input.source, input.sourceSha256);
    for (const header of input.headers) {
      if (!/^[a-z_]+\.h$/.test(header.file)) throw new Error('Invalid pinned header');
      file(join(input.headersRoot, header.file), header.sha256);
    }
  };
  validate();
  mkdirSync(input.outputDirectory, { recursive: true, mode: 0o700 });
  if (
    realpathSync(input.outputDirectory) !== input.outputDirectory ||
    !lstatSync(input.outputDirectory).isDirectory() ||
    readdirSync(input.outputDirectory).length
  )
    throw new Error('Output must be a new empty private artifact directory');
  const library = join(input.outputDirectory, 'registered-process.node');
  execFileSync(
    input.compiler,
    [
      '-bundle',
      '-undefined',
      'dynamic_lookup',
      '-DNAPI_VERSION=8',
      '-DNODE_GYP_MODULE_NAME=registered_process',
      '-I',
      input.headersRoot,
      '-isysroot',
      input.sdkRoot,
      '-mmacosx-version-min=15.0',
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      input.source,
      '-o',
      library,
    ],
    { timeout: 60_000, maxBuffer: 1024 * 1024 }
  );
  validate();
  const manifest = {
    schemaVersion: 1,
    abi: 'napi-8',
    platform: 'darwin',
    architecture: 'arm64',
    osBuild,
    library: 'registered-process.node',
    sourceSha256: input.sourceSha256,
    binarySha256: hash(library),
    compilerSha256: input.compilerSha256,
    sdkSettingsSha256: input.sdkSettingsSha256,
    headers: input.headers,
  };
  const manifestPath = join(input.outputDirectory, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  return { manifest, manifestSha256: hash(manifestPath), directory: input.outputDirectory };
}
