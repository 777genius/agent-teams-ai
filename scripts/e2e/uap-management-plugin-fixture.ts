import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const matrixPluginName = 'uap-desktop-plugin-matrix';
export const matrixSkillName = 'uap-desktop-matrix-guide';
export const matrixArchivePath = '/desktop-plugin-matrix.tar.gz';
export const matrixVersion = (revision: number) => `${revision}.0.0`;
export const matrixSkill = (revision: number) =>
  `---\nname: ${matrixSkillName}\ndescription: Inert desktop plugin lifecycle fixture\n---\nDesktop plugin matrix revision ${revision}.\n`;

// A moving HTTPS archive exercises a real source update. No executable, MCP
// server, security override or synthetic installed state is supplied here.
export async function createPluginMatrixFixture(root: string) {
  const revisions: { revision: number; version: string; archive: Buffer; sha256: string }[] = [];
  for (const revision of [1, 2]) {
    const source = path.join(root, `plugin-matrix-source-${revision}`);
    const skills = path.join(source, 'skills', matrixSkillName);
    await mkdir(skills, { recursive: true });
    await writeFile(
      path.join(source, 'plugin.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: matrixPluginName,
        version: matrixVersion(revision),
        description: 'Disposable three-client plugin lifecycle proof',
      })
    );
    await writeFile(path.join(skills, 'SKILL.md'), matrixSkill(revision));
    const file = path.join(root, `desktop-plugin-matrix-${revision}.tar.gz`);
    await run('tar', ['-czf', file, '-C', source, 'plugin.json', 'skills']);
    const archive = await readFile(file);
    revisions.push({
      revision,
      version: matrixVersion(revision),
      archive,
      sha256: createHash('sha256').update(archive).digest('hex'),
    });
  }
  assert.notEqual(revisions[0].sha256, revisions[1].sha256);
  let selected = 0;
  return {
    get archive() {
      return revisions[selected].archive;
    },
    advance() {
      assert.equal(selected, 0, 'The fixture has exactly one reviewed source update');
      selected = 1;
    },
    provenance: revisions.map(({ revision, version, sha256 }) => ({ revision, version, sha256 })),
  };
}
