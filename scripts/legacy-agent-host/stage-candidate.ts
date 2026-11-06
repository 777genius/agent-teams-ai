import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { stageNode } from './stage-node.ts';
import { readCandidateRuntimePaths } from './candidate-runtime-paths.ts';
import { stageCandidateNativeArtifacts } from './candidate-native.ts';
import { candidateDigest, stageCandidateClosure } from './candidate-closure.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
export interface CandidateStageOptions {
  repository?: string;
  /** New external directory only; never shipping resources or an existing output. */
  output: string;
  platform?: string;
  nativeCapture: { path: string; sha256: string };
}
/** Build-time opt-in only. Does not build, install, start providers or read private configuration. */
export async function stageCandidate(options: CandidateStageOptions) {
  const repo = await realpath(options.repository ?? repository);
  const platform = options.platform ?? `${process.platform}-${process.arch}`;
  // Native optional packages are qualified only against this installed tuple, not guessed cross-builds.
  if (platform !== `${process.platform}-${process.arch}` || process.platform === 'win32')
    throw new Error(
      'Candidate closure requires a matching installed Unix tuple; Windows relocation qualification remains open'
    );
  if (!isAbsolute(options.output)) throw new Error('Candidate output must be absolute');
  const output = join(await realpath(dirname(resolve(options.output))), basename(options.output));
  const external = relative(repo, output);
  if (!isAbsolute(options.output) || !(external === '..' || external.startsWith(`..${sep}`)))
    throw new Error('Candidate output must be a new external absolute directory');
  try {
    await lstat(output);
    throw new Error('Candidate output already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(dirname(output), `.candidate-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    const resourceRoot = join(temporary, 'legacy-agent-host');
    const packages = await stageCandidateClosure(repo, join(resourceRoot, 'host'));
    const host = packages.find((value) => value.name === '@agent-teams/legacy-agent-host');
    if (!host?.files.some((value) => value.path === 'dist/cli.js'))
      throw new Error('Build Host before candidate staging');
    for (const path of [
      'dist/process/readPackagedProcessArtifact.js',
      'dist/composition/processCustody.js',
      'dist/process/DarwinRegisteredProcess.js',
    ])
      if (!host.files.some((file) => file.path === path))
        throw new Error('Compiled M19 bridge absent from Host closure');
    const controller = packages.find((value) => value.name === 'agent-teams-controller');
    for (const path of ['src/internal/processes.js', 'src/internal/processStore.js'])
      if (!controller?.files.some((file) => file.path === path))
        throw new Error('M19 controller closure unavailable');
    const nativeArtifacts = await stageCandidateNativeArtifacts(
      resourceRoot,
      options.nativeCapture,
      platform
    );
    const node = await stageNode(platform, resourceRoot, join(repo, '.legacy-host-download'));
    const installed = JSON.parse(
      await readFile(join(repo, 'packages/legacy-agent-host/package.json'), 'utf8')
    ) as { dependencies: Record<string, string> };
    const artifacts: { name: string; sha256: string }[] = [];
    for (const name of [
      '@agent-teams/provider-implementations',
      '@agent-teams/provider-session-contracts',
    ]) {
      const dependency = installed.dependencies[name];
      if (!dependency?.startsWith('file:') || !dependency.endsWith('.tgz'))
        throw new Error('Provider artifact must be exact local tarball');
      const path = await realpath(resolve(repo, 'packages/legacy-agent-host', dependency.slice(5)));
      const packed = join(temporary, `packed-${artifacts.length}`);
      await mkdir(packed);
      const members = execFileSync('tar', ['-tf', path], {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      })
        .trim()
        .split('\n');
      if (
        members.some((member) => !member.startsWith('package/') || member.split('/').includes('..'))
      )
        throw new Error('Invalid packed provider member');
      execFileSync('tar', ['-xf', path, '-C', packed], { stdio: 'pipe' });
      const selected = packages.find((value) => value.name === name);
      if (!selected) throw new Error('Provider missing from candidate closure');
      for (const file of selected.files) {
        if ((await candidateDigest(join(packed, 'package', file.path))) !== file.sha256)
          throw new Error('Installed provider bytes differ from selected packed artifact');
      }
      const listed = new Set(
        members.filter((member) => !member.endsWith('/')).map((member) => member.slice(8))
      );
      if (
        listed.size !== selected.files.length ||
        selected.files.some((file) => !listed.has(file.path))
      )
        throw new Error('Packed provider census differs from installed closure');
      artifacts.push({ name, sha256: await candidateDigest(path) });
      await rm(packed, { recursive: true });
    }
    const sdk = packages.find((value) => value.name === '@anthropic-ai/claude-agent-sdk');
    const native = packages.find(
      (value) => value.name === `@anthropic-ai/claude-agent-sdk-${platform}`
    );
    if (
      !sdk ||
      !native ||
      sdk.version !== native.version ||
      !native.files.some((file) => file.executable)
    )
      throw new Error('Exact installed Claude SDK/native closure unavailable for candidate tuple');
    const manifest = {
      schemaVersion: 2,
      platform,
      nativeArtifacts,
      node,
      nodeExecutable: `node/v${node.version}/${platform}/${node.executable}`,
      hostEntry: `host/${host.path}/dist/cli.js`,
      hostEntrySha256: host.files.find((file) => file.path === 'dist/cli.js')!.sha256,
      packages,
      artifacts,
      qualification: { packedElectron: 'not-run', supportedTupleClaims: [] },
    };
    await writeFile(
      join(resourceRoot, 'candidate.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: 'wx' }
    );
    await readCandidateRuntimePaths(
      resourceRoot,
      await candidateDigest(join(resourceRoot, 'candidate.json'))
    );
    // Generated explicit builder config preserves generic terminal-platform packaging and native checks.
    const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')) as {
      build: {
        extraResources: { from: string; to: string }[];
        directories?: Record<string, string>;
      };
    };
    const build = {
      ...pkg.build,
      directories: { ...pkg.build.directories, output: join(output, 'packed') },
      extraResources: [
        ...pkg.build.extraResources.filter(
          (value) => value.to !== 'runtime' && value.to !== 'legacy-agent-host'
        ),
        { from: join(output, 'legacy-agent-host'), to: 'legacy-agent-host' },
      ],
    };
    await writeFile(
      join(temporary, 'electron-builder.candidate.json'),
      `${JSON.stringify(build, null, 2)}\n`,
      { flag: 'wx' }
    );
    await rename(temporary, output);
    return {
      output,
      platform,
      manifestSha256: await candidateDigest(join(output, 'legacy-agent-host/candidate.json')),
      builderConfig: join(output, 'electron-builder.candidate.json'),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, nativeCapturePath, nativeCaptureSha256, platform, ...extra] =
    process.argv.slice(2);
  if (!output || !nativeCapturePath || !nativeCaptureSha256 || extra.length)
    throw new Error(
      'Usage: stage-candidate.ts EXTERNAL_OUTPUT NATIVE_CAPTURE_JSON NATIVE_CAPTURE_SHA256 [OS-ARCH]'
    );
  process.stdout.write(
    `${JSON.stringify(await stageCandidate({ output, nativeCapture: { path: nativeCapturePath, sha256: nativeCaptureSha256 }, ...(platform ? { platform } : {}) }))}\n`
  );
}
