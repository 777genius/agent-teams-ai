#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const pkg = require(path.join(repoRoot, 'package.json'));

const REQUIRED_ENV = ['SENTRY_DSN', 'SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT'];
const OUTPUT_DIRS = ['dist-electron/main', 'out/renderer'];
const SENTRY_DEBUG_ID_RE = /\/\/# debugId=[a-fA-F0-9-]+/;

function fail(message) {
  console.error(`[sentry-release] ${message}`);
  process.exit(1);
}

function isTaggedRelease() {
  return /^refs\/tags\/v/.test(process.env.GITHUB_REF ?? '');
}

function assertTaggedReleaseEnv() {
  if (!isTaggedRelease()) {
    console.log('[sentry-release] skipped: not a tag release');
    return false;
  }

  const missing = REQUIRED_ENV.filter((name) => !String(process.env[name] ?? '').trim());
  if (missing.length > 0) {
    fail(`missing required env for source map upload: ${missing.join(', ')}`);
  }

  if (!String(process.env.SENTRY_DSN).startsWith('https://')) {
    fail('SENTRY_DSN must be an https DSN');
  }

  const tagVersion = String(process.env.GITHUB_REF).replace(/^refs\/tags\/v/, '');
  if (pkg.version !== tagVersion) {
    fail(`package version ${pkg.version} does not match release tag v${tagVersion}`);
  }

  return true;
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
  if (!assertTaggedReleaseEnv()) return;

  console.log(
    `[sentry-release] prebuild ok: release=agent-teams-ai@${pkg.version}, project=${process.env.SENTRY_ORG}/${process.env.SENTRY_PROJECT}`
  );
}

function postbuild() {
  if (!assertTaggedReleaseEnv()) return;

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
    fail(
      [
        'Sentry debug IDs were not injected into built JavaScript artifacts',
        ...missingDebugIdDirs.map((dir) => ` - ${dir}`),
      ].join('\n')
    );
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
    `[sentry-release] postbuild ok: ${jsFiles.length} JS artifacts built, debug IDs were injected, and source maps were removed after upload`
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
