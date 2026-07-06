#!/usr/bin/env node
/* global __dirname, console, process, require, URL */

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const RENDERER_OUTPUT_DIR = 'out/renderer';
const DEFAULT_POSTHOG_HOST = 'https://eu.i.posthog.com';
const REQUIRED_RENDERER_SNIPPETS = [
  'advanced_disable_flags: true',
  'advanced_disable_feature_flags: true',
  'advanced_disable_feature_flags_on_first_load: true',
  'capture_dead_clicks: false',
  'disable_external_dependency_loading: true',
  'disable_product_tours: true',
  'disable_surveys: true',
  'disable_surveys_automatic_display: true',
];

function fail(message) {
  console.error(`[posthog-release] ${message}`);
  process.exit(1);
}

function isReleaseBuild() {
  return (
    String(process.env.IS_RELEASE_BUILD ?? '').toLowerCase() === 'true' ||
    Boolean(String(process.env.RELEASE_TAG ?? '').trim()) ||
    process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
  );
}

function firstNonEmptyEnv(...names) {
  return names.map((name) => String(process.env[name] ?? '').trim()).find(Boolean) ?? '';
}

function getPostHogKey() {
  return firstNonEmptyEnv('POSTHOG_KEY', 'VITE_POSTHOG_KEY');
}

function getPostHogHost() {
  return firstNonEmptyEnv('POSTHOG_HOST', 'VITE_POSTHOG_HOST') || DEFAULT_POSTHOG_HOST;
}

function assertReleaseEnv() {
  if (!isReleaseBuild()) {
    console.log('[posthog-release] skipped: not a release build');
    return null;
  }

  const key = getPostHogKey();
  if (!key) {
    fail('missing required env: POSTHOG_KEY or VITE_POSTHOG_KEY');
  }

  const host = getPostHogHost();
  let parsedHost;
  try {
    parsedHost = new URL(host);
  } catch {
    fail('POSTHOG_HOST must be a valid URL');
  }

  if (parsedHost.protocol !== 'https:') {
    fail('POSTHOG_HOST must use https');
  }

  return { key, host };
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
  const env = assertReleaseEnv();
  if (!env) return;

  console.log(`[posthog-release] prebuild ok: host=${env.host}`);
}

function postbuild() {
  const env = assertReleaseEnv();
  if (!env) return;

  const jsFiles = walkFiles(RENDERER_OUTPUT_DIR).filter((file) => file.endsWith('.js'));
  if (jsFiles.length === 0) {
    fail(`no built renderer JavaScript files found in ${RENDERER_OUTPUT_DIR}`);
  }

  const bundleText = jsFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  if (!bundleText.includes(env.key)) {
    fail('POSTHOG_KEY was not baked into the renderer bundle');
  }

  if (!bundleText.includes(env.host)) {
    fail('POSTHOG_HOST was not baked into the renderer bundle');
  }

  const missingSnippets = REQUIRED_RENDERER_SNIPPETS.filter((snippet) => !bundleText.includes(snippet));
  if (missingSnippets.length > 0) {
    fail(
      [
        'renderer PostHog config is missing production safety options',
        ...missingSnippets.map((snippet) => ` - ${snippet}`),
      ].join('\n')
    );
  }

  console.log(
    `[posthog-release] postbuild ok: ${jsFiles.length} renderer JS artifacts include PostHog config`
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
