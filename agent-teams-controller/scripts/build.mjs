import { stripTypeScriptTypes } from 'node:module';
import { copyFile, mkdir, readdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderControllerAcl } from './privateAclMirror.mts';

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
      if (/\.(?:c?ts)$/.test(entry.name)) {
        const source = await readFile(sourcePath, 'utf8');
        await writeFile(
          targetPath.replace(/\.(?:c?ts)$/, '.js'),
          stripTypeScriptTypes(source).replaceAll(
            './windowsPrivateAcl.cts',
            './windowsPrivateAcl.js'
          )
        );
      } else if (['runtime.js', 'workSync.js', 'desktopControlBinding.js'].includes(entry.name)) {
        await writeFile(
          targetPath,
          (await readFile(sourcePath, 'utf8')).replaceAll(
            './controlApiAuth.cts',
            './controlApiAuth.js'
          )
        );
      } else {
        await copyFile(sourcePath, targetPath);
      }
    }
  }
}

const policySource = await readFile(
  path.join(packageRoot, '../src/features/local-http-auth/main/infrastructure/privateFileAcl.ts'),
  'utf8'
);
if (
  (await readFile(path.join(srcDir, 'internal/windowsPrivateAcl.cts'), 'utf8')) !==
  renderControllerAcl(policySource)
) {
  throw new Error('Controller ACL adapter differs from the authoritative private-file policy');
}

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await copyRecursive(srcDir, distDir);
