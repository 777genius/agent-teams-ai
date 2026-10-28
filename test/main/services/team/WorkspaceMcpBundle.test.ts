import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveWorkspaceMcpBundle } from '@main/services/team/WorkspaceMcpBundle';
import { execCli } from '@main/utils/childProcess';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMcpDeploymentManifest } from '../../../../mcp-server/deploymentManifest';

vi.mock('@main/utils/childProcess', () => ({ execCli: vi.fn() }));

describe('workspace MCP bundle freshness', () => {
  let root: string;
  let revision: number;
  const outputRoot = () => path.join(root, 'retained-mcp');
  const manifestSource = {
    name: 'agent-teams-mcp',
    version: '1.0.0',
    engines: { node: '>=24.15.0 <25 || >=26 <27' },
  };

  async function write(relative: string, content: string): Promise<void> {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }

  async function produceBundle(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const output = args[args.indexOf('--out-dir') + 1];
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'index.js'), `// bundle ${++revision}`);
    await fs.writeFile(
      path.join(output, 'package.json'),
      JSON.stringify(createMcpDeploymentManifest(manifestSource))
    );
    return { stdout: '', stderr: '' };
  }

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-mcp-bundle-')));
    revision = 0;
    for (const relative of [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'mcp-server/package.json',
      'mcp-server/tsconfig.json',
      'mcp-server/tsup.config.ts',
      'mcp-server/deploymentManifest.ts',
      'agent-teams-controller/package.json',
      'mcp-server/src/index.ts',
      'agent-teams-controller/src/index.js',
      'mcp-server/node_modules/tsup/dist/cli-default.js',
    ])
      await write(relative, 'initial');
    vi.mocked(execCli).mockReset();
    vi.mocked(execCli).mockImplementation(async (_node, args) => produceBundle(args));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('builds before trusting preexisting dist and reuses only unchanged verified output', async () => {
    await write('mcp-server/dist/index.js', '// stale compiled code');
    const entry = await resolveWorkspaceMcpBundle(root, '/selected/node', outputRoot());

    expect(await fs.readFile(entry, 'utf8')).toBe('// bundle 1');
    expect(entry.startsWith(path.join(outputRoot(), 'dev') + path.sep)).toBe(true);
    expect(
      JSON.parse(await fs.readFile(path.join(path.dirname(entry), 'package.json'), 'utf8'))
    ).toEqual(createMcpDeploymentManifest(manifestSource));
    await fs.rm(path.join(root, 'mcp-server/dist'), { recursive: true });
    expect(await fs.readFile(entry, 'utf8')).toBe('// bundle 1');
    expect(execCli).toHaveBeenCalledWith(
      '/selected/node',
      [
        path.join(root, 'mcp-server/node_modules/tsup/dist/cli-default.js'),
        '--out-dir',
        path.dirname(entry),
      ],
      expect.objectContaining({ cwd: path.join(root, 'mcp-server') })
    );
    expect(await resolveWorkspaceMcpBundle(root, '/selected/node', outputRoot())).toBe(entry);
    expect(execCli).toHaveBeenCalledTimes(1);
  });

  it('shares a concurrent build and retains previous generations when inputs change', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(execCli).mockImplementationOnce(async (_node, args) => {
      await gate;
      return produceBundle(args);
    });
    const first = resolveWorkspaceMcpBundle(root, '/node', outputRoot());
    const concurrent = resolveWorkspaceMcpBundle(root, '/node', outputRoot());
    release();
    const [firstEntry, sameEntry] = await Promise.all([first, concurrent]);
    expect(sameEntry).toBe(firstEntry);
    expect(execCli).toHaveBeenCalledTimes(1);

    for (const relative of [
      'mcp-server/src/index.ts',
      'agent-teams-controller/src/index.js',
      'pnpm-lock.yaml',
      'mcp-server/tsup.config.ts',
      'mcp-server/deploymentManifest.ts',
    ]) {
      const target = path.join(root, relative);
      const before = await fs.stat(target);
      await write(relative, 'changed'); // Same byte length and mtime: freshness uses content.
      await fs.utimes(target, before.atime, before.mtime);
      expect(await resolveWorkspaceMcpBundle(root, '/node', outputRoot())).not.toBe(firstEntry);
    }
    expect(execCli).toHaveBeenCalledTimes(6);
    expect(await fs.readFile(firstEntry, 'utf8')).toBe('// bundle 1');
  });

  it('rebuilds modified or missing output even when inputs have not changed', async () => {
    const first = await resolveWorkspaceMcpBundle(root, '/node', outputRoot());
    await fs.writeFile(first, '// overwritten');
    const second = await resolveWorkspaceMcpBundle(root, '/node', outputRoot());
    expect(second).not.toBe(first);
    await fs.writeFile(path.join(path.dirname(second), 'package.json'), '{}');
    expect(await resolveWorkspaceMcpBundle(root, '/node', outputRoot())).not.toBe(second);
    expect(execCli).toHaveBeenCalledTimes(3);
  });

  it('rejects inputs changed during compilation and removes only the failed generation', async () => {
    const previous = await resolveWorkspaceMcpBundle(root, '/node', outputRoot());
    await write('mcp-server/src/new.ts', '// new source');
    let failedDirectory = '';
    vi.mocked(execCli).mockImplementationOnce(async (_node, args) => {
      failedDirectory = args[args.indexOf('--out-dir') + 1];
      await write('agent-teams-controller/src/index.js', '// changed during build');
      return produceBundle(args);
    });
    await expect(resolveWorkspaceMcpBundle(root, '/node', outputRoot())).rejects.toThrow(
      'MCP_BUNDLE_INPUTS_CHANGED'
    );
    await expect(fs.access(failedDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(previous, 'utf8')).toBe('// bundle 1');
    expect(await resolveWorkspaceMcpBundle(root, '/node', outputRoot())).not.toBe(previous);
  });

  it('propagates build failure without a stale fallback and permits a later fresh attempt', async () => {
    const previous = await resolveWorkspaceMcpBundle(root, '/node', outputRoot());
    await write('mcp-server/src/index.ts', '// next version');
    vi.mocked(execCli).mockRejectedValueOnce(new Error('compiler failed'));
    await expect(resolveWorkspaceMcpBundle(root, '/node', outputRoot())).rejects.toThrow(
      'compiler failed'
    );
    expect(await resolveWorkspaceMcpBundle(root, '/node', outputRoot())).not.toBe(previous);
  });

  it('rejects source links before invoking the compiler', async () => {
    await fs.symlink(root, path.join(root, 'mcp-server/src/cycle'), 'junction');
    await expect(resolveWorkspaceMcpBundle(root, '/node', outputRoot())).rejects.toThrow(
      'MCP_BUNDLE_SOURCE_LINK'
    );
    expect(execCli).not.toHaveBeenCalled();
    await fs.rm(path.join(root, 'mcp-server/src'), { recursive: true });
    await fs.symlink(path.dirname(root), path.join(root, 'mcp-server/src'), 'junction');
    await expect(resolveWorkspaceMcpBundle(root, '/node', outputRoot())).rejects.toThrow(
      'MCP_BUNDLE_SOURCE_LINK'
    );
    expect(execCli).not.toHaveBeenCalled();
  });
});
