import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { classifyNativeVersion } from '../../../src/features/opencode-compatibility';
import { extractOpenCodePackage } from '../../../src/features/opencode-runtime-installer/main/infrastructure/packageExtraction';
import { selectOpenCodeInstallPackage } from '../../../src/features/opencode-runtime-installer/main/infrastructure/packageSelection';
import {
  managedFileIdentity,
  readManagedProjection,
  rememberManagedProjection,
} from '../../../src/main/services/infrastructure/openCodeRuntimeManagedProjection';
import { getOpenCodeRuntimePlatformCandidates } from '../../../src/main/services/infrastructure/openCodeRuntimeNativeSelection';
import { collectWindowsNativeOpenCodeBinaryCandidates } from '../../../src/main/services/infrastructure/openCodeWindowsNpmBinaryDiscovery';
import { detectOpenCodeNativeFacts } from '../../../src/main/services/runtime/openCodeNativePlatform';
import { runOpenCodeNativeProbe } from '../../../src/main/services/runtime/openCodeNativeProbe';
import { collectRuntimePathBinaryCandidates } from '../../../src/main/utils/runtimePathBinaryResolver';

import { acquire, metadata, sha256 } from './acquire.mts';
import { durable } from './observe.mts';

let phase = 'admission';

async function main(): Promise<void> {
  assert(process.env.GITHUB_ACTIONS === 'true', 'Physical vendor execution is CI-only');
  const [generation, version, expectedTarget] = process.argv.slice(2);
  assert(
    (generation === 'v1' && version === '1.18.34') || (generation === 'v2' && version === '2.1.4')
  );
  assert.equal(`${process.platform}-${process.arch}`, expectedTarget);
  assert.equal(JSON.parse(readFileSync('execution-entry.json', 'utf8')).entered, true);
  // Parent fsyncs execution-entry before spawning this worker. The first call may own OS probes.
  phase = 'native-facts';
  const facts = await detectOpenCodeNativeFacts();
  const candidates = await getOpenCodeRuntimePlatformCandidates();
  phase = 'package-selection';
  const selected = await selectOpenCodeInstallPackage(
    generation,
    generation === 'v2' ? version : null,
    candidates,
    (name, requested) => metadata(name, requested === 'latest' ? version : (requested ?? version))
  );
  assert.equal(selected.metadata.version, version);
  const nativeMetadata = await metadata(selected.packageName, version);
  phase = 'package-acquisition';
  const tarball = await acquire(nativeMetadata);
  const executableName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  phase = 'package-extraction';
  const extracted = extractOpenCodePackage(
    tarball,
    executableName,
    generation === 'v2' ? { packageName: selected.packageName, version } : undefined
  );
  const prefix = path.resolve('fixture-prefix');
  const rootName = generation === 'v2' ? '@opencode/cli' : 'opencode-ai';
  const rootPackage = path.join(prefix, 'node_modules', rootName);
  const nativePackage = path.join(rootPackage, 'node_modules', selected.packageName);
  const binary = path.join(nativePackage, 'bin', executableName);
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, extracted.binary, { flag: 'wx' });
  await chmod(binary, 0o755);
  await writeFile(
    path.join(nativePackage, 'package.json'),
    extracted.packageJson ?? JSON.stringify({ name: selected.packageName, version })
  );
  await mkdir(path.join(rootPackage, 'bin'), { recursive: true });
  await writeFile(
    path.join(rootPackage, 'package.json'),
    JSON.stringify(await metadata(rootName, version))
  );
  const shim = path.join(prefix, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
  await writeFile(shim, `node_modules/${rootName}/bin/opencode\n`);
  if (generation === 'v2' && process.platform === 'win32')
    await writeFile(path.join(rootPackage, 'bin', executableName), extracted.binary);
  phase = 'sandbox-discovery';
  const paths = collectRuntimePathBinaryCandidates({
    executableNames: [path.basename(shim)],
    additionalEnvSources: [{ PATH: prefix }],
    includeFallbackPathEntries: false,
  });
  assert.equal(paths[0], shim, 'Discovery did not begin at sandbox prefix');
  const discoveries =
    process.platform === 'win32'
      ? collectWindowsNativeOpenCodeBinaryCandidates(
          shim,
          candidates.map((item) => item.packageName)
        )
      : collectRuntimePathBinaryCandidates({
          executableNames: [executableName],
          additionalEnvSources: [{ PATH: path.dirname(binary) }],
          includeFallbackPathEntries: false,
        });
  assert.equal(discoveries[0], binary, 'Discovery selected another native delivery');
  const manifest = { binaryPath: binary };
  assert.equal(readManagedProjection(manifest, 1), null, 'Cold passive locator must not probe');
  const identity = managedFileIdentity(binary);
  // Production native-probe helper retains and settles only after the exact child/pipe close.
  phase = 'retained-version-child';
  const output = await runOpenCodeNativeProbe(discoveries[0], ['--version'], { timeoutMs: 3000 });
  const measured = classifyNativeVersion(output);
  assert.equal(measured.kind, 'recognized');
  assert(measured.kind === 'recognized');
  assert.equal(measured.version, version);
  assert.equal(measured.generation, generation);
  assert.equal(sha256(readFileSync(binary)), sha256(extracted.binary));
  phase = 'passive-projection';
  assert(rememberManagedProjection(manifest, identity, 1, manifest, 1));
  assert.equal(readManagedProjection(manifest, 1), binary);
  assert.equal(readManagedProjection(manifest, 2), null, 'Stale generation leaked a passive path');
  await writeFile(binary, Buffer.from('retired-fixture-after-closed-version-child'));
  assert.equal(readManagedProjection(manifest, 1), null, 'Changed image leaked a passive path');
  durable('terminal.json', {
    nativeClosed: true,
    generation,
    version,
    facts,
    candidates,
    selected: selected.packageName,
    archiveSha256: sha256(tarball),
    nativeSha256: sha256(extracted.binary),
    measured,
    engine: process.versions.bun ? 'bun-standalone-toolchain' : 'node',
    engineVersion: process.versions.bun ?? process.version,
    packagedRuntimeQualified: false,
  });
}
main().catch((error: unknown) => {
  const nativeClosureUnconfirmed =
    error instanceof Error &&
    'code' in error &&
    error.code === 'OPENCODE_NATIVE_PROBE_CLEANUP_UNCONFIRMED';
  durable('failure.json', {
    phase,
    nativeClosureUnconfirmed,
    nativeClosed: false,
    targetHalted: true,
  });
  // No terminal-success marker after any failure. Parent halts the target even if this wrapper closes.
  process.stderr.write('Selection failed after execution-entry; target must halt.\n');
  process.exitCode = 1;
});
