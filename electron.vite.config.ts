import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import type { Plugin } from 'vite'

// Read all production dependencies from package.json
// so they get bundled into the main process output.
// This avoids pnpm symlink issues with electron-builder's asar packaging.
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))
const prodDeps = Object.keys(pkg.dependencies || {})

// node-pty is a native addon that cannot be bundled by Rollup.
// It must remain external and be loaded at runtime via require().
const bundledDeps = prodDeps.filter(d => d !== 'node-pty')

// Rollup plugin: stub out native .node addon imports with empty modules.
// ssh2 and cpu-features use optional native bindings that can't be bundled,
// but they have pure JS fallbacks when the native module isn't available.
function nativeModuleStub(): Plugin {
  const STUB_ID = '\0native-stub'
  return {
    name: 'native-module-stub',
    resolveId(source) {
      if (source.endsWith('.node')) return STUB_ID
      return null
    },
    load(id) {
      if (id === STUB_ID) return 'export default {}'
      return null
    }
  }
}

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: bundledDeps
      }),
      nativeModuleStub()
    ],
    resolve: {
      alias: {
        '@main': resolve(__dirname, 'src/main'),
        '@shared': resolve(__dirname, 'src/shared'),
        '@preload': resolve(__dirname, 'src/preload')
      }
    },
    build: {
      outDir: 'dist-electron/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        },
        output: {
          // CJS format so bundled deps can use __dirname/require.
          // Use .cjs extension since package.json has "type": "module".
          format: 'cjs',
          entryFileNames: '[name].cjs',
          // Set UV_THREADPOOL_SIZE before any module code runs.
          // Must be in the banner because ESM→CJS hoists imports above top-level code.
          // On Windows, fs.watch({recursive:true}) occupies a UV pool thread per watcher;
          // with 3+ watchers + concurrent fs/DNS/spawn, the default 4 threads deadlock.
          banner: `if(!process.env.UV_THREADPOOL_SIZE){process.env.UV_THREADPOOL_SIZE='24'}`
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@preload': resolve(__dirname, 'src/preload'),
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main')
      }
    },
    build: {
      outDir: 'dist-electron/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },
  renderer: {
    optimizeDeps: {
      include: ['@codemirror/language-data']
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer'),
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
