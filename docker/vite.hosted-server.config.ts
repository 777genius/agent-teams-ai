import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'vite';

const ROOT = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')) as { version: string };
const sourceMapsEnabled = process.env.AGENT_TEAMS_DISABLE_SOURCEMAPS !== '1';

export default defineConfig({
  root: ROOT,
  build: {
    emptyOutDir: true,
    minify: false,
    outDir: 'dist-hosted',
    rollupOptions: {
      input: {
        server: resolve(ROOT, 'src/hosted/server.ts'),
      },
      output: {
        entryFileNames: '[name].cjs',
        format: 'cjs',
      },
    },
    sourcemap: sourceMapsEnabled,
    ssr: true,
    target: 'node24',
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});
