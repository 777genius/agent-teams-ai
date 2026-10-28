import { stripTypeScriptTypes } from 'node:module';
import { copyFile, mkdir, readdir, rm, readFile, writeFile } from 'node:fs/promises';
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
      if (entry.name.endsWith('.ts')) {
        const source = await readFile(sourcePath, 'utf8');
        await writeFile(
          targetPath.replace(/\.ts$/, '.js'),
          stripTypeScriptTypes(source).replaceAll(
            './windowsPrivateAcl.ts',
            './windowsPrivateAcl.js'
          )
        );
      } else if (['runtime.js', 'workSync.js', 'desktopControlBinding.js'].includes(entry.name)) {
        await writeFile(
          targetPath,
          (await readFile(sourcePath, 'utf8')).replaceAll(
            './controlApiAuth.ts',
            './controlApiAuth.js'
          )
        );
      } else {
        await copyFile(sourcePath, targetPath);
      }
    }
  }
}

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await copyRecursive(srcDir, distDir);
