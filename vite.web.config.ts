import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const ROOT = __dirname;
const standalonePort = process.env.VITE_STANDALONE_PORT?.trim() || '3456';
const webPort = Number.parseInt(process.env.VITE_WEB_PORT?.trim() || '5174', 10);
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')) as { version: string };

export default defineConfig({
  root: resolve(ROOT, 'src/renderer'),
  cacheDir: resolve(ROOT, 'node_modules/.vite/web-renderer'),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: webPort,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${standalonePort}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    emptyOutDir: true,
    outDir: resolve(ROOT, 'out/renderer'),
    target: 'esnext',
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
    include: ['@codemirror/language-data'],
    exclude: ['@claude-teams/agent-graph'],
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    'import.meta.env.VITE_SENTRY_DSN': JSON.stringify(process.env.SENTRY_DSN ?? ''),
  },
  resolve: {
    alias: {
      '@features': resolve(ROOT, 'src/features'),
      '@renderer': resolve(ROOT, 'src/renderer'),
      '@shared': resolve(ROOT, 'src/shared'),
      '@main': resolve(ROOT, 'src/main'),
      '@claude-teams/agent-graph': resolve(ROOT, 'packages/agent-graph/src/index.ts'),
    },
  },
});
