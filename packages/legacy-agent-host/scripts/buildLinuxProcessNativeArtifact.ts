import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { dirname, join } from 'node:path';

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const file = (path: string, expected: string) => {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || realpathSync(path) !== path || hash(path) !== expected)
    throw new Error('Process artifact build input changed');
};
/** Build actor only: the Host loads a checked binary and never invokes this compiler. */
export function buildLinuxProcessNativeArtifact(input: {
  compiler: string;
  compilerSha256: string;
  inspector: string;
  inspectorSha256: string;
  headersRoot: string;
  headers: readonly { file: string; sha256: string }[];
  source: string;
  sourceSha256: string;
  outputDirectory: string;
}) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Unsupported build tuple');
  const required = ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h'];
  if (new Set(input.headers.map(row => row.file)).size !== input.headers.length ||
      required.some(name => !input.headers.some(row => row.file === name)))
    throw new Error('Complete NAPI header pins required');
  const validate = () => {
    file(input.compiler, input.compilerSha256); file(input.inspector, input.inspectorSha256);
    file(input.source, input.sourceSha256);
    for (const header of input.headers) {
      if (!/^[a-z_]+\.h$/.test(header.file)) throw new Error('Invalid pinned header');
      file(join(input.headersRoot, header.file), header.sha256);
    }
  };
  validate();
  const refuse = () => new Error('Output must be a new empty private artifact directory');
  const parent = dirname(input.outputDirectory), originalParent = lstatSync(parent, { bigint: true });
  if (realpathSync(parent) !== parent || !originalParent.isDirectory() || originalParent.isSymbolicLink()) throw refuse();
  try { mkdirSync(input.outputDirectory, { mode: 0o700 }); } catch { throw refuse(); }
  const originalOutput = lstatSync(input.outputDirectory, { bigint: true });
  const validateOutput = () => {
    const directory = lstatSync(input.outputDirectory, { bigint: true }), currentParent = lstatSync(parent, { bigint: true });
    if (realpathSync(input.outputDirectory) !== input.outputDirectory || !directory.isDirectory() ||
        directory.isSymbolicLink() || directory.uid !== BigInt(process.getuid!()) ||
        (directory.mode & 0o777n) !== 0o700n || directory.dev !== originalOutput.dev || directory.ino !== originalOutput.ino ||
        currentParent.dev !== originalParent.dev || currentParent.ino !== originalParent.ino) throw refuse();
  };
  validateOutput();
  if (readdirSync(input.outputDirectory).length) throw refuse();
  const library = join(input.outputDirectory, 'registered-process.node');
  execFileSync(input.compiler, ['-shared', '-fPIC', '-DNAPI_VERSION=8', '-DNODE_GYP_MODULE_NAME=registered_process',
    '-I', input.headersRoot, '-std=c11', '-Wall', '-Wextra', '-Werror', input.source, '-o', library],
  { timeout: 60_000, maxBuffer: 1024 * 1024 });
  validate(); validateOutput();
  const options = { encoding: 'utf8' as const, timeout: 10_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' } };
  const elf = execFileSync(input.inspector, ['--file-header', library], options);
  if (!/Class:\s+ELF64\b/.test(elf) || !/Machine:\s+Advanced Micro Devices X86-64\b/.test(elf))
    throw new Error('Unexpected native ELF architecture');
  const versions = execFileSync(input.inspector, ['--version-info', '--wide', library], options);
  const requiredVersions = [...versions.matchAll(/Name: GLIBC_(\d+(?:\.\d+)+)\b/g)].map(match => match[1]!);
  if (!requiredVersions.length || versions.includes('GLIBC_PRIVATE')) throw new Error('Unqualified libc ABI');
  requiredVersions.sort((a, b) => {
    const left = a.split('.').map(Number), right = b.split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const difference = (left[i] ?? 0) - (right[i] ?? 0); if (difference) return difference;
    }
    return 0;
  });
  validate(); validateOutput();
  const manifest = { schemaVersion: 1, abi: 'napi-8', platform: 'linux', architecture: 'x64',
    kernelCapability: 'pidfd-live-v1', buildKernelRelease: release(),
    libc: { family: 'glibc', minimumVersion: requiredVersions.at(-1)! }, library: 'registered-process.node',
    sourceSha256: input.sourceSha256, binarySha256: hash(library), compilerSha256: input.compilerSha256,
    inspectorSha256: input.inspectorSha256, headers: input.headers };
  const path = join(input.outputDirectory, 'manifest.json');
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { manifest, manifestSha256: hash(path), directory: input.outputDirectory };
}
