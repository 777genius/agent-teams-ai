import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const file = (path: string, expected: string) => {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || realpathSync(path) !== path || hash(path) !== expected)
    throw new Error('Process artifact build input changed');
};
/** Separate static launch input. Never called from Main, Host, or ordinary release startup. */
export function buildLinuxChildExecArtifact(input: {
  compiler: string; compilerSha256: string; inspector: string; inspectorSha256: string;
  source: string; sourceSha256: string; outputDirectory: string;
}) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Unsupported helper build tuple');
  const deadline = performance.now() + 60_000;
  const environment = { ...process.env, LC_ALL: 'C' };
  const timeout = () => {
    const value = Math.floor(deadline - performance.now());
    if (value <= 0) throw new Error('Original helper build deadline expired');
    return value;
  };
  const validate = () => {
    file(input.compiler, input.compilerSha256); file(input.inspector, input.inspectorSha256);
    file(input.source, input.sourceSha256);
  };
  validate();
  const parent = dirname(input.outputDirectory), beforeParent = lstatSync(parent, { bigint: true });
  const refuse = () => new Error('Helper output must be a new private artifact directory');
  if (!beforeParent.isDirectory() || beforeParent.isSymbolicLink() || realpathSync(parent) !== parent) throw refuse();
  try { mkdirSync(input.outputDirectory, { mode: 0o700 }); } catch { throw refuse(); }
  const beforeOutput = lstatSync(input.outputDirectory, { bigint: true });
  const validateOutput = () => {
    const current = lstatSync(input.outputDirectory, { bigint: true }), namedParent = lstatSync(parent, { bigint: true });
    if (realpathSync(input.outputDirectory) !== input.outputDirectory || !current.isDirectory() ||
        current.isSymbolicLink() || current.uid !== BigInt(process.getuid!()) || (current.mode & 0o777n) !== 0o700n ||
        current.dev !== beforeOutput.dev || current.ino !== beforeOutput.ino ||
        namedParent.dev !== beforeParent.dev || namedParent.ino !== beforeParent.ino) throw refuse();
  };
  validateOutput();
  if (readdirSync(input.outputDirectory).length !== 0) throw refuse();
  const query = (argument: string) => execFileSync(input.compiler, [argument], {
    env: environment, encoding: 'utf8', timeout: timeout(), maxBuffer: 32 * 1024,
  }).trim();
  const executable = (name: string) => {
    if (isAbsolute(name)) { accessSync(name, constants.X_OK); return realpathSync(name); }
    if (!name || /[\/\0\r\n]/u.test(name)) throw new Error('Unqualified compiler tool path');
    for (const directory of (environment.PATH ?? '').split(':')) {
      if (!isAbsolute(directory)) throw new Error('Compiler PATH must contain only absolute directories');
      const candidate = join(directory, name);
      try { accessSync(candidate, constants.X_OK); } catch { continue; }
      return realpathSync(candidate);
    }
    throw new Error('Pinned compiler tool is unavailable');
  };
  const linkFiles = [
    ...['cc1', 'as', 'collect2', 'ld'].map(name => executable(query('-print-prog-name=' + name))),
    ...['crt1.o', 'crti.o', 'crtbeginT.o', 'libgcc.a', 'libgcc_eh.a', 'libc.a', 'crtend.o', 'crtn.o']
      .map(name => {
        const path = query('-print-file-name=' + name);
        if (!isAbsolute(path)) throw new Error('Pinned static link input is unavailable');
        return realpathSync(path);
      }),
  ];
  const linkInputs = [...new Set(linkFiles)].sort().map(path => ({ file: path, sha256: hash(path) }));
  const validateLinks = () => { for (const pin of linkInputs) file(pin.file, pin.sha256); };
  validateLinks();
  const binary = join(input.outputDirectory, 'linux-child-exec');
  execFileSync(input.compiler, ['-static', '-no-pie', '-std=c11', '-Wall', '-Wextra', '-Werror',
    '-O2', '-fno-ident', '-Wl,--build-id=none', input.source, '-o', binary],
  { env: environment, timeout: timeout(), maxBuffer: 1024 * 1024 });
  validate(); validateLinks(); validateOutput();
  const elf = execFileSync(input.inspector, ['--file-header', '--program-headers', '--dynamic', '--wide', binary],
    { env: environment, encoding: 'utf8', timeout: timeout(), maxBuffer: 1024 * 1024 });
  if (!/Class:\s+ELF64\b/u.test(elf) || !/Machine:\s+Advanced Micro Devices X86-64\b/u.test(elf) ||
      !/Type:\s+EXEC\b/u.test(elf) || /^\s*INTERP\s/mu.test(elf) || /\(NEEDED\)/u.test(elf))
    throw new Error('Linux helper must be the checked static ELF executable');
  chmodSync(binary, 0o500);
  validate(); validateLinks(); validateOutput(); timeout();
  const manifest = { schemaVersion: 1, platform: 'linux', architecture: 'x64',
    protocol: 'linux-child-exec-v1', kernelCapability: 'close-range-v1', binary: 'linux-child-exec',
    binarySha256: hash(binary), sourceSha256: input.sourceSha256, compilerSha256: input.compilerSha256,
    inspectorSha256: input.inspectorSha256, buildKernelRelease: release(), linkInputs };
  const manifestPath = join(input.outputDirectory, 'manifest.json');
  const serialized = JSON.stringify(manifest, null, 2) + '\n';
  if (Buffer.byteLength(serialized) > 16 * 1024) throw new Error('Helper manifest exceeds its closed bound');
  writeFileSync(manifestPath, serialized, { flag: 'wx', mode: 0o600 });
  validate(); validateLinks(); validateOutput();
  const manifestSha256 = hash(manifestPath);
  timeout();
  return { manifestPath, manifestSha256, binarySha256: manifest.binarySha256 };
}

// Explicit TEST staging only.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, output, compilerInput, inspectorInput, ...extra] = process.argv.slice(2);
  if (process.env.LEGACY_LINUX_CHILD_EXEC_GO !== '1' || mode !== '--linux-child-exec' || extra.length ||
      !output || !/\/TEST-[^/]+(?:\/[^/]+)*$/u.test(output) || !compilerInput || !inspectorInput)
    throw new Error('Explicit Linux helper staging selection required');
  const compiler = realpathSync(compilerInput), inspector = realpathSync(inspectorInput);
  const source = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '../native/linux-child-exec.c'));
  const selection = buildLinuxChildExecArtifact({ compiler, compilerSha256: hash(compiler),
    inspector, inspectorSha256: hash(inspector), source, sourceSha256: hash(source),
    outputDirectory: resolve(output) });
  console.log(JSON.stringify(selection));
}
