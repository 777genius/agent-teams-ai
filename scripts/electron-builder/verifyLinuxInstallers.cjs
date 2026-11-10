#!/usr/bin/env node
/* global Buffer, console, module, process, require */
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync, spawn, spawnSync } = require('child_process');

const DEB_LAUNCHER_ENTRY = './usr/bin/agent-teams-ai';
const DEB_REQUIRED_ENTRIES = [
  DEB_LAUNCHER_ENTRY,
  './opt/Agent-Teams-AI/agent-teams-ai',
  './opt/Agent-Teams-AI/chrome-sandbox',
];

function fail(message) {
  console.error(`[verifyLinuxInstallers] ${message}`);
  process.exit(1);
}

function run(command, args, input) {
  const result = spawnSync(command, args, {
    input,
    encoding: input ? undefined : 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : result.stderr || '';
    throw new Error(`${command} ${args.join(' ')} failed: ${stderr}`);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '', 'utf8');
}

function readArMember(archivePath, memberName) {
  return execFileSync('ar', ['p', archivePath, memberName], {
    maxBuffer: 128 * 1024 * 1024,
  });
}

function getTarCompressionFlag(memberName) {
  if (memberName.endsWith('.tar.xz')) return 'J';
  if (memberName.endsWith('.tar.gz')) return 'z';
  if (memberName.endsWith('.tar.bz2')) return 'j';
  fail(`Unsupported deb tar member compression: ${memberName}`);
}

function getDebMember(archivePath, prefix) {
  const members = execFileSync('ar', ['t', archivePath], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
  const member = members.find((entry) => entry.startsWith(prefix));
  if (!member) {
    fail(`Missing ${prefix} member in ${archivePath}`);
  }
  return member;
}

// The data listing grows with the bundle (past 16 MiB in 2.18.0), so it is streamed line
// by line instead of buffered. A failing ar or tar still fails the scan.
function scanDebTarListing(archivePath, memberName, verbose, onLine) {
  const flag = getTarCompressionFlag(memberName);
  const mode = verbose ? `-tv${flag}f` : `-t${flag}f`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      'bash',
      [
        '-c',
        'set -euo pipefail; ar p "$1" "$2" | tar "$3" -',
        'bash',
        archivePath,
        memberName,
        mode,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', onLine);
    child.once('error', reject);
    // 'close' fires only after stdout has ended, so every line has been seen by then.
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`Listing ${memberName} in ${archivePath} failed (${signal || `exit ${code}`})`)
        );
      }
    });
  });
}

// Extracts one small file; output beyond the buffer throws ENOBUFS instead of truncating.
function extractDebTarFile(archivePath, memberName, filePath) {
  const flag = getTarCompressionFlag(memberName);
  return execFileSync(
    'bash',
    [
      '-c',
      'set -euo pipefail; ar p "$1" "$2" | tar "$3" - "$4"',
      'bash',
      archivePath,
      memberName,
      `-xO${flag}f`,
      filePath,
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  );
}

function listTar(tarBuffer, memberName, verbose = false) {
  const flag = getTarCompressionFlag(memberName);
  const mode = verbose ? `-tv${flag}f` : `-t${flag}f`;
  return run('tar', [mode, '-'], tarBuffer).toString('utf8');
}

function extractTarFile(tarBuffer, memberName, filePath) {
  const flag = getTarCompressionFlag(memberName);
  return run('tar', [`-xO${flag}f`, '-', filePath], tarBuffer).toString('utf8');
}

function assertContains(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    fail(`${label} does not contain ${needle}`);
  }
}

async function verifyDeb(debPath) {
  const dataMember = getDebMember(debPath, 'data.tar.');
  const controlMember = getDebMember(debPath, 'control.tar.');
  const control = readArMember(debPath, controlMember);

  const foundEntries = new Set();
  await scanDebTarListing(debPath, dataMember, false, (line) => {
    if (DEB_REQUIRED_ENTRIES.includes(line)) foundEntries.add(line);
  });
  for (const entry of DEB_REQUIRED_ENTRIES) {
    if (!foundEntries.has(entry)) {
      fail(`${path.basename(debPath)} does not contain ${entry}`);
    }
  }

  let launcherLine;
  await scanDebTarListing(debPath, dataMember, true, (line) => {
    if (launcherLine === undefined && line.endsWith(DEB_LAUNCHER_ENTRY)) launcherLine = line;
  });
  if (!launcherLine || !launcherLine.startsWith('-rwx')) {
    fail(`/usr/bin/agent-teams-ai is not executable in ${debPath}`);
  }

  const launcher = extractDebTarFile(debPath, dataMember, DEB_LAUNCHER_ENTRY);
  assertContains(launcher, '/opt/Agent-Teams-AI/agent-teams-ai', 'CLI launcher');
  if (launcher.includes('--no-sandbox')) {
    fail('CLI launcher must not force --no-sandbox');
  }

  const postinst = extractTarFile(control, controlMember, './postinst');
  assertContains(postinst, 'SANDBOX_PATH="/opt/Agent-Teams-AI/chrome-sandbox"', 'deb postinst');
  assertContains(postinst, 'chmod 4755 "$SANDBOX_PATH"', 'deb postinst');
}

async function main() {
  const releaseDir = path.resolve(process.argv[2] || 'release');
  if (!fs.existsSync(releaseDir)) {
    fail(`Release directory does not exist: ${releaseDir}`);
  }

  const debs = fs
    .readdirSync(releaseDir)
    .filter((entry) => entry.endsWith('.deb'))
    .map((entry) => path.join(releaseDir, entry));
  if (debs.length === 0) {
    fail(`No .deb packages found in ${releaseDir}`);
  }

  for (const deb of debs) {
    await verifyDeb(deb);
    console.log(`[verifyLinuxInstallers] OK ${path.basename(deb)}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}

module.exports = {
  _internal: {
    extractTarFile,
    getDebMember,
    listTar,
    verifyDeb,
  },
};
