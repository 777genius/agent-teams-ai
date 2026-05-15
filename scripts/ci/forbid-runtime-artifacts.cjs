const { execFileSync } = require('node:child_process');

const allowedRuntimeFiles = new Set(['resources/runtime/.gitkeep']);

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

const forbidden = trackedFiles().filter((file) => {
  if (file.startsWith('.runtime-download/')) return true;
  if (file.startsWith('resources/runtime/') && !allowedRuntimeFiles.has(file)) return true;
  return false;
});

if (forbidden.length > 0) {
  console.error('Runtime release artifacts must not be committed.');
  console.error('These files are downloaded from GitHub Releases during dev/release builds:');
  for (const file of forbidden) {
    console.error(`- ${file}`);
  }
  process.exit(1);
}

console.log('Runtime artifact guard passed.');
