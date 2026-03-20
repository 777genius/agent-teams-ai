import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  // Bundle all dependencies into a single self-contained file so the packaged
  // Electron app can run the MCP server without a node_modules tree.
  noExternal: [/.*/],
  splitting: false,
  // Provide a real `require` function for CJS dependencies (e.g. undici)
  // that use require() for Node built-in modules.
  banner: {
    js: `import { createRequire as __bundled_createRequire } from 'module';\nconst require = __bundled_createRequire(import.meta.url);`,
  },
  esbuildOptions(options) {
    // Optional peer deps of xsschema (pulled in by fastmcp) — we only use zod.
    // Mark as external at the esbuild level to avoid resolution errors.
    options.external = [
      ...(options.external ?? []),
      'sury',
      '@valibot/to-json-schema',
      'effect',
    ];
  },
});
