#!/usr/bin/env node
/* global __dirname, console, process, require */

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const pkg = require(path.join(repoRoot, 'package.json'));

const REQUIRED_ENV = ['SENTRY_DSN', 'SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT'];
const OUTPUT_DIRS = ['dist-electron/main', 'out/renderer'];
const MAIN_OUTPUT_DIR = 'dist-electron/main';
const PRELOAD_OUTPUT_DIR = 'dist-electron/preload';
const RENDERER_OUTPUT_DIR = 'out/renderer';
const RENDERER_INDEX_HTML = path.join(RENDERER_OUTPUT_DIR, 'index.html');
const SENTRY_DEBUG_ID_RE = /\/\/# debugId=[a-fA-F0-9-]+/;

function fail(message) {
  console.error(`[sentry-release] ${message}`);
  process.exit(1);
}

function firstNonEmptyEnv(...names) {
  return names.map((name) => String(process.env[name] ?? '').trim()).find(Boolean) ?? '';
}

function getReleaseTag() {
  const explicitTag = firstNonEmptyEnv('RELEASE_TAG');
  if (explicitTag) return explicitTag;

  const ref = String(process.env.GITHUB_REF ?? '');
  return ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : '';
}

function isReleaseBuild() {
  return (
    String(process.env.IS_RELEASE_BUILD ?? '').toLowerCase() === 'true' ||
    Boolean(getReleaseTag()) ||
    process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
  );
}

function assertReleaseEnv() {
  if (!isReleaseBuild()) {
    console.log('[sentry-release] skipped: not a release build');
    return null;
  }

  const missing = REQUIRED_ENV.filter((name) => !String(process.env[name] ?? '').trim());
  if (missing.length > 0) {
    fail(`missing required env for source map upload: ${missing.join(', ')}`);
  }

  if (!String(process.env.SENTRY_DSN).startsWith('https://')) {
    fail('SENTRY_DSN must be an https DSN');
  }

  const releaseTag = getReleaseTag();
  if (!/^v[0-9]/.test(releaseTag)) {
    fail(`release tag must start with v and include a numeric version, got '${releaseTag || '<empty>'}'`);
  }

  const tagVersion = releaseTag.replace(/^v/, '');
  if (pkg.version !== tagVersion) {
    fail(`package version ${pkg.version} does not match release tag v${tagVersion}`);
  }

  return {
    dsn: String(process.env.SENTRY_DSN).trim(),
    releaseTag,
  };
}

function walkFiles(relativeDir) {
  const absoluteDir = path.join(repoRoot, relativeDir);
  if (!fs.existsSync(absoluteDir)) {
    return [];
  }

  const files = [];
  const stack = [absoluteDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

function prebuild() {
  if (!assertReleaseEnv()) return;

  console.log(
    `[sentry-release] prebuild ok: release=agent-teams-ai@${pkg.version}, project=${process.env.SENTRY_ORG}/${process.env.SENTRY_PROJECT}`
  );
}

function postbuild() {
  const env = assertReleaseEnv();
  if (!env) return;

  const jsFilesByOutputDir = new Map();
  for (const outputDir of OUTPUT_DIRS) {
    const jsFiles = walkFiles(outputDir).filter((file) => /\.(?:js|cjs|mjs)$/.test(file));
    if (jsFiles.length === 0) {
      fail(`no built JavaScript files found in ${outputDir}`);
    }
    jsFilesByOutputDir.set(outputDir, jsFiles);
  }

  const jsFiles = [...jsFilesByOutputDir.values()].flat();
  if (jsFiles.length === 0) {
    fail(`no built JavaScript files found in ${OUTPUT_DIRS.join(', ')}`);
  }

  const missingDebugIdDirs = [];
  for (const [outputDir, files] of jsFilesByOutputDir.entries()) {
    const hasDebugId = files.some((file) => SENTRY_DEBUG_ID_RE.test(fs.readFileSync(file, 'utf8')));
    if (!hasDebugId) {
      missingDebugIdDirs.push(outputDir);
    }
  }

  if (missingDebugIdDirs.length > 0) {
    console.warn(
      [
        '[sentry-release] warning: Sentry debug ID comments were not found in built JavaScript artifacts',
        ...missingDebugIdDirs.map((dir) => ` - ${dir}`),
      ].join('\n')
    );
  }

  const mainBundleText = walkFiles(MAIN_OUTPUT_DIR)
    .filter((file) => /\.(?:js|cjs|mjs)$/.test(file))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  if (!mainBundleText.includes(env.dsn)) {
    fail('SENTRY_DSN was not baked into the main process bundle');
  }
  if (!/SENTRY_ENVIRONMENT\s*=\s*["']production["']/.test(mainBundleText)) {
    fail('production Sentry environment was not baked into the main process bundle');
  }

  const rendererBundleText = walkFiles(RENDERER_OUTPUT_DIR)
    .filter((file) => /\.(?:js|cjs|mjs)$/.test(file))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  if (!rendererBundleText.includes(env.dsn)) {
    fail('SENTRY_DSN was not baked into the renderer bundle');
  }

  const preloadBundleText = walkFiles(PRELOAD_OUTPUT_DIR)
    .filter((file) => /\.(?:js|cjs|mjs)$/.test(file))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  if (!preloadBundleText.includes('__SENTRY_IPC__') || !preloadBundleText.includes('sentry-ipc')) {
    fail('Sentry Electron IPC preload bridge was not baked into the preload bundle');
  }

  const rendererIndexHtmlPath = path.join(repoRoot, RENDERER_INDEX_HTML);
  if (!fs.existsSync(rendererIndexHtmlPath)) {
    fail(`renderer index.html was not found at ${RENDERER_INDEX_HTML}`);
  }
  const rendererIndexHtml = fs.readFileSync(rendererIndexHtmlPath, 'utf8');
  if (!rendererIndexHtml.includes('sentry-ipc:')) {
    fail('renderer CSP is missing sentry-ipc: connect-src');
  }

  const mapFiles = OUTPUT_DIRS.flatMap(walkFiles).filter((file) => file.endsWith('.map'));
  if (mapFiles.length > 0) {
    fail(
      [
        'source maps still exist after build; expected Sentry upload to delete them',
        ...mapFiles.slice(0, 20).map((file) => ` - ${path.relative(repoRoot, file)}`),
      ].join('\n')
    );
  }

  console.log(
    `[sentry-release] postbuild ok: ${jsFiles.length} JS artifacts include Sentry release config and source maps were removed after upload`
  );
}

const command = process.argv[2] ?? 'prebuild';
if (command === 'prebuild') {
  prebuild();
} else if (command === 'postbuild') {
  postbuild();
} else {
  fail(`unknown command: ${command}`);
}
