#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { z } from 'zod';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdkRoot = path.join(repositoryRoot, 'vendor', 'uap', 'sdk');
const outputRoot = path.join(repositoryRoot, 'resources', 'uap');
const upstream = 'https://github.com/777genius/universal-agent-plugins.git';
const platforms = new Map<string, [string, string]>([
  ['linux-x64', ['linux', 'amd64']],
  ['linux-arm64', ['linux', 'arm64']],
  ['darwin-x64', ['darwin', 'amd64']],
  ['darwin-arm64', ['darwin', 'arm64']],
  ['win32-x64', ['windows', 'amd64']],
  ['win32-arm64', ['windows', 'arm64']],
]);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

interface StageOptions {
  platform?: string;
  source?: string;
  ensure?: boolean;
}
interface CommandOptions {
  capture?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}
const provenanceSchema = z.object({
  repository: z.literal('777genius/universal-agent-plugins'),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  file: z.string().regex(/^uap-management-sdk-[A-Za-z0-9.+-]+\.tgz$/),
});
const runtimeSchema = z.object({
  schemaVersion: z.literal(1),
  sourceSha: z.string(),
  platform: z.string(),
  sha256: z.string(),
  executable: z.string(),
});
async function run(command: string, args: string[], options: CommandOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const { capture, ...spawnOptions } = options;
    const child = spawn(command, args, {
      shell: false,
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      ...spawnOptions,
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${command} failed (${signal ?? code}).`));
    });
  });
}

export async function stageUapRuntime({
  platform = `${process.platform}-${process.arch}`,
  source,
  ensure = false,
}: StageOptions = {}): Promise<void> {
  const target = platforms.get(platform);
  if (!target) throw new Error(`UAP does not support the packaging target ${platform}.`);
  const provenance = provenanceSchema.parse(
    JSON.parse(await readFile(path.join(sdkRoot, 'provenance.json'), 'utf8'))
  );
  if (sha256(await readFile(path.join(sdkRoot, provenance.file))) !== provenance.sha256) {
    throw new Error('The vendored UAP SDK tarball does not match its pinned checksum.');
  }
  const executable = platform.startsWith('win32-') ? 'agentplugins.exe' : 'agentplugins';
  if (ensure) {
    try {
      const staged = runtimeSchema.parse(
        JSON.parse(await readFile(path.join(outputRoot, 'runtime.json'), 'utf8'))
      );
      if (
        staged.sourceSha === provenance.sourceCommit &&
        staged.platform === platform &&
        staged.executable === executable &&
        staged.sha256 === sha256(await readFile(path.join(outputRoot, executable)))
      )
        return;
    } catch (error) {
      if (
        !(
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        ) &&
        !(error instanceof SyntaxError) &&
        !(error instanceof z.ZodError)
      )
        throw error;
    }
  }
  await mkdir(outputRoot, { recursive: true });
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agent-teams-uap-build-'));
  const checkout = path.join(workspace, 'source');
  const output = path.join(workspace, executable);
  try {
    await mkdir(checkout);
    if (source) {
      const actual = await run('git', ['-C', source, 'rev-parse', 'HEAD'], { capture: true });
      if (actual !== provenance.sourceCommit)
        throw new Error('The local UAP checkout is not at the reviewed SDK source commit.');
      const archive = path.join(workspace, 'source.tar');
      // Archive committed files, never a dirty local checkout or ignored build input.
      await run('git', [
        '-C',
        source,
        'archive',
        '--format=tar',
        '--output',
        archive,
        provenance.sourceCommit,
      ]);
      await run('tar', ['-xf', archive, '-C', checkout]);
    } else {
      await run('git', ['init', '--quiet', checkout]);
      await run('git', ['-C', checkout, 'remote', 'add', 'origin', upstream]);
      await run('git', [
        '-C',
        checkout,
        'fetch',
        '--quiet',
        '--depth=1',
        'origin',
        provenance.sourceCommit,
      ]);
      await run('git', ['-C', checkout, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
      if (
        (await run('git', ['-C', checkout, 'rev-parse', 'HEAD'], { capture: true })) !==
        provenance.sourceCommit
      )
        throw new Error('The fetched UAP source does not match its pin.');
    }
    const toolchain = (await readFile(path.join(checkout, 'go.work'), 'utf8')).match(
      /^toolchain (go\d+\.\d+\.\d+)$/m
    )?.[1];
    if (!toolchain) throw new Error('The pinned UAP source must declare its Go toolchain.');
    await run(
      'go',
      [
        'build',
        '-trimpath',
        '-buildvcs=false',
        '-mod=readonly',
        '-ldflags',
        `-s -w -X main.version=0.1.0-development+agentteams.${provenance.sourceCommit.slice(0, 12)}`,
        '-o',
        output,
        './cmd/agentplugins',
      ],
      {
        cwd: path.join(checkout, 'cli'),
        env: {
          ...process.env,
          GOTOOLCHAIN: toolchain,
          CGO_ENABLED: '0',
          GOOS: target[0],
          GOARCH: target[1],
        },
      }
    );
    const digest = sha256(await readFile(output));
    const staged = path.join(outputRoot, `${executable}.${randomUUID()}.tmp`);
    await copyFile(output, staged);
    await chmod(staged, 0o755);
    await rename(staged, path.join(outputRoot, executable));
    await copyFile(path.join(checkout, 'LICENSE'), path.join(outputRoot, 'LICENSE'));
    await copyFile(
      path.join(checkout, 'cli', 'THIRD_PARTY_NOTICES.txt'),
      path.join(outputRoot, 'THIRD_PARTY_NOTICES.txt')
    );
    const manifest = {
      schemaVersion: 1,
      sourceSha: provenance.sourceCommit,
      platform,
      sha256: digest,
      executable,
    };
    const manifestStage = path.join(outputRoot, `runtime.${randomUUID()}.tmp`);
    await writeFile(manifestStage, JSON.stringify(manifest, null, 2) + '\n');
    await rename(manifestStage, path.join(outputRoot, 'runtime.json'));
    process.stdout.write(`Staged UAP ${provenance.sourceCommit} for ${platform}: ${digest}\n`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const options: StageOptions = {};
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === '--ensure') options.ensure = true;
    else if (argument === '--platform' || argument === '--source') {
      const value = process.argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      if (argument === '--platform') options.platform = value;
      else options.source = value;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  await stageUapRuntime(options);
}
