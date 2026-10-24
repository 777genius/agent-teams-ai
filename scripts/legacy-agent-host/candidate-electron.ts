import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candidateDigest } from './candidate-closure.ts';
import { readCandidateRuntimePaths } from './candidate-runtime-paths.ts';

/** TEST capture of one actual builder output. This helper never starts or repairs an app. */
export async function readCapturedCandidateElectron(selected: { path: string; sha256: string }) {
  const hash = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (
    !isAbsolute(selected.path) ||
    !hash(selected.sha256) ||
    (await realpath(selected.path)) !== selected.path
  )
    throw new Error('Packed Electron capture mismatch');
  const bytes = await readFile(selected.path);
  if (bytes.length > 32 * 1024) throw new Error('Packed Electron capture exceeds bound');
  if (createHash('sha256').update(bytes).digest('hex') !== selected.sha256)
    throw new Error('Packed Electron capture mismatch');
  const input = JSON.parse(bytes.toString('utf8')) as {
    schemaVersion: number;
    bundleRoot: string;
    executableName: string;
    executableSha256: string;
    appAsarSha256: string;
    candidateManifestSha256: string;
  };
  if (
    input.schemaVersion !== 1 ||
    process.platform !== 'darwin' ||
    !isAbsolute(input.bundleRoot) ||
    !input.bundleRoot.endsWith('.app') ||
    (await realpath(input.bundleRoot)) !== input.bundleRoot ||
    !/^[^/\\\0]+$/.test(input.executableName)
  )
    throw new Error('Packed Electron tuple/capture unavailable');
  const executable = join(input.bundleRoot, 'Contents/MacOS', input.executableName);
  const resources = join(input.bundleRoot, 'Contents/Resources');
  const appAsar = join(resources, 'app.asar');
  for (const [path, expected, native] of [
    [executable, input.executableSha256, true],
    [appAsar, input.appAsarSha256, false],
  ] as const) {
    const stat = await lstat(path);
    if (
      !hash(expected) ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (await realpath(path)) !== path ||
      (native && !(stat.mode & 0o111)) ||
      (await candidateDigest(path)) !== expected
    )
      throw new Error('Packed Electron output mismatch');
  }
  return {
    captureSha256: selected.sha256,
    executable,
    bundleRoot: input.bundleRoot,
    appAsar,
    appAsarSha256: input.appAsarSha256,
    executableSha256: input.executableSha256,
    rendererUrl: pathToFileURL(join(resources, 'app.asar/out/renderer/index.html')).href,
    runtime: await readCandidateRuntimePaths(
      join(resources, 'legacy-agent-host'),
      input.candidateManifestSha256
    ),
  };
}

/** Capture one completed builder output with exclusive creation; this does not launch it. */
export async function captureCandidateElectron(options: {
  bundleRoot: string;
  executableName: string;
  candidateManifestSha256: string;
  output: string;
}) {
  if (
    !isAbsolute(options.output) ||
    !/^[^/\\\0]+$/.test(options.executableName) ||
    !/^[a-f0-9]{64}$/.test(options.candidateManifestSha256)
  )
    throw new Error('Packed capture inputs invalid');
  const bundleRoot = await realpath(options.bundleRoot);
  const executable = join(bundleRoot, 'Contents/MacOS', options.executableName);
  const bytes = JSON.stringify({
    schemaVersion: 1,
    bundleRoot,
    executableName: options.executableName,
    executableSha256: await candidateDigest(executable),
    appAsarSha256: await candidateDigest(join(bundleRoot, 'Contents/Resources/app.asar')),
    candidateManifestSha256: options.candidateManifestSha256,
  });
  await writeFile(options.output, bytes + '\n', { mode: 0o600, flag: 'wx' });
  const selected = {
    path: await realpath(options.output),
    sha256: await candidateDigest(options.output),
  };
  const captured = await readCapturedCandidateElectron(selected);
  return {
    ...selected,
    nodeExecutable: captured.runtime.nodeExecutable,
    nodeSha256: captured.runtime.nodeSha256,
    hostEntrySha256: captured.runtime.hostEntrySha256,
    candidateManifestSha256: options.candidateManifestSha256,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [bundleRoot, executableName, candidateManifestSha256, output, ...extra] =
    process.argv.slice(2);
  if (!bundleRoot || !executableName || !candidateManifestSha256 || !output || extra.length)
    throw new Error(
      'Usage: candidate-electron.ts BUNDLE_ROOT EXECUTABLE_NAME CANDIDATE_MANIFEST_SHA256 NEW_CAPTURE_JSON'
    );
  process.stdout.write(
    JSON.stringify(
      await captureCandidateElectron({
        bundleRoot,
        executableName,
        candidateManifestSha256,
        output,
      })
    ) + '\n'
  );
}
