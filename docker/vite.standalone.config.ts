/**
 * Vite build config for the standalone (non-Electron) server.
 *
 * Produces the standalone server at dist-standalone/index.cjs and the
 * internal-storage worker beside its shared chunk under dist-standalone/assets.
 */

import { resolve } from 'path'
import { defineConfig } from 'vite'

import type { Plugin } from 'vite'

// This config lives in docker/ but is invoked from the repo root via
// `vite build --config docker/vite.standalone.config.ts`, so __dirname
// is docker/. All paths must resolve relative to the repo root.
const ROOT = resolve(__dirname, '..')
const sourceMapsEnabled = process.env.AGENT_TEAMS_DISABLE_SOURCEMAPS !== '1'

// Node.js built-in modules that should be externalized
const nodeBuiltins = new Set([
  'fs', 'path', 'os', 'events', 'stream', 'util', 'net', 'tls',
  'http', 'https', 'crypto', 'zlib', 'url', 'querystring',
  'child_process', 'buffer', 'dns', 'dgram', 'assert', 'constants',
  'readline', 'string_decoder', 'timers', 'tty', 'worker_threads'
])

// Packages that must be externalized because they break when bundled
// (fastify ecosystem uses internal file resolution that doesn't survive bundling)
const externalPackages = [
  'fastify', '@fastify/cors', '@fastify/static',
  'agent-teams-controller', 'better-sqlite3'
]

// Stub native .node addons (ssh2/cpu-features have JS fallbacks)
function nativeModuleStub(): Plugin {
  const STUB_ID = '\0native-stub'
  return {
    name: 'native-module-stub',
    enforce: 'pre',
    resolveId(source) {
      if (source.endsWith('.node')) return STUB_ID
      return null
    },
    load(id) {
      if (id.endsWith('.node')) return 'export default {}'
      if (id === STUB_ID) return 'export default {}'
      return null
    }
  }
}

// Stub out Electron imports with empty modules
const electronModules = new Set(['electron', 'electron-updater'])

function electronStub(): Plugin {
  const ELECTRON_STUB_ID = '\0electron-stub'
  // Comprehensive stub covering all electron exports used in the codebase
  const electronStubCode = `
const noop = () => {};
const noopClass = class {};
const handler = { get: () => noop };
const proxyObj = new Proxy({}, handler);
export const app = proxyObj;
export const BrowserWindow = noopClass;
export const ipcMain = { handle: noop, on: noop, removeHandler: noop };
export const shell = { openPath: noop, openExternal: noop };
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
export const Notification = class { show() {} };
export const nativeImage = { createFromPath: () => proxyObj, createEmpty: () => proxyObj };
export const net = { fetch: globalThis.fetch };
export const safeStorage = { isEncryptionAvailable: () => false, encryptString: noop, decryptString: () => '' };
export const screen = proxyObj;
export default proxyObj;
`
  return {
    name: 'electron-stub',
    // Use enforce: 'pre' to intercept before Vite's SSR externalization
    enforce: 'pre',
    resolveId(source) {
      if (electronModules.has(source)) return ELECTRON_STUB_ID
      return null
    },
    load(id) {
      if (id === ELECTRON_STUB_ID) return electronStubCode
      return null
    }
  }
}

export default defineConfig({
  root: ROOT,
  plugins: [nativeModuleStub(), electronStub()],
  resolve: {
    alias: {
      '@features': resolve(ROOT, 'src/features'),
      '@main': resolve(ROOT, 'src/main'),
      '@shared': resolve(ROOT, 'src/shared'),
      '@preload': resolve(ROOT, 'src/preload')
    }
  },
  ssr: {
    // Force Vite to bundle these instead of externalizing them
    // (SSR mode externalizes all node_modules by default)
    noExternal: true
  },
  build: {
    outDir: 'dist-standalone',
    target: 'node24',
    ssr: true,
    rollupOptions: {
      input: {
        index: resolve(ROOT, 'src/main/standalone.ts'),
        'internal-storage-worker': resolve(
          ROOT,
          'src/features/internal-storage/main/infrastructure/worker/internalStorageWorkerEntry.ts'
        )
      },
      output: {
        format: 'cjs',
        entryFileNames: (chunk) =>
          chunk.name === 'internal-storage-worker' ? 'assets/[name].cjs' : '[name].cjs'
      },
      external: (id) => {
        // Externalize Node.js built-ins
        if (id.startsWith('node:')) return true
        if (nodeBuiltins.has(id)) return true
        // Externalize packages that break when bundled
        if (externalPackages.some(pkg => id === pkg || id.startsWith(pkg + '/'))) return true
        return false
      }
    },
    minify: false,
    sourcemap: sourceMapsEnabled
  }
})
