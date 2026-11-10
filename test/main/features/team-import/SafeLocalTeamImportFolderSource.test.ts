import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  readBoundedTeamImportFileHandle,
  SafeLocalTeamImportFolderSource,
  TEAM_IMPORT_LIMITS,
} from '@features/team-import/main/infrastructure/SafeLocalTeamImportFolderSource';
import { afterEach, describe, expect, it } from 'vitest';

describe('SafeLocalTeamImportFolderSource', () => {
  const createdDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      createdDirectories
        .splice(0)
        .map((directory) => fs.rm(directory, { recursive: true, force: true }))
    );
  });

  async function createFixture(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-import-'));
    createdDirectories.push(root);
    await fs.mkdir(path.join(root, '.claude', 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.claude', 'agents', 'writer.md'),
      '---\nname: writer\n---\nWrite.',
      'utf8'
    );
    return root;
  }

  it('reads agent, root CLAUDE.md fallback, and skill definitions', async () => {
    const root = await createFixture();
    await fs.writeFile(path.join(root, 'CLAUDE.md'), '# Runtime workflow', 'utf8');
    await fs.mkdir(path.join(root, '.claude', 'skills', 'editing'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.claude', 'skills', 'editing', 'SKILL.md'),
      '---\nname: editing\n---\n',
      'utf8'
    );

    const snapshot = await new SafeLocalTeamImportFolderSource().inspect(root);

    expect(snapshot.agentFiles.map((file) => file.fileName)).toEqual(['writer.md']);
    expect(snapshot.claudeMd).toBe('# Runtime workflow');
    expect(snapshot.skills.map((skill) => skill.directoryName)).toEqual(['editing']);
    expect(snapshot.projectPath).toBe(await fs.realpath(root));
  });

  it('rejects a CLAUDE.md symlink that escapes the selected folder', async () => {
    if (process.platform === 'win32') return;
    const root = await createFixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'team-import-outside-'));
    createdDirectories.push(outside);
    const secret = path.join(outside, 'secret.md');
    await fs.writeFile(secret, 'SENSITIVE_SENTINEL', 'utf8');
    await fs.symlink(secret, path.join(root, 'CLAUDE.md'));

    await expect(new SafeLocalTeamImportFolderSource().inspect(root)).rejects.toThrow(
      'regular files'
    );
  });

  it('rejects symbolic links in an agents directory', async () => {
    if (process.platform === 'win32') return;
    const root = await createFixture();
    await fs.writeFile(path.join(root, 'real.md'), '# Real', 'utf8');
    await fs.symlink(path.join(root, 'real.md'), path.join(root, '.claude', 'agents', 'linked.md'));

    await expect(new SafeLocalTeamImportFolderSource().inspect(root)).rejects.toThrow(
      'symbolic links'
    );
  });

  it('rejects oversized agent definitions before returning their content', async () => {
    const root = await createFixture();
    await fs.writeFile(
      path.join(root, '.claude', 'agents', 'writer.md'),
      'x'.repeat(TEAM_IMPORT_LIMITS.maxAgentFileBytes + 1),
      'utf8'
    );

    await expect(new SafeLocalTeamImportFolderSource().inspect(root)).rejects.toThrow('too large');
  });

  it('bounds reads when an agent file grows after the opened-file stat', async () => {
    const root = await createFixture();
    const agentPath = path.join(root, '.claude', 'agents', 'writer.md');
    const handle = await fs.open(agentPath, 'r');
    try {
      const opened = await handle.stat();
      expect(opened.size).toBeLessThan(TEAM_IMPORT_LIMITS.maxAgentFileBytes);
      await fs.appendFile(agentPath, 'x'.repeat(TEAM_IMPORT_LIMITS.maxAgentFileBytes + 1));

      await expect(
        readBoundedTeamImportFileHandle({
          handle,
          filePath: agentPath,
          maxBytes: TEAM_IMPORT_LIMITS.maxAgentFileBytes,
        })
      ).rejects.toThrow('too large');
    } finally {
      await handle.close();
    }
  });

  it('rejects more than the configured number of agent definitions', async () => {
    const root = await createFixture();
    const agentsDirectory = path.join(root, '.claude', 'agents');
    await Promise.all(
      Array.from({ length: TEAM_IMPORT_LIMITS.maxAgentFiles }, (_, index) =>
        fs.writeFile(path.join(agentsDirectory, `member-${index}.md`), '# Agent', 'utf8')
      )
    );

    await expect(new SafeLocalTeamImportFolderSource().inspect(root)).rejects.toThrow(
      'too many agent files'
    );
  });

  it('enforces the aggregate byte budget across agent definitions', async () => {
    const root = await createFixture();
    const agentsDirectory = path.join(root, '.claude', 'agents');
    await fs.rm(path.join(agentsDirectory, 'writer.md'));
    const content = 'x'.repeat(TEAM_IMPORT_LIMITS.maxAgentFileBytes);
    await Promise.all(
      Array.from({ length: TEAM_IMPORT_LIMITS.maxAgentFiles }, (_, index) =>
        fs.writeFile(path.join(agentsDirectory, `member-${index}.md`), content, 'utf8')
      )
    );

    await expect(new SafeLocalTeamImportFolderSource().inspect(root)).rejects.toThrow(
      'too large to preview safely'
    );
  });

  it('rejects a sensitive directory even when it was selected directly', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'team-import-sensitive-'));
    createdDirectories.push(parent);
    const root = path.join(parent, '.ssh');
    await fs.mkdir(path.join(root, 'agents'), { recursive: true });
    await fs.writeFile(path.join(root, 'agents', 'writer.md'), '# Agent', 'utf8');

    await expect(new SafeLocalTeamImportFolderSource().inspect(root)).rejects.toThrow('sensitive');
  });
});
