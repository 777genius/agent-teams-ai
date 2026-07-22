import { defineConfig } from 'electron-vite'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { loadEnv, type Plugin } from 'vite'
import {
  isOfficialPostHogReleaseBuild,
  resolvePostHogBuildKey,
} from './src/shared/utils/posthogBuildPolicy'
import { resolveSentryBuildEnvironment } from './src/shared/utils/sentryBuildPolicy'

// Read all production dependencies from package.json
// so they get bundled into the main process output.
// This avoids pnpm symlink issues with electron-builder's asar packaging.
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))
const prodDeps = Object.keys(pkg.dependencies || {})
const terminalPlatformLocalRoot = resolveTerminalPlatformLocalRoot()
const terminalPlatformSdkAliases = createTerminalPlatformSdkAliases()
const rendererDependencyEsbuildTarget = 'esnext'
const localEnv = loadEnv(process.env.NODE_ENV ?? 'development', __dirname, '')
const buildGitSha = resolveBuildGitSha()
const buildId = resolveBuildId(buildGitSha)
const sentryEnvironment = resolveSentryBuildEnvironment(process.env)
const releaseChannel = resolveReleaseChannel()
const officialPostHogBuild = isOfficialPostHogReleaseBuild(process.env)
const posthogKey = resolvePostHogBuildKey(process.env, localEnv)
const posthogHost =
  process.env.POSTHOG_HOST ??
  localEnv.POSTHOG_HOST ??
  process.env.VITE_POSTHOG_HOST ??
  localEnv.VITE_POSTHOG_HOST ??
  'https://eu.i.posthog.com'

// Fastify and its plugins rely on runtime module resolution that breaks when bundled.
const runtimeExternalDeps = new Set([
  'node-pty',
  'better-sqlite3',
  'agent-teams-controller',
  'terminal-platform-node',
  'ws',
  'fastify',
  '@fastify/cors',
  '@fastify/static',
])

// node-pty is a native addon that cannot be bundled by Rollup.
// It must remain external and be loaded at runtime via require().
const bundledDeps = prodDeps.filter(d => !runtimeExternalDeps.has(d))

function firstNonEmptyEnv(...values: Array<string | undefined>): string {
  return values.map(value => value?.trim() ?? '').find(Boolean) ?? ''
}

function resolveBuildGitSha(): string {
  const fromEnv = firstNonEmptyEnv(
    process.env.GIT_SHA,
    localEnv.GIT_SHA,
    process.env.GITHUB_SHA,
    localEnv.GITHUB_SHA,
    process.env.VERCEL_GIT_COMMIT_SHA,
    localEnv.VERCEL_GIT_COMMIT_SHA,
    process.env.COMMIT_SHA,
    localEnv.COMMIT_SHA
  )
  if (fromEnv) return fromEnv

  try {
    return execSync('git rev-parse HEAD', {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

function resolveBuildId(gitSha: string): string {
  return (
    firstNonEmptyEnv(
      process.env.BUILD_ID,
      localEnv.BUILD_ID,
      process.env.VITE_BUILD_ID,
      localEnv.VITE_BUILD_ID
    ) || gitSha.slice(0, 12)
  )
}

function resolveReleaseChannel(): string {
  return (
    firstNonEmptyEnv(
      process.env.RELEASE_CHANNEL,
      localEnv.RELEASE_CHANNEL,
      process.env.AGENT_TEAMS_RELEASE_CHANNEL,
      localEnv.AGENT_TEAMS_RELEASE_CHANNEL,
      process.env.VITE_RELEASE_CHANNEL,
      localEnv.VITE_RELEASE_CHANNEL
    ) || sentryEnvironment
  )
}

// Rollup plugin: stub out native .node addon imports with empty modules.
// ssh2 and cpu-features use optional native bindings that can't be bundled,
// but they have pure JS fallbacks when the native module isn't available.
function nativeModuleStub(): Plugin {
  const STUB_ID = '\0native-stub'
  const NODE_MODULE_RE = /\.node(?:\?.*)?$/
  return {
    name: 'native-module-stub',
    enforce: 'pre',
    resolveId(source) {
      if (NODE_MODULE_RE.test(source)) return `${STUB_ID}:${source}`
      return null
    },
    load(id) {
      if (id.startsWith(STUB_ID) || NODE_MODULE_RE.test(id)) return 'export default {}'
      return null
    }
  }
}

const sentrySourceMapTargets = {
  main: {
    assets: ['./dist-electron/main/**/*.{js,cjs,mjs,map}'],
    filesToDeleteAfterUpload: ['./dist-electron/main/**/*.map'],
  },
  renderer: {
    assets: ['./out/renderer/**/*.{js,cjs,mjs,map}'],
    filesToDeleteAfterUpload: ['./out/renderer/**/*.map'],
  },
} as const

const sourceMapSetting = process.env.AGENT_TEAMS_DISABLE_SOURCEMAPS === '1' ? false : 'hidden'

// Sentry source map upload - only active in CI when SENTRY_AUTH_TOKEN is set.
function createSentryPlugins(target: keyof typeof sentrySourceMapTargets): Plugin[] {
  if (!process.env.SENTRY_AUTH_TOKEN) return []

  return [
    sentryVitePlugin({
      org: process.env.SENTRY_ORG ?? 'quant-jump-pro',
      project: process.env.SENTRY_PROJECT ?? 'electron',
      authToken: process.env.SENTRY_AUTH_TOKEN,
      telemetry: false,
      release: { name: `agent-teams-ai@${pkg.version}` },
      sourcemaps: sentrySourceMapTargets[target],
    }) as Plugin,
  ]
}

function resolveTerminalPlatformLocalRoot(): string | null {
  const value =
    process.env.CLAUDE_TERMINAL_PLATFORM_ROOT?.trim() || process.env.TERMINAL_PLATFORM_ROOT?.trim()
  return value ? resolve(__dirname, value) : null
}

function createTerminalPlatformSdkAliases(): Record<string, string> {
  if (!terminalPlatformLocalRoot) return {}

  const sdkPackage = (name: string) =>
    resolve(terminalPlatformLocalRoot, 'sdk', 'packages', name, 'dist', 'index.js')

  return {
    '@terminal-platform/design-tokens': sdkPackage('design-tokens'),
    '@terminal-platform/foundation': sdkPackage('foundation'),
    '@terminal-platform/runtime-types': sdkPackage('runtime-types'),
    '@terminal-platform/workspace-adapter-websocket': sdkPackage('workspace-adapter-websocket'),
    '@terminal-platform/workspace-contracts': sdkPackage('workspace-contracts'),
    '@terminal-platform/workspace-core': sdkPackage('workspace-core'),
    '@terminal-platform/workspace-elements': sdkPackage('workspace-elements'),
    '@terminal-platform/workspace-gateway-node': sdkPackage('workspace-gateway-node'),
    '@terminal-platform/workspace-react': sdkPackage('workspace-react'),
  }
}

export default defineConfig({
  main: {
    plugins: [
      nativeModuleStub(),
      ...createSentryPlugins('main'),
    ],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __BUILD_GIT_SHA__: JSON.stringify(buildGitSha),
      __BUILD_ID__: JSON.stringify(buildId),
      __RELEASE_CHANNEL__: JSON.stringify(releaseChannel),
      __SENTRY_ENVIRONMENT__: JSON.stringify(sentryEnvironment),
      // Inject DSN at compile time - process.env.SENTRY_DSN is NOT available
      // at runtime in packaged Electron apps (only during CI build).
      'process.env.SENTRY_DSN': JSON.stringify(process.env.SENTRY_DSN ?? ''),
    },
    resolve: {
      alias: {
        '@features': resolve(__dirname, 'src/features'),
        '@main': resolve(__dirname, 'src/main'),
        '@shared': resolve(__dirname, 'src/shared'),
        '@preload': resolve(__dirname, 'src/preload'),
        ...terminalPlatformSdkAliases
      }
    },
    build: {
      externalizeDeps: {
        exclude: bundledDeps
      },
      commonjsOptions: {
        strictRequires: [/node_modules\/.*ssh2\//],
      },
      sourcemap: sourceMapSetting,
      outDir: 'dist-electron/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'team-fs-worker': resolve(__dirname, 'src/main/workers/team-fs-worker.ts'),
          'task-change-worker': resolve(__dirname, 'src/main/workers/task-change-worker.ts'),
          'team-data-worker': resolve(__dirname, 'src/main/workers/team-data-worker.ts'),
          'internal-storage-worker': resolve(
            __dirname,
            'src/features/internal-storage/main/infrastructure/worker/internalStorageWorkerEntry.ts'
          )
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
    resolve: {
      alias: {
        '@features': resolve(__dirname, 'src/features'),
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
    cacheDir: resolve(__dirname, 'node_modules/.vite/electron-renderer'),
    optimizeDeps: {
      // Electron owns the renderer runtime, so dependency prebundling can keep modern syntax.
      // This avoids esbuild trying to downlevel large ESM deps like Radix/CodeMirror/xterm.
      esbuildOptions: {
        target: rendererDependencyEsbuildTarget,
      },
      include: ['@codemirror/language-data'],
      exclude: [
        '@claude-teams/agent-graph',
        '@terminal-platform/design-tokens',
        '@terminal-platform/foundation',
        '@terminal-platform/runtime-types',
        '@terminal-platform/workspace-adapter-websocket',
        '@terminal-platform/workspace-contracts',
        '@terminal-platform/workspace-core',
        '@terminal-platform/workspace-elements',
        '@terminal-platform/workspace-gateway-node',
        '@terminal-platform/workspace-react',
      ]
    },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __BUILD_GIT_SHA__: JSON.stringify(buildGitSha),
      __BUILD_ID__: JSON.stringify(buildId),
      __RELEASE_CHANNEL__: JSON.stringify(releaseChannel),
      __SENTRY_ENVIRONMENT__: JSON.stringify(sentryEnvironment),
      __OFFICIAL_POSTHOG_BUILD__: JSON.stringify(officialPostHogBuild),
      // Pass SENTRY_DSN to renderer as VITE_SENTRY_DSN (Vite replaces at compile time)
      'import.meta.env.VITE_SENTRY_DSN': JSON.stringify(process.env.SENTRY_DSN ?? ''),
      // PostHog project API keys are public browser SDK keys. Prefer POSTHOG_* in CI.
      'import.meta.env.VITE_POSTHOG_KEY': JSON.stringify(posthogKey),
      'import.meta.env.VITE_POSTHOG_HOST': JSON.stringify(posthogHost),
    },
    resolve: {
      alias: {
        '@features': resolve(__dirname, 'src/features'),
        '@renderer': resolve(__dirname, 'src/renderer'),
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main'),
        '@radix-ui/react-compose-refs': resolve(
          __dirname,
          'src/renderer/vendor/radixComposeRefs.ts'
        ),
        ...terminalPlatformSdkAliases,
        '@claude-teams/agent-graph': resolve(__dirname, 'packages/agent-graph/src/index.ts')
      }
    },
    plugins: [react(), ...createSentryPlugins('renderer')],
    build: {
      sourcemap: sourceMapSetting,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
