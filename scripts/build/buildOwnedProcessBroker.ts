import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyBrokerArchitecture(bytes: Buffer, arch: 'x64' | 'arm64'): void {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Missing PE image');
  const offset = bytes.readUInt32LE(60);
  if (offset > bytes.length - 24 || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0' ||
    bytes.readUInt16LE(offset + 4) !== (arch === 'x64' ? 0x8664 : 0xaa64)) {
    throw new Error('Broker architecture mismatch');
  }
}
export function buildAndStageBroker(repository: string, arch: 'x64' | 'arm64', buildDir: string, stageDir: string, cmakeExecutable: string): void {
  if (process.platform !== 'win32') throw new Error('Use a Windows SDK/MSVC build host');
  if (!isAbsolute(cmakeExecutable) || cmakeExecutable.includes('\0') ||
    basename(cmakeExecutable).toLowerCase() !== 'cmake.exe' || !statSync(cmakeExecutable).isFile()) {
    throw new Error('Provide an absolute installed cmake.exe path');
  }
  const source = join(repository, 'tools/owned-process-broker');
  const run = (args: string[]): void => {
    const result = spawnSync(cmakeExecutable, args, { stdio: 'inherit', timeout: 120000 });
    if (result.error || result.status !== 0) throw new Error('Native build failed');
  };
  run(['-S', source, '-B', buildDir, '-A', arch === 'x64' ? 'x64' : 'ARM64']);
  run(['--build', buildDir, '--config', 'Release']);
  const built = join(buildDir, 'Release/owned-process-broker.exe');
  const bytes = readFileSync(built); verifyBrokerArchitecture(bytes, arch);
  mkdirSync(stageDir, { recursive: true });
  const target = join(stageDir, 'owned-process-broker.exe'); copyFileSync(built, target);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (createHash('sha256').update(readFileSync(target)).digest('hex') !== hash) throw new Error('Staged hash mismatch');
  writeFileSync(join(stageDir, 'manifest.json'), `${JSON.stringify({ schema: 1, platform: 'win32', arch,
    file: 'owned-process-broker.exe', sha256: hash, protocol: 1 }, null, 2)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [arch, buildDir, stageDir, cmakeExecutable] = process.argv.slice(2);
  if ((arch !== 'x64' && arch !== 'arm64') || !buildDir || !stageDir || !cmakeExecutable) {
    throw new Error('Usage: buildOwnedProcessBroker.ts x64|arm64 isolated-build-dir explicit-stage-dir absolute-cmake-exe');
  }
  buildAndStageBroker(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), arch, resolve(buildDir), resolve(stageDir), cmakeExecutable);
}
