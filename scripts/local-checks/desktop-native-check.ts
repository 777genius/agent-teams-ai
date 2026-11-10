/** Opt-in formatting feedback. Proposals are returned to the caller; no file writes. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { format, getFileInfo, resolveConfig } from 'prettier';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [mode, ...paths] = process.argv.slice(2);
if (!['--check', '--proposal'].includes(mode ?? '') || paths.length === 0) {
  throw new Error('Usage: desktop-native-check.ts --check|--proposal <explicit src paths...>');
}
const digest = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
let failed = false;
for (const path of paths) {
  const absolute = resolve(root, path);
  const local = relative(root, absolute);
  if (
    isAbsolute(local) || local.startsWith(`..${sep}`) ||
    !/^src\/.+\.(?:ts|tsx|js|jsx|json|css)$/.test(local.split(sep).join('/'))
  ) {
    throw new Error(`Outside current formatter eligibility: ${path}`);
  }
  // Check each component, including ancestors, so an in-tree symlink is rejected too.
  let cursor = absolute;
  while (cursor !== root) {
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`Symlink input: ${path}`);
    cursor = dirname(cursor);
  }
  if (!(await lstat(absolute)).isFile() || await realpath(absolute) !== absolute) {
    throw new Error(`Not a regular owned file: ${path}`);
  }
  const info = await getFileInfo(absolute, { ignorePath: resolve(root, '.prettierignore') });
  if (info.ignored) {
    process.stdout.write(`${JSON.stringify({ path: local, status: 'skipped', reason: 'Prettier ignore' })}\n`);
    continue;
  }
  const options = await resolveConfig(absolute);
  if (!options) throw new Error(`Missing Prettier configuration: ${path}`);
  const expected = await resolveConfig(absolute, { config: resolve(root, '.prettierrc.json') });
  const approved = JSON.stringify(options) === JSON.stringify(expected);
  const input = await readFile(absolute, 'utf8');
  let output: string;
  if (approved) {
    const result = spawnSync(process.execPath, [
      resolve(root, 'node_modules/oxfmt/bin/oxfmt'),
      '--config', resolve(root, '.oxfmtrc.json'), '--disable-nested-config', '--stdin-filepath', absolute,
    ], { cwd: root, input, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      throw result.error ?? new Error(result.stderr || `Oxfmt exit ${result.status}`);
    }
    output = result.stdout;
  } else {
    // Arbitrary user plugins/options stay with the installed Prettier API.
    output = await format(input, { ...options, filepath: absolute });
  }
  const changed = output !== input;
  failed ||= mode === '--check' && changed;
  process.stdout.write(`${JSON.stringify({
    path: local, status: changed ? 'different' : 'unchanged',
    engine: approved ? 'oxfmt' : 'prettier',
    reason: approved ? 'qualified baseline' : 'user configuration fallback',
    inputHash: digest(input), optionsHash: digest(JSON.stringify(options)),
    nativeConfigHash: digest(await readFile(resolve(root, '.oxfmtrc.json'))),
    ...(mode === '--proposal' ? { proposal: output } : {}),
  })}\n`);
}
process.exitCode = failed ? 1 : 0;
