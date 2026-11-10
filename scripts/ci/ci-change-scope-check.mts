import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { collectChangeScope } from './ci-change-scope.mts';

const result = collectChangeScope(process.env);
if (!['docs', 'assets', 'dmg'].includes(result.scope))
  throw new Error('Focused validation requires proven scope');
if (process.argv[2] === 'format') {
  const paths = result.paths.filter((path) => /\.(md|json)$/.test(path) && existsSync(path));
  if (paths.length > 0)
    execFileSync(
      'pnpm',
      [
        'dlx',
        'prettier@3.8.1',
        '--config',
        'scripts/ci/ci-focused-prettier.json',
        '--check',
        ...paths,
      ],
      { stdio: 'inherit' }
    );
} else {
  if (result.scope !== process.env.EXPECTED_SCOPE) throw new Error('Scope differs from plan');
  for (const path of result.paths) {
    if (path === 'package.json') JSON.parse(readFileSync(path, 'utf8'));
    if (/\.(png|jpe?g|webp|gif|ico|icns)$/i.test(path)) {
      const bytes = readFileSync(path);
      if (bytes.length > 20 * 1024 * 1024 || bytes.length < 24)
        throw new Error('Invalid DMG asset size');
      if (/\.jpe?g$/i.test(path) && bytes.subarray(0, 3).toString('hex') !== 'ffd8ff')
        throw new Error('Invalid JPEG');
      if (
        /\.webp$/i.test(path) &&
        (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP')
      )
        throw new Error('Invalid WebP');
      if (/\.gif$/i.test(path) && !['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)))
        throw new Error('Invalid GIF');
      if (/\.png$/i.test(path)) {
        if (
          bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
          bytes.toString('ascii', 12, 16) !== 'IHDR'
        )
          throw new Error('Invalid PNG');
        const width = bytes.readUInt32BE(16);
        const height = bytes.readUInt32BE(20);
        if (!width || !height || width > 8192 || height > 8192)
          throw new Error('Invalid PNG dimensions');
      }
    }
  }
  console.log(`Validated ${result.scope}: ${result.paths.length} paths`);
}
