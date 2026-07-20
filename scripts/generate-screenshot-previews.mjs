import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { screenshots } from '../landing/data/screenshots.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const screenshotsDir = resolve(repoRoot, 'docs/screenshots');
const previewsDir = resolve(screenshotsDir, 'previews');
const staticEntries = [
  ...screenshots.map(({ path, previewPath }) => ({
    source: path.replace(/^screenshots\//, ''),
    preview: previewPath.replace(/^screenshots\//, ''),
  })),
  {
    source: 'overview.jpg',
    preview: 'previews/overview.webp',
  },
];

const magickCheck = spawnSync('magick', ['-version'], { stdio: 'ignore' });
if (magickCheck.error || magickCheck.status !== 0) {
  console.error('ImageMagick is required. Install it, then run this command again.');
  process.exit(1);
}

const ffmpegCheck = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
if (ffmpegCheck.error || ffmpegCheck.status !== 0) {
  console.error('FFmpeg is required for the animated GIF preview.');
  process.exit(1);
}

mkdirSync(previewsDir, { recursive: true });

for (const { source, preview } of staticEntries) {
  const inputPath = resolve(screenshotsDir, source);
  const outputPath = resolve(screenshotsDir, preview);
  const result = spawnSync(
    'magick',
    [
      inputPath,
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

const animatedResult = spawnSync(
  'ffmpeg',
  [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    resolve(screenshotsDir, 'task-detail-animated.gif'),
    '-filter_complex',
    'fps=15,scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
    '-loop',
    '0',
    resolve(previewsDir, 'task-detail-animated.gif'),
  ],
  { stdio: 'inherit' }
);

if (animatedResult.error || animatedResult.status !== 0) {
  process.exit(animatedResult.status ?? 1);
}

console.log(
  `Generated ${staticEntries.length} static previews and 1 animated preview in ${previewsDir}`
);
