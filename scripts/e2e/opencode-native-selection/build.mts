import path from 'node:path';

import { build } from 'vite';

// CI-only bundling runs the same production helper graph under Node and standalone Bun.
await build({
  configFile: false,
  resolve: {
    alias: {
      '@main': path.resolve('src/main'),
      '@shared': path.resolve('src/shared'),
      '@features': path.resolve('src/features'),
    },
  },
  plugins: [
    {
      name: 'selection-production-graph',
      generateBundle(_options, output) {
        this.emitFile({
          type: 'asset',
          fileName: 'production-graph.json',
          source: JSON.stringify(
            Object.values(output).flatMap((item) =>
              item.type === 'chunk' ? Object.keys(item.modules) : []
            ),
            null,
            2
          ),
        });
      },
    },
  ],
  build: {
    ssr: true,
    outDir: 'selection-dist',
    minify: false,
    target: 'node24',
    rollupOptions: {
      input: {
        run: 'scripts/e2e/opencode-native-selection/run.mts',
        worker: 'scripts/e2e/opencode-native-selection/worker.mts',
      },
      output: { format: 'cjs', entryFileNames: '[name].cjs', chunkFileNames: '[name].cjs' },
    },
  },
});
