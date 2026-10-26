// Native CLI/file observations follow UAP's pinned native-client qualification
// contracts. They prove registry visibility and delivered bytes, not model use.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  matrixPluginName,
  matrixSkill,
  matrixSkillName,
  matrixVersion,
} from './uap-management-plugin-fixture';

import type {
  ExtensionClient,
  ManagementEnvironment,
} from '../../src/features/extension-management/contracts';

const run = promisify(execFile);
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
type Binding = ManagementEnvironment['entries'][number]['bindings'][number];
export interface MatrixNativeContext {
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  binaries: Record<ExtensionClient, string>;
}
export interface MatrixNativeObservation {
  client: ExtensionClient;
  present: boolean;
  nativeIdentity?: string;
  nativeMarketplace?: string;
  nativeSource?: string;
  nativeListingSHA256: string;
  files: { path: string; sha256: string }[];
  removedFiles?: string[];
  absentBeforeAndAfterNativeListing?: boolean;
}

function object(value: unknown): Record<string, unknown> {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    'Expected native JSON object'
  );
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  assert(Array.isArray(value), 'Expected complete native JSON array');
  return value;
}
function owned(root: string, file: string) {
  assert(
    path.isAbsolute(file) && path.normalize(file) === file && file.startsWith(root + path.sep),
    'Native evidence must remain inside this disposable fixture'
  );
}
async function contents(root: string, file: string) {
  owned(root, file);
  owned(root, await realpath(file));
  return readFile(file);
}
async function absent(file: string) {
  await assert.rejects(
    lstat(file),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    `Removed native file must be absent: ${file}`
  );
}

async function nativeJSON(
  f: MatrixNativeContext,
  client: ExtensionClient,
  stage: string,
  args: string[]
) {
  const cwd = path.join(f.root, 'plugin-matrix-observer');
  await mkdir(cwd, { recursive: true });
  const log = path.join(f.root, `desktop-matrix-${client}-${stage}.log`);
  try {
    const execution = run(f.binaries[client], args, {
      cwd,
      env: f.env,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      killSignal: 'SIGKILL',
    });
    execution.child.stdin?.end();
    const output = await execution;
    await writeFile(log, output.stdout + output.stderr);
    return { value: JSON.parse(output.stdout) as unknown, sha256: digest(output.stdout) };
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string };
    await writeFile(log, `\n${String(error)}\n${output.stdout ?? ''}${output.stderr ?? ''}`, {
      flag: 'a',
    });
    throw error;
  }
}

export async function observeMatrixNative(
  f: MatrixNativeContext,
  client: ExtensionClient,
  stage: string,
  binding: Binding | undefined,
  revision: number,
  previous?: MatrixNativeObservation
): Promise<MatrixNativeObservation> {
  const removedFiles = !binding ? previous?.files.map((file) => file.path) : undefined;
  if (!binding) {
    assert(
      previous?.present && removedFiles?.length,
      'Removal needs the previously observed native files'
    );
    for (const file of removedFiles) await absent(file);
  }
  const command = client === 'opencode' ? ['debug', 'skill'] : ['plugin', 'list', '--json'];
  const listing = await nativeJSON(f, client, stage, command);
  const result: MatrixNativeObservation = {
    client,
    present: Boolean(binding),
    nativeListingSHA256: listing.sha256,
    files: [],
  };
  const rows = (
    client === 'codex' ? array(object(listing.value).installed) : array(listing.value)
  ).map(object);
  const matches = rows.filter((row) =>
    client === 'claude'
      ? row.id === `${matrixPluginName}@skills-dir`
      : row.name === (client === 'codex' ? matrixPluginName : matrixSkillName)
  );
  assert.equal(
    matches.length,
    binding ? 1 : 0,
    `${client}: exact native identity must match managed state`
  );
  if (!binding) {
    result.removedFiles = removedFiles!;
    for (const file of result.removedFiles) await absent(file);
    result.absentBeforeAndAfterNativeListing = true;
    return result;
  }
  assert.equal(binding.client, client);
  assert.equal(binding.status, 'installed');
  assert.equal(binding.scope, 'user');
  const row = matches[0];
  let skillPath: string;
  let manifestPath: string | undefined;
  if (client === 'opencode') {
    skillPath = path.join(f.env.OPENCODE_CONFIG_DIR!, 'skills', matrixSkillName, 'SKILL.md');
    assert.equal(row.location, skillPath, 'OpenCode must discover its actual projected Skill');
    assert.equal(typeof row.content, 'string');
    assert.equal((row.content as string).trim(), `Desktop plugin matrix revision ${revision}.`);
    assert(
      binding.managedPaths.includes(path.dirname(skillPath)),
      'OpenCode projection must be covered by managed receipts'
    );
    result.nativeIdentity = matrixSkillName;
    result.nativeSource = skillPath;
  } else if (client === 'claude') {
    assert.equal(row.enabled, true);
    assert.equal(row.scope, 'user');
    assert.equal(row.version, matrixVersion(revision));
    assert.equal(typeof row.installPath, 'string');
    const installPath = row.installPath as string;
    assert(
      binding.managedPaths.includes(installPath),
      'Claude native identity must equal the managed installation'
    );
    skillPath = path.join(
      installPath,
      '.agentplugins-runtime',
      'skills',
      matrixSkillName,
      'SKILL.md'
    );
    manifestPath = path.join(installPath, '.claude-plugin', 'plugin.json');
    result.nativeIdentity = row.id as string;
    result.nativeSource = installPath;
  } else {
    assert.equal(row.installed, true);
    assert.equal(row.enabled, true);
    assert.equal(typeof row.version, 'string');
    const version = row.version as string;
    assert.equal(
      version,
      matrixVersion(revision),
      'Codex must report the reviewed installed version'
    );
    assert(/^[a-zA-Z0-9._-]+$/.test(version));
    assert.equal(typeof row.marketplaceName, 'string');
    const marketplace = row.marketplaceName as string;
    assert(/^[a-zA-Z0-9._-]+$/.test(marketplace));
    assert.equal(row.pluginId, `${matrixPluginName}@${marketplace}`);
    const source = object(row.source).path;
    assert.equal(typeof source, 'string');
    assert(
      binding.managedPaths.includes(source as string),
      'Codex CLI must report the exact managed source'
    );
    // Codex keys the cache by manifest version; "local" is only an unversioned fallback.
    const cache = path.join(
      f.env.CODEX_HOME!,
      'plugins',
      'cache',
      marketplace,
      matrixPluginName,
      version
    );
    skillPath = path.join(cache, 'skills', matrixSkillName, 'SKILL.md');
    manifestPath = path.join(cache, '.codex-plugin', 'plugin.json');
    result.nativeIdentity = row.pluginId as string;
    result.nativeMarketplace = marketplace;
    result.nativeSource = source as string;
    const sourceSkill = path.join(source as string, 'skills', matrixSkillName, 'SKILL.md');
    const sourceBody = await contents(f.root, sourceSkill);
    assert.equal(sourceBody.toString('utf8'), matrixSkill(revision));
    result.files.push({ path: sourceSkill, sha256: digest(sourceBody) });
  }
  const body = await contents(f.root, skillPath);
  assert.equal(
    body.toString('utf8'),
    matrixSkill(revision),
    `${client}: native delivered bytes must match the reviewed revision`
  );
  result.files.push({ path: skillPath, sha256: digest(body) });
  if (manifestPath) {
    const body = await contents(f.root, manifestPath);
    const manifest = object(JSON.parse(body.toString('utf8')));
    assert.equal(manifest.name, matrixPluginName);
    assert.equal(manifest.version, matrixVersion(revision));
    result.files.push({ path: manifestPath, sha256: digest(body) });
  }
  return result;
}

// Codex requires an explicit external-uninstall acknowledgment. Perform its
// documented native prerequisite before the UI can truthfully acknowledge it.
export async function removeMatrixCodexNative(
  f: MatrixNativeContext,
  observation: MatrixNativeObservation
) {
  assert.equal(observation.client, 'codex');
  assert(observation.present && observation.nativeIdentity && observation.nativeMarketplace);
  assert.equal(observation.nativeIdentity, `${matrixPluginName}@${observation.nativeMarketplace}`);
  await nativeJSON(f, 'codex', 'external-uninstall', [
    'plugin',
    'remove',
    observation.nativeIdentity,
    '--json',
  ]);
  await nativeJSON(f, 'codex', 'external-marketplace-uninstall', [
    'plugin',
    'marketplace',
    'remove',
    observation.nativeMarketplace,
    '--json',
  ]);
  const after = await nativeJSON(f, 'codex', 'external-uninstall-confirmed', [
    'plugin',
    'list',
    '--json',
  ]);
  assert(
    !array(object(after.value).installed)
      .map(object)
      .some((row) => row.pluginId === observation.nativeIdentity),
    'Codex must confirm native removal before the UI acknowledgment'
  );
  return {
    pluginId: observation.nativeIdentity,
    marketplace: observation.nativeMarketplace,
    nativeRemovalConfirmed: true,
    nativeListingSHA256: after.sha256,
  };
}
