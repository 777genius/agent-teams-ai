import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';

import { build, type Plugin, type Rollup } from 'vite';

/** Independent single-file artifact: no MCP build or application-main startup dependency. */
export async function buildPublicationHelper(
  root: string,
  directory = path.join(root, 'dist-local-http-auth'),
): Promise<string[]> {
  const buildId = randomUUID();
  const result = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    define: { PUBLICATION_HELPER_BUILD_ID: JSON.stringify(buildId) },
    build: {
      outDir: directory,
      emptyOutDir: true,
      target: 'node24',
      minify: false,
      sourcemap: false,
      ssr: true,
      rollupOptions: {
        input: path.join(
          root,
          'src/features/local-http-auth/main/infrastructure/publicationHelperEntry.ts',
        ),
        external: (id) => id.startsWith('node:') || builtinModules.includes(id),
        output: {
          format: 'cjs',
          entryFileNames: 'publication-helper.cjs',
          inlineDynamicImports: true,
        },
      },
    },
  });
  const outputs = (
    Array.isArray(result) ? result : [result]
  ) as Rollup.RollupOutput[];
  const modules = new Set<string>();
  for (const output of outputs)
    for (const chunk of output.output) {
      if (chunk.type === 'chunk')
        for (const id of Object.keys(chunk.modules)) modules.add(id);
    }
  const bytes = await readFile(path.join(directory, 'publication-helper.cjs'));
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      buildId,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }) + '\n',
  );
  return [...modules];
}
export function publicationHelperBuildPlugin(root: string): Plugin {
  return {
    name: 'isolated-local-http-auth-publication-helper',
    async buildStart() {
      for (const file of await buildPublicationHelper(root))
        this.addWatchFile(file);
    },
  };
}
