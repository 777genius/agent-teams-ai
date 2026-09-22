import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const srcDir = path.join(packageRoot, 'src');
const distDir = path.join(packageRoot, 'dist');

async function copyRecursive(sourceDir, targetDir) {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyRecursive(sourcePath, targetPath);
      continue;
    }

    if (entry.isFile()) {
      await copyFile(sourcePath, targetPath);
    }
  }
}

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await copyRecursive(srcDir, distDir);
