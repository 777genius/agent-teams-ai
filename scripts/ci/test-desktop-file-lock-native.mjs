#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const REQUIRED_TEST_GROUPS = [
  { label: 'acquire/contend/release contract', pattern: /acquir|contend|release/i },
  { label: 'child-process/process-death contract', pattern: /child|process|sigkill/i },
  {
    label: 'platform name/alias lock contract',
    pattern: /alias|symlink|case|unicode|name[ -]?lock/i,
  },
  {
    label: 'root-substitution contract',
    pattern: /(root|scope|target-parent).{0,24}substitut/i,
  },
];
const FUNDAMENTAL_NAME_TEST = /acquire, contend, publish release/i;

function runNativeTests() {
  return new Promise((resolve, reject) => {
    let output = '';
    const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    const child = spawn(command, ['--filter', '@agent-teams/desktop-file-lock-native', 'test'], {
      env: {
        ...process.env,
        DESKTOP_FILE_LOCK_REQUIRE_FUNDAMENTAL_NAME_TEST: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        const text = chunk.toString();
        output += text;
        process.stdout.write(text);
      });
    }

    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`native file-lock tests failed with ${signal ?? `exit code ${code}`}`));
        return;
      }
      resolve(output);
    });
  });
}

function runPlatformNameResolutionTest() {
  const native = require('@agent-teams/desktop-file-lock-native');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-file-lock-name-test-'));
  const canonicalName = 'CaseAliasTarget';
  const alternateName = canonicalName.toLowerCase();
  let scope;
  let canonicalLease;
  let alternateLease;

  try {
    fs.writeFileSync(path.join(root, canonicalName), 'canonical');
    const aliasesCanonicalName = fs.existsSync(path.join(root, alternateName));
    if (!aliasesCanonicalName) fs.writeFileSync(path.join(root, alternateName), 'distinct');

    scope = native.captureScope(root);
    const canonical = native.tryAcquire(scope, canonicalName, 'native-ci-name-test');
    if (canonical.status !== 'acquired') {
      throw new Error(`Unable to acquire canonical platform name: ${canonical.status}`);
    }
    canonicalLease = canonical.leaseId;

    const alternate = native.tryAcquire(scope, alternateName, 'native-ci-name-test');
    if (aliasesCanonicalName) {
      if (alternate.status !== 'contended') {
        throw new Error(`OS name alias bypassed the canonical lock: ${alternate.status}`);
      }
    } else {
      if (alternate.status !== 'acquired') {
        throw new Error(
          `Distinct case-sensitive OS name shared the wrong lock: ${alternate.status}`
        );
      }
      alternateLease = alternate.leaseId;
    }

    console.log(
      `[desktop-file-lock-native] platform name-alias resolution passed (${aliasesCanonicalName ? 'alias' : 'distinct'})`
    );
  } finally {
    if (alternateLease !== undefined) native.abandon(alternateLease);
    if (canonicalLease !== undefined) native.abandon(canonicalLease);
    if (scope !== undefined) native.closeScope(scope);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const output = await runNativeTests();
runPlatformNameResolutionTest();
for (const group of REQUIRED_TEST_GROUPS) {
  if (!group.pattern.test(output)) {
    throw new Error(`Native file-lock test output did not prove ${group.label}`);
  }
}

const skippedFundamentalTest = output
  .split(/\r?\n/)
  .find((line) => /\bskip(?:ped)?\b/i.test(line) && FUNDAMENTAL_NAME_TEST.test(line));
if (skippedFundamentalTest) {
  throw new Error(`Fundamental name-lock test was skipped: ${skippedFundamentalTest.trim()}`);
}

console.log('[desktop-file-lock-native] required contract groups passed without name-lock skips');
