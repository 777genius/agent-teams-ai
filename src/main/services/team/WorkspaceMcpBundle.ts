import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { execCli } from '@main/utils/childProcess';

interface BundleReceipt {
  inputs: string;
  entry: string;
  output: string;
}

interface WorkspaceBuild {
  receipt?: BundleReceipt;
  pending?: Promise<string>;
}

const workspaces = new Map<string, WorkspaceBuild>();
const BUILD_TIMEOUT_MS = 120_000;
const INPUT_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'mcp-server/package.json',
  'mcp-server/tsconfig.json',
  'mcp-server/tsup.config.ts',
  'agent-teams-controller/package.json',
];

async function fingerprintInputs(root: string): Promise<string> {
  const files = [...INPUT_FILES];
  const directories = new Set<string>();
  async function collect(directory: string): Promise<void> {
    const physical = await fs.realpath(path.join(root, directory));
    const relativePhysical = path.relative(root, physical);
    if (
      relativePhysical === '..' ||
      relativePhysical.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePhysical)
    ) {
      throw new Error('MCP_BUNDLE_SOURCE_LINK: MCP source directories must stay in the workspace.');
    }
    if (directories.has(physical)) {
      throw new Error('MCP_BUNDLE_SOURCE_LINK: MCP source directory cycle or alias.');
    }
    directories.add(physical);
    for (const item of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
      const relative = path.join(directory, item.name);
      if (item.isDirectory()) await collect(relative);
      else if (item.isFile()) files.push(relative);
      else if (item.isSymbolicLink()) {
        throw new Error('MCP_BUNDLE_SOURCE_LINK: Linked MCP source entries are unsupported.');
      }
    }
  }
  await collect('mcp-server/src');
  await collect('agent-teams-controller/src');
  const hash = createHash('sha256');
  for (const relative of files.toSorted((left, right) => left.localeCompare(right))) {
    const bytes = await fs.readFile(path.join(root, relative));
    hash.update(JSON.stringify([relative, bytes.length]));
    hash.update(bytes);
  }
  return hash.digest('hex');
}

async function outputHash(entry: string): Promise<string | null> {
  try {
    return createHash('sha256')
      .update(await fs.readFile(entry))
      .update('\0')
      .update(await fs.readFile(path.join(path.dirname(entry), 'package.json')))
      .digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function buildCurrentBundle(
  root: string,
  node: string,
  outputRoot: string,
  state: WorkspaceBuild
): Promise<string> {
  const inputs = await fingerprintInputs(root);
  if (state.receipt?.inputs === inputs) {
    if ((await outputHash(state.receipt.entry)) === state.receipt.output)
      return state.receipt.entry;
  }
  // Every app process builds once before trusting dist. Each generation has its
  // own directory, so rebuilding cannot remove a bundle another child is loading.
  // Retain app-owned generations across builds and app exit: saved launch
  // configs and native clients can outlive the development app process.
  state.receipt = undefined;
  const server = path.join(root, 'mcp-server');
  const outputDirectory = path.join(outputRoot, 'dev', `${process.pid}-${randomUUID()}`);
  const entry = path.join(outputDirectory, 'index.js');
  try {
    await execCli(
      node,
      [
        await fs.realpath(path.join(server, 'node_modules', 'tsup', 'dist', 'cli-default.js')),
        '--out-dir',
        outputDirectory,
      ],
      {
        cwd: server,
        timeout: BUILD_TIMEOUT_MS,
        stdoutMaxBuffer: 128 * 1024,
        stderrMaxBuffer: 128 * 1024,
      }
    );
    if ((await fingerprintInputs(root)) !== inputs) {
      throw new Error(
        'MCP_BUNDLE_INPUTS_CHANGED: MCP sources changed during the build; retry launch.'
      );
    }
    await fs.writeFile(path.join(outputDirectory, 'package.json'), '{"type":"module"}\n');
    const output = await outputHash(entry);
    if (!output) throw new Error('MCP_BUNDLE_MISSING: MCP build did not produce its entrypoint.');
    state.receipt = { inputs, entry, output };
    return entry;
  } catch (error) {
    await fs.rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** Compile before the client's handshake clock starts; never fall back to stale JS. */
export async function resolveWorkspaceMcpBundle(
  root: string,
  node: string,
  outputRoot: string
): Promise<string> {
  const workspace = await fs.realpath(root);
  const destination = path.resolve(outputRoot);
  const key = `${workspace}\0${destination}`;
  let state = workspaces.get(key);
  if (!state) {
    state = {};
    workspaces.set(key, state);
  }
  if (state.pending) return state.pending;
  const pending = buildCurrentBundle(workspace, node, destination, state);
  state.pending = pending;
  try {
    return await pending;
  } finally {
    state.pending = undefined;
  }
}
