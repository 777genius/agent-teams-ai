import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { screenshots } from '../landing/data/screenshots.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const screenshotsDir = resolve(repoRoot, 'docs/screenshots');
const previewsDir = resolve(screenshotsDir, 'previews');
const entries = [
  ...screenshots.map(({ path, previewPath }) => ({
    source: path.replace(/^screenshots\//, ''),
    preview: previewPath.replace(/^screenshots\//, ''),
  })),
  {
    source: 'task-detail-animated.gif',
    preview: 'previews/task-detail-animated.webp',
  },
];

const commandCheck = spawnSync('magick', ['-version'], { stdio: 'ignore' });
if (commandCheck.error || commandCheck.status !== 0) {
  console.error('ImageMagick is required. Install it, then run this command again.');
  process.exit(1);
}

mkdirSync(previewsDir, { recursive: true });

for (const { source, preview } of entries) {
  const inputPath = resolve(screenshotsDir, source);
  const outputPath = resolve(screenshotsDir, preview);
  const input = source.endsWith('.gif') ? `${inputPath}[0]` : inputPath;
  const result = spawnSync(
    'magick',
    [
      input,
      '-auto-orient',
      '-thumbnail',
      '800x800>',
      '-strip',
      '-quality',
      '72',
      '-define',
      'webp:method=6',
      outputPath,
    ],
    { stdio: 'inherit' }
  );

  if (result.error || result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`Generated ${entries.length} previews in ${previewsDir}`);
